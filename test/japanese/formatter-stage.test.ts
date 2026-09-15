/**
 * 契約試験: Formatter stage の予算・中断・無効化（Issue #7）。
 *
 * - candidate 90秒 / japanese 10秒の全体予算は個別 stage 上限より優先し、
 *   Formatter stage の開始前に残り予算を確認する（第32.1章）
 * - held finalizer（処理を保持する backend seam）は deadline・user cancel・
 *   session 切替・設定変更で signal を観測して停止する（第32.3章・第33.1章）
 * - 中断 / 期限切れ後の遅延結果は本文・状態へ反映されない（第33.3章）
 * - timeout / cancel 後の再要求・追加 Executor ターンは 0 回
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleepAbort } from "node:timers/promises";
import {
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type ModelRuntime as ModelRuntimeType,
} from "@earendil-works/pi-coding-agent";
import type { CheckJapaneseResult } from "../../src/japanese/service.ts";
import { createQualityFlowExtension } from "../../src/extension.ts";
import { sha256Utf8 } from "../../src/pi/adapter.ts";
import { createHarness, lastAssistantMessage, APPROVED_FORMATTER_CONFIG, type Harness } from "../helpers/harness.ts";
import { createRuntimeSessionFactory } from "../helpers/runtime-session.ts";
import { GATE_BIN } from "../helpers/gate-bin.ts";
import {
  createMockProviderExtension,
  type MockScript,
} from "../helpers/mock-provider.ts";

const ORIGINAL_FIX = "この実装方案では、APIの返却値を直接利用します。";
const ADOPTED_FIX = "この実装方針では、APIの返却値を直接利用します。";

/** pre gate を即時に pass させる fixture（Formatter stage の予算検証に集中する）。 */
const passGate: CheckJapaneseResult = {
  ok: true,
  check: {
    status: "pass",
    scope: "editable-prose",
    diagnostics: [],
    score: { errors: 0, warnings: 0 },
  },
};

/** abort の欠落でテストが hang しないための待機ヘルパ。既に abort 済みの signal は即時解決する。 */
function abortable(signal: AbortSignal | undefined, saw: { value: boolean }): Promise<void> {
  if (signal?.aborted) {
    saw.value = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    signal?.addEventListener("abort", () => {
      saw.value = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("condition not met within timeout"));
        return;
      }
      setTimeout(tick, 5);
    };
    setTimeout(tick, 5);
  });
}

test("Formatter stage: candidate deadline で held finalizer は abort され、遅延結果は適用されない", async () => {
  let finalizeCalls = 0;
  const saw = { value: false };
  let timeoutMsObserved: number | undefined;
  let harness: Harness | undefined;
  const harnessPromise = createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    checkJapaneseFn: async () => passGate,
    finalize: async ({ originalText, signal, timeoutMs }) => {
      finalizeCalls++;
      if (originalText !== ORIGINAL_FIX) return undefined;
      timeoutMsObserved = timeoutMs;
      await abortable(signal, saw);
      return ADOPTED_FIX; // 遅延結果（deadline 後に返る）
    },
    globalConfig: {
      ...APPROVED_FORMATTER_CONFIG,
      finalization: { deadlineMs: 250 },
    },
  });
  harness = await harnessPromise;
  try {
    await harness.session.prompt("test");
    assert.equal(finalizeCalls, 1, "finalizer は起動される");
    assert.ok(saw.value, "held finalizer は candidate deadline で signal abort を観測する");
    assert.ok(
      timeoutMsObserved !== undefined && timeoutMsObserved <= 250,
      `stage 許可時間は candidate 残り予算に制限される: ${timeoutMsObserved}`,
    );
    assert.equal(
      lastAssistantMessage(harness.session)?.text,
      ORIGINAL_FIX,
      "遅延結果は適用されない（原文のまま）",
    );
    const candidates = harness.candidateEntries();
    const target = candidates.find((c) => c.inputHash === sha256Utf8(ORIGINAL_FIX));
    assert.ok(target, "対象 candidate の記録がある");
    assert.equal(target.phase, "failed", "deadline は failed として記録");
    assert.equal(target.reason, "formatter-deadline", "Formatter stage の timeout 理由コード");
    const checks = harness.checkEntries();
    assert.equal(checks.length, 1, "pre gate の結果を entry に記録");
    assert.equal(checks[0].status, "pass");
    assert.equal(
      checks[0].formatterReason,
      "formatter-deadline",
      "Formatter stage の期限切れを decision に記録",
    );
    assert.ok(
      checks[0].formatterBudgetExpiry === "candidate-deadline",
      "切れた予算の種別を entry に記録",
    );
    assert.equal(harness.mockState.requests.length, 1, "timeout 後の再要求・追加 turn は 0");
  } finally {
    await harness.cleanup();
  }
});

test("Escape（user cancel）は Formatter stage を abort し、遅延結果を適用しない", async () => {
  let finalizeCalls = 0;
  const saw = { value: false };
  let harness: Harness | undefined;
  const harnessPromise = createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    checkJapaneseFn: async () => passGate,
    finalize: async ({ originalText, signal }) => {
      finalizeCalls++;
      if (originalText !== ORIGINAL_FIX) return undefined;
      // finalize 実行中に Escape（session.abort）を送る。
      setTimeout(() => void harness?.session.abort(), 0);
      await abortable(signal, saw);
      return ADOPTED_FIX; // 遅延結果
    },
  });
  harness = await harnessPromise;
  try {
    await harness.session.prompt("test");
    assert.equal(finalizeCalls, 1);
    assert.ok(saw.value, "held finalizer は Escape で signal abort を観測する");
    assert.equal(
      lastAssistantMessage(harness.session)?.text,
      ORIGINAL_FIX,
      "遅延結果は適用されない",
    );
    const candidates = harness.candidateEntries();
    const target = candidates.find((c) => c.inputHash === sha256Utf8(ORIGINAL_FIX));
    assert.ok(target, "対象 candidate の記録がある");
    assert.equal(target.phase, "skipped", "cancel は skipped として記録");
    assert.equal(target.reason, "cancelled", "cancel 理由コード");
    const checks = harness.checkEntries();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].formatterReason, "formatter-cancelled", "cancel を decision に記録");
    assert.ok(checks[0].formatterCancelled === true, "Formatter stage の cancel を記録");
    assert.equal(harness.mockState.requests.length, 1, "cancel 後の再要求は 0 回");
  } finally {
    await harness.cleanup();
  }
});

test("設定変更（OFF）は held finalizer を abort する（store 変更境界での無効化）", async () => {
  let store: import("../../src/config/store.ts").QualityFlowConfigStore | undefined;
  let finalizeCalls = 0;
  const saw = { value: false };
  let harness: Harness | undefined;
  const harnessPromise = createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    finalize: async ({ originalText, signal }) => {
      finalizeCalls++;
      if (originalText !== ORIGINAL_FIX) return undefined;
      // 処理中に OFF（configStoreHook 経由の直接変更。command 経路を使わない）。
      store?.setEnabled(false, "test:off-during-processing");
      await abortable(signal, saw);
      return ADOPTED_FIX; // 遅延結果
    },
    configStoreHook: (s) => (store = s),
  });
  harness = await harnessPromise;
  try {
    await harness.session.prompt("test");
    assert.equal(finalizeCalls, 1);
    assert.ok(saw.value, "OFF により無効化 signal が abort する（ctx.signal は未 abort のまま）");
    assert.equal(
      lastAssistantMessage(harness.session)?.text,
      ORIGINAL_FIX,
      "OFF 中に始まった処理の遅延結果は適用されない",
    );
    // stale 結果は新 config の状態を上書きしない（第33.3章）。
    assert.equal(harness.candidateEntries().length, 0, "stale-config では candidate entry を書かない");
    assert.equal(harness.checkEntries().length, 0, "stale-config では check entry を書かない");
  } finally {
    await harness.cleanup();
  }
});

test("candidate deadline で reject 型の seam も分類される（AbortError 経路）", async () => {
  // signal abort で Promise を reject する backend（実 model adapter の典型）:
  // reject が経路外に逃がされず、candidate に終了記録が付くことを確認する。
  let finalizeCalls = 0;
  let harness: Harness | undefined;
  const harnessPromise = createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    checkJapaneseFn: async () => passGate,
    finalize: async ({ originalText, signal }) => {
      finalizeCalls++;
      if (originalText !== ORIGINAL_FIX) return undefined;
      // 10 秒待つが、signal abort で AbortError として reject する。
      await sleepAbort(10_000, undefined, { signal });
      return ADOPTED_FIX;
    },
    globalConfig: {
      ...APPROVED_FORMATTER_CONFIG,
      finalization: { deadlineMs: 250 },
    },
  });
  harness = await harnessPromise;
  try {
    await harness.session.prompt("test");
    assert.equal(finalizeCalls, 1);
    assert.equal(
      lastAssistantMessage(harness.session)?.text,
      ORIGINAL_FIX,
      "reject 型の遅延結果も適用されない",
    );
    const candidates = harness.candidateEntries();
    const target = candidates.find((c) => c.inputHash === sha256Utf8(ORIGINAL_FIX));
    assert.ok(target, "対象 candidate の記録がある");
    assert.equal(target.phase, "failed", "reject 経路でも failed 記録が付く（claimed のまま残らない）");
    assert.equal(target.reason, "formatter-deadline");
    const checks = harness.checkEntries();
    assert.equal(checks.length, 1);
    assert.ok(checks[0].formatterBudgetExpiry === "candidate-deadline");
    assert.equal(harness.mockState.requests.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("Escape で reject 型の seam も cancelled に分類される（AbortError 経路）", async () => {
  let finalizeCalls = 0;
  let harness: Harness | undefined;
  const harnessPromise = createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    checkJapaneseFn: async () => passGate,
    finalize: async ({ originalText, signal }) => {
      finalizeCalls++;
      if (originalText !== ORIGINAL_FIX) return undefined;
      // Escape と同時に待機を開始する（abort で AbortError reject）。
      await sleepAbort(10_000, undefined, { signal });
      return ADOPTED_FIX;
    },
  });
  harness = await harnessPromise;
  try {
    const prompt = harness.session.prompt("test");
    await waitUntil(() => finalizeCalls >= 1);
    // finalize 実行中に Escape を送る。
    void harness.session.abort();
    await prompt;
    assert.equal(
      lastAssistantMessage(harness.session)?.text,
      ORIGINAL_FIX,
      "reject 型の遅延結果も適用されない",
    );
    const candidates = harness.candidateEntries();
    const target = candidates.find((c) => c.inputHash === sha256Utf8(ORIGINAL_FIX));
    assert.ok(target, "対象 candidate の記録がある");
    assert.equal(target.phase, "skipped", "reject 経路でも終了記録が付く");
    assert.equal(target.reason, "cancelled");
    const checks = harness.checkEntries();
    assert.equal(checks.length, 1);
    assert.ok(checks[0].formatterCancelled === true);
    assert.equal(harness.mockState.requests.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("session 切替（newSession）は held finalizer を abort し、旧 session へ反映しない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qf-stage-switch-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  // 採用シームは承認済み構成だけを対象にする（egress allow + allowlist + model）。
  await writeFile(join(agentDir, "quality-flow.json"), JSON.stringify(APPROVED_FORMATTER_CONFIG), "utf8");
  const sessionDir = join(dir, "sessions");

  let finalizeCalls = 0;
  const saw = { value: false };

  try {
    const modelRuntime: ModelRuntimeType = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
    });

    const script: MockScript = {
      responses: [
        { text: ORIGINAL_FIX, chunkCount: 2, chunkDelayMs: 10 },
        // 2番目も同じ本文にする（state 共有の有無に依らず、新 session の
        // formatting 検証が deterministic になる）。
        { text: ORIGINAL_FIX },
      ],
    };

    const createRuntime = createRuntimeSessionFactory({
      cwd,
      agentDir,
      modelRuntime,
      buildExtensionFactories: () => [
        {
          name: "pi-qf-mock-provider",
          hidden: true,
          factory: createMockProviderExtension({ script: () => script }),
        },
        {
          name: "pi-quality-flow",
          hidden: true,
          factory: createQualityFlowExtension({
            finalize: async ({ originalText, signal }) => {
              finalizeCalls++;
              if (originalText !== ORIGINAL_FIX) return undefined;
              if (finalizeCalls === 1) {
                // 旧 session の処理を held したままにする。
                await abortable(signal, saw);
              }
              return ADOPTED_FIX;
            },
            gateExecutable: GATE_BIN,
            configAgentDir: agentDir,
            checkJapaneseFn: async () => passGate,
          }),
        },
      ],
    });

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: SessionManager.create(cwd, sessionDir),
    });

    const oldSession: AgentSession = runtime.session;
    await oldSession.bindExtensions({});
    oldSession.subscribe(() => {});

    // 1つ目の turn: held finalizer 中に session を切替える。
    const firstPrompt = oldSession.prompt("1つ目");
    await waitUntil(() => finalizeCalls >= 1);
    const switched = runtime.newSession();
    await firstPrompt;
    await switched;

    // 旧 session の本文は遅延結果で置換されない。
    assert.equal(
      lastAssistantMessage(oldSession)?.text,
      ORIGINAL_FIX,
      "旧 session の遅延結果は適用されない",
    );
    assert.ok(saw.value, "held finalizer は session 切替で signal abort を観測する");

    // 新 session でも finalizer が動き、採用本文になる。
    const newSession: AgentSession = runtime.session;
    await newSession.bindExtensions({});
    await newSession.prompt("2つ目");
    assert.equal(lastAssistantMessage(newSession)?.text, ADOPTED_FIX, "新 session の応答は採用本文");

    await runtime.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
