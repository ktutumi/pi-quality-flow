/**
 * 契約試験: 中断・待機 continuation・session 切替（Pi 0.85.1 + mock provider）。
 *
 * - 正常 stop 以外（aborted / length）は対象外で原文を維持する
 * - queued continuation が観測できる場合は置換を開始しない
 * - session 切替（runtime newSession）で session_start reason が届き、
 *   旧 session の candidate epoch が無効化されることを観測する
 *
 * 対象: docs/pi-quality-flow-design-v0.2.md 第6.4・11・33章、Issue #2。
 * Phase 0A の置換は message_end 内で完了するため、遅延結果の適用競合は
 * 非同期化する Phase 0B 以降（Issue #7）で検証する。この限界は適合記録に残す。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type InlineExtension,
  type ModelRuntime as ModelRuntimeType,
} from "@earendil-works/pi-coding-agent";
import { createQualityFlowExtension } from "../../src/extension.ts";
import { isEligibleTerminalCandidate, sha256Utf8, MAX_SOURCE_BYTES } from "../../src/pi/adapter.ts";
import { createHarness, APPROVED_FORMATTER_CONFIG } from "../helpers/harness.ts";
import { createRuntimeSessionFactory } from "../helpers/runtime-session.ts";
import { GATE_BIN } from "../helpers/gate-bin.ts";
import {
  createMockProviderExtension,
  MOCK_PROVIDER,
  MOCK_MODEL_ID,
  type MockResponse,
  type MockScript,
} from "../helpers/mock-provider.ts";

const ORIGINAL = "この実装方案では、APIの返却値を直接利用します。";
const ADOPTED = "この実装方針では、APIの返却値を直接利用します。";

function assistantFixture(overrides: Partial<Record<string, unknown>> = {}): Parameters<typeof isEligibleTerminalCandidate>[0] {
  return {
    role: "assistant",
    content: [{ type: "text", text: "テキスト" }],
    api: "pi-qf-mock-api",
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

test("対象判定: 正常 stop のみ対象（length / aborted / toolCall / 空 / 複数 block / 上限超過は対象外）", () => {
  assert.equal(isEligibleTerminalCandidate(assistantFixture()).ok, true);

  assert.equal(
    isEligibleTerminalCandidate(assistantFixture({ stopReason: "length" })).ok,
    false,
  );
  assert.equal(
    isEligibleTerminalCandidate(assistantFixture({ stopReason: "aborted" })).ok,
    false,
  );
  assert.equal(
    isEligibleTerminalCandidate(assistantFixture({ stopReason: "error" })).ok,
    false,
  );
  assert.equal(
    isEligibleTerminalCandidate(
      assistantFixture({
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
      }),
    ).ok,
    false,
  );
  assert.equal(
    isEligibleTerminalCandidate(assistantFixture({ content: [] })).ok,
    false,
    "空 text",
  );
  assert.equal(
    isEligibleTerminalCandidate(
      assistantFixture({
        content: [
          { type: "text", text: "一つ目" },
          { type: "text", text: "二つ目" },
        ],
      }),
    ).ok,
    false,
    "複数非空 text block",
  );

  const tooLarge = isEligibleTerminalCandidate(
    assistantFixture({ content: [{ type: "text", text: "a".repeat(MAX_SOURCE_BYTES + 1) }] }),
  );
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.equal(tooLarge.code, "source-too-large");

  // UTF-8 ちょうど 8192 bytes の ASCII。境界値は byte 単位で固定する。
  const atLimit = isEligibleTerminalCandidate(
    assistantFixture({ content: [{ type: "text", text: "a".repeat(MAX_SOURCE_BYTES) }] }),
  );
  assert.equal(atLimit.ok, true, "8192 bytes ちょうどは対象");
});

test("中断: streaming 中の abort では置換せず原文を維持する", async () => {
  let aborted = false;
  const harness = await createHarness({
    responses: [
      { text: ORIGINAL, chunkCount: 12, chunkDelayMs: 40 },
      { text: "（使われない）" },
    ],
    finalize: () => ADOPTED,
    onEvent: (event) => {
      if (aborted) return;
      const e = event as { assistantMessageEvent?: { type?: string } };
      if (e.assistantMessageEvent?.type === "text_delta") {
        aborted = true;
        void harness.session.abort();
      }
    },
  });

  try {
    await harness.session.prompt("長い説明をしてください");

    const assistantMessages = collectAssistantMessages(harness);
    assert.ok(assistantMessages.length >= 1);
    const last = assistantMessages[assistantMessages.length - 1];
    assert.equal(last.stopReason, "aborted", "中断は aborted として記録される");
    assert.ok(
      last.text.startsWith("この実装方案") && !last.text.includes("方針"),
      `暫定の部分本文のまま（採用本文に置換されない）: ${last.text}`,
    );

    assert.equal(harness.candidateEntries().length, 0, "中断応答は candidate として記録しない");
    assert.equal(harness.turnMappingEntries().length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("length 終了: 部分出力は採用しない", async () => {
  const harness = await createHarness({
    responses: [{ text: ORIGINAL, stopReason: "length", chunkCount: 2, chunkDelayMs: 5 }],
    finalize: () => ADOPTED,
  });
  try {
    await harness.session.prompt("出力してください");
    const assistantMessages = collectAssistantMessages(harness);
    const last = assistantMessages[assistantMessages.length - 1];
    assert.equal(last.stopReason, "length");
    assert.equal(last.text, ORIGINAL, "length は原文維持");
    assert.equal(harness.candidateEntries().length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("queued continuation: 待機中は置換せず、空いた後の応答は置換する", async () => {
  let steered = false;
  const harness = await createHarness({
    responses: [
      { text: ORIGINAL, chunkCount: 10, chunkDelayMs: 40 },
      { text: "二回目の回答です。", chunkCount: 4, chunkDelayMs: 20 },
    ],
    finalize: ({ originalText }) => {
      if (originalText === ORIGINAL) return ADOPTED;
      if (originalText === "二回目の回答です。") return "二回目の回答です、修正済み。";
      return undefined;
    },
    onEvent: (event) => {
      if (steered) return;
      const e = event as { assistantMessageEvent?: { type?: string } };
      if (e.assistantMessageEvent?.type === "text_delta") {
        steered = true;
        void harness.session.steer("別の質問をします");
      }
    },
  });

  try {
    await harness.session.prompt("1つ目の質問");

    // 1つ目の応答: 待機中の continuation があるため置換しない。
    const assistantMessages = collectAssistantMessages(harness);
    assert.equal(assistantMessages.length, 2, "steer により2つの応答");
    assert.equal(assistantMessages[0].text, ORIGINAL, "1つ目は原文のまま");
    assert.equal(assistantMessages[1].text, "二回目の回答です、修正済み。", "2つ目（待機なし）は採用本文");

    // 1つ目の応答は skip として記録される（candidate としては claim されない）。
    const candidates = harness.candidateEntries();
    assert.equal(candidates.length, 1, "2つ目の応答のみ candidate 記録");
    assert.equal(candidates[0].inputHash, sha256Utf8("二回目の回答です。"));

    // 日本語理由の追加 Executor ターンが発生していないことを
    // mock provider の request 数で確認する（steer 1回分のみ）。
    assert.equal(harness.mockState.requests.length, 2);
  } finally {
    await harness.cleanup();
  }
});

test("session 切替: runtime newSession / fork で session_start reason が届き epoch が変わる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qf-runtime-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  // session の保存先と project cwd を実在させ、ユーザーの ~/.pi に触れないようにする。
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  // 採用シームは承認済み構成だけを対象にする（egress allow + allowlist + model）。
  await writeFile(join(agentDir, "quality-flow.json"), JSON.stringify(APPROVED_FORMATTER_CONFIG), "utf8");
  const sessionDir = join(dir, "sessions");

  try {
    const modelRuntime: ModelRuntimeType = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
    });

    const script: MockScript = { responses: [{ text: ORIGINAL, chunkCount: 2, chunkDelayMs: 10 }] };
    const sessionStartReasons: string[] = [];
    const trustObservations: unknown[] = [];

    const trustProbe: InlineExtension = {
      name: "pi-qf-trust-probe",
      hidden: true,
      factory: (pi) => {
        pi.on("session_start", async (event, ctx) => {
          sessionStartReasons.push(event.reason);
          trustObservations.push(ctx.isProjectTrusted());
        });
      },
    };

    const createRuntime = createRuntimeSessionFactory({
      cwd,
      agentDir,
      modelRuntime,
      buildExtensionFactories: () => [
        trustProbe,
        {
          name: "pi-qf-mock-provider",
          hidden: true,
          factory: createMockProviderExtension({ script: () => script }),
        },
        {
          name: "pi-quality-flow",
          hidden: true,
          factory: createQualityFlowExtension({
            finalize: ({ originalText }) => (originalText === ORIGINAL ? ADOPTED : undefined),
            // 採用シームは pre gate が使える構成だけを対象にする。
            gateExecutable: GATE_BIN,
            configAgentDir: agentDir,
          }),
        },
      ],
    });

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: SessionManager.create(cwd, sessionDir),
    });

    let session = runtime.session;
    await session.bindExtensions({});
    session.subscribe(() => {});

    await session.prompt("1つ目");
    const firstEntries = readSessionEntries(session);
    const firstEpoch = firstEntries.find((e) => typeof e.sessionEpoch === "string") as
      | { sessionEpoch: string }
      | undefined;
    assert.ok(firstEpoch, "1つ目の session で candidate 記録");

    await runtime.newSession();
    session = runtime.session;
    await session.bindExtensions({});

    assert.ok(sessionStartReasons.includes("new"), "session_start reason=new が届く");
    assert.equal(trustObservations.length >= 2, true, "trust 観測が2 session 分ある");
    assert.equal(typeof trustObservations[0], "boolean", "isProjectTrusted は boolean");

    // 新 session でも同じ応答に対して同じ finalizer が走る（epoch が別なので stale にならない）。
    await session.prompt("2つ目");
    const entries = readSessionEntries(session);
    assert.ok(entries.some((e) => e.phase === "formatted"), "新 session でも置換される");
    // 旧 session の candidateId（epoch prefix）は新 session の記録に現れない。
    const newEpochs = entries
      .map((e) => e.sessionEpoch as string | undefined)
      .filter(Boolean) as string[];
    assert.equal(newEpochs.every((s) => s !== firstEpoch.sessionEpoch), true);

    // fork も session_start(reason=fork) で観測できる。
    let userId: string | undefined;
    for (const e of session.sessionManager.getEntries()) {
      if (e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user") {
        userId = (e as { id: string }).id;
        break;
      }
    }
    assert.ok(userId, "fork 元の user entry がある");
    await runtime.fork(userId, { position: "at" });
    session = runtime.session;
    await session.bindExtensions({});
    assert.ok(sessionStartReasons.includes("fork"), "session_start reason=fork が届く");

    await runtime.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("P06 compaction: threshold compaction で candidate identity が保持される", async () => {
  // compaction（threshold）を強制する: mock 応答の usage.totalTokens を
  // compaction 閾値を超える値にする（contextWindow 128000 - reserveTokens 500 =
  // 127500 より大きいと shouldCompact が成立）。
  const harnessEvents: Array<{ type: string; [key: string]: unknown }> = [];
  const harness = await createHarness({
    responses: [
      // 1 turn 目: 低 usage（compaction 閾値以下）。
      { text: "一回目の回答です。", totalTokens: 100 },
      // 2 turn 目: usage を閾値超えにする（contextWindow 128000 - reserve 500）。
      { text: ORIGINAL, totalTokens: 127_501 },
      // compaction の summary 生成用（LLM request。split turn で2回呼ばれる
      // ため summary 用を2件用意する）。本文は検査しない。
      { text: "summary of previous conversation" },
      { text: "summary of previous conversation" },
    ],
    finalize: ({ originalText }) => (originalText === ORIGINAL ? ADOPTED : undefined),
    settingsOverrides: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 } },
    onEvent: (event) => harnessEvents.push(event),
  });
  try {
    await harness.session.prompt("1つ目の質問");
    await harness.session.prompt("2つ目の質問");

    // compaction の start / end を観測する（reason は threshold）。
    const start = harnessEvents.find((e) => e.type === "compaction_start");
    const end = harnessEvents.find((e) => e.type === "compaction_end");
    assert.ok(start, "compaction_start が届く");
    assert.equal(start.reason, "threshold");
    assert.ok(end, "compaction_end が届く");
    assert.equal(end.reason, "threshold");
    assert.equal(end.aborted, false, "compaction は完了");
    const result = end.result as { estimatedTokensAfter?: number } | undefined;
    assert.ok(result?.estimatedTokensAfter !== undefined, "compaction 結果に tokensAfter がある");
    assert.ok(
      (result?.estimatedTokensAfter ?? Infinity) < 127_501,
      "compaction 後の context は閾値以下に収まる",
    );

    // compaction が発生したことの証跡（session entry に compaction がある）。
    const compactionEntries = harness.session.sessionManager
      .getEntries()
      .filter((e) => e.type === "compaction");
    assert.ok(compactionEntries.length > 0, "threshold compaction が実行された");

    // candidate 記録は compaction によって失われない（identity の保持）。
    // 別 candidate（1 turn 目と 2 turn 目）は別 candidateId で記録される。
    const candidates = harness.candidateEntries();
    assert.equal(candidates.length, 2, "2 candidate 分の記録が保持される");
    const ids = new Set(candidates.map((c) => c.candidateId));
    assert.equal(ids.size, 2, "candidateId は重複しない");
    const target = candidates.find((c) => c.inputHash === sha256Utf8(ORIGINAL));
    assert.ok(target, "対象 candidate が記録されている");
    assert.equal(target.phase, "formatted", "採用判断は保持される");
    assert.equal(target.outputHash, sha256Utf8(ADOPTED), "outputHash も保持される");
    // summary 生成で mock provider が呼ばれた（2 turn 応答 + summary 2件）。
    assert.equal(harness.mockState.requests.length, 4, "summary 生成の request を観測");
  } finally {
    await harness.cleanup();
  }
});

// --- helpers ---

function collectAssistantMessages(harness: { session: AgentSession }) {
  return harness.session.messages
    .filter((m) => m.role === "assistant")
    .map((m) => {
      const a = m as unknown as {
        content: Array<{ type: string; text?: string }>;
        stopReason: string;
      };
      return {
        text: a.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
        stopReason: a.stopReason,
      };
    });
}

function readSessionEntries(session: AgentSession): Array<Record<string, unknown>> {
  return session.sessionManager
    .getEntries()
    .filter((e) => e.type === "custom")
    .map((e) => (e as { data?: unknown }).data as Record<string, unknown>);
}

// MockResponse の型参照を保持（script リテラルの型補完用）。
export type { MockResponse };
