/**
 * Japanese Formatter pipeline の契約試験（Issue #8）。
 *
 * 公開イベント（message_end）から、対象判定 → pre gate → sentinel 保護 →
 * Formatter（最大1回）→ sentinel 検査と復元 → 構造/意味リスク検査 →
 * post gate → 採用判断 → 直接置換を実行し、公開イベントの観測で確認する:
 *
 * - 採用本文への直接置換（最終 message）と provenance（本文と別記録）
 * - pre/post gate 各最大1回、Formatter 最大1回、追加 Executor ターン 0回
 * - request には編集可能 segment だけを露出する（保護領域は sentinel 化）
 * - 障害・拒否は原文維持。悪化する修正案（否定・助詞・レビュー文・regression）
 *   を拒否する
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CheckJapaneseResult } from "../../src/japanese/service.ts";
import { sha256Utf8 } from "../../src/pi/adapter.ts";
import { APPROVED_FORMATTER_CONFIG, createHarness, lastAssistantMessage, type Harness } from "../helpers/harness.ts";
import {
  createMockBackend,
  correctInRequest,
  formatterFailure,
  formatterOk,
  type MockBackendState,
} from "../helpers/mock-backend.ts";
import { SENTINEL_PREFIX } from "../../src/japanese/sentinel.ts";

const ORIGINAL = "この実装方案では、`API` の返却値を直接利用します。";
const FIX = "この実装方針では、`API` の返却値を直接利用します。";
const VERSION = "unicode=18.0.0,cjclassifier=1.0.5";

const PASS: CheckJapaneseResult = {
  ok: true,
  check: {
    status: "pass",
    scope: "editable-prose",
    diagnostics: [],
    score: { errors: 0, warnings: 0 },
    binaryVersion: VERSION,
    policyDigest: "test-policy/tech-minimal-v1",
  },
};

function fail(errors: number, warnings: number): CheckJapaneseResult {
  return {
    ok: true,
    check: {
      status: errors > 0 ? "fail" : "pass",
      scope: "editable-prose",
      diagnostics: [],
      score: { errors, warnings },
      binaryVersion: VERSION,
      policyDigest: "test-policy/tech-minimal-v1",
    },
  };
}

/** gate 入力の本文で結果を選ぶ script（pre gate = 原文、post gate = 修正案）。 */
function gateScript(byText: Record<string, CheckJapaneseResult>) {
  return (async (input: { text: string }): Promise<CheckJapaneseResult> => {
    const result = byText[input.text];
    if (!result) throw new Error(`unexpected gate input: ${JSON.stringify(input.text)}`);
    return result;
  }) as never;
}

/** request 本文内の全 sentinel token を完全に除去する（sentinel-missing の fixture）。 */
function stripSentinels(requestText: string): string {
  return requestText.replace(new RegExp(`${SENTINEL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]+_\\d+⟧`, "g"), "");
}

/** request 本文内の2つの部分を入れ替える（segment chunk 入れ替えの fixture）。 */
function swapInRequest(requestText: string, a: string, b: string): string {
  return requestText.replace(a, "\u0000").replace(b, a).replace("\u0000", b);
}

interface RunEntry {
  requested?: boolean;
  backendCode?: string;
  decision?: { reason?: string; verification?: string; remainingIssues?: boolean };
  usage?: { known?: boolean; inputTokens?: number };
  inputHash?: string;
  outputHash?: string;
  outcome?: string;
  profile?: string;
  preCheck?: { status: string; score: { errors: number; warnings: number } };
  postCheck?: { status: string; score: { errors: number; warnings: number } };
}

function runsOf(harness: Harness): RunEntry[] {
  return harness.formatterEntries() as unknown as RunEntry[];
}


/** 承認済み構成（egress allow + allowlist + model）に試験用の上書きを merge する。 */
function mergeApproved(overrides: Record<string, unknown>): Record<string, unknown> {
  const approved = APPROVED_FORMATTER_CONFIG as unknown as Record<string, unknown>;
  const merged = { ...approved, ...overrides };
  const jpOverride = overrides.japanese as Record<string, unknown> | undefined;
  if (jpOverride) {
    const jpApproved = approved.japanese as Record<string, unknown>;
    const gateOverride = jpOverride.gate as Record<string, unknown> | undefined;
    merged.japanese = {
      ...jpApproved,
      ...jpOverride,
      gate: { ...(jpApproved.gate as Record<string, unknown>), ...gateOverride },
    };
  }
  return merged;
}

async function runPipelineHarness(options: {
  responses?: Array<{ text: string }>;
  gate?: Record<string, CheckJapaneseResult>;
  backendRewrite?: Parameters<typeof createMockBackend>[0]["rewrite"];
  globalConfig?: Record<string, unknown>;
}): Promise<{ harness: Harness; backendState: MockBackendState }> {
  const backendState: MockBackendState = { requests: [] };
  const harness = await createHarness({
    responses: options.responses ?? [{ text: ORIGINAL }],
    backend: createMockBackend({ rewrite: options.backendRewrite, state: backendState }),
    checkJapaneseFn: options.gate ? (gateScript(options.gate) as never) : undefined,
    globalConfig: options.globalConfig,
  });
  return { harness, backendState };
}

test("局所修正の採用: pre/post gate、Formatter 1回、直接置換と provenance 記録", async () => {
  const { harness, backendState } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS, [FIX]: PASS },
    backendRewrite: (request) => formatterOkFix(request),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, FIX, "採用本文へ直接置換される");

    // 追加 Executor ターン 0回、Formatter request 1回。
    assert.equal(harness.mockState.requests.length, 1);
    assert.equal(backendState.requests.length, 1);

    // request には編集可能 segment だけを露出する（保護領域と構文は sentinel 化）。
    const sentRequest = backendState.requests[0];
    assert.ok(sentRequest.text.includes(SENTINEL_PREFIX), "sentinel を含む");
    assert.ok(!sentRequest.text.includes("API"), "inline code の内容は露出しない");
    assert.ok(sentRequest.text.includes("この実装方案では、"), "segment は露出する");
    assert.ok(sentRequest.systemPrompt.length > 0);

    // check entry は pre gate のみ（post は provenance 記録に入る）。
    const checks = harness.checkEntries();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].source, "auto");

    const run = runsOf(harness)[0];
    assert.equal(run.requested, true);
    assert.equal(run.decision?.reason, "post-pass");
    assert.equal(run.decision?.verification, "post");
    assert.equal(run.profile, "tech-minimal-v1");
    assert.equal(run.inputHash, sha256Utf8(ORIGINAL));
    assert.equal(run.outputHash, sha256Utf8(FIX));
    assert.equal(run.usage?.known, true);
    assert.equal(run.outcome, "formatted");
    assert.deepEqual(run.preCheck, { status: "pass", score: { errors: 0, warnings: 0 } });
    assert.deepEqual(run.postCheck, { status: "pass", score: { errors: 0, warnings: 0 } });
  } finally {
    await harness.cleanup();
  }
});

function formatterOkFix(request: { text: string }) {
  return formatterOk(correctInRequest(request.text, "方案", "方針"));
}

test("無変更の修正案は post gate を実行しない（unchanged）", async () => {
  const { harness, backendState } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS },
    backendRewrite: (request) => formatterOk(request.text),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL, "原文維持");
    assert.equal(harness.checkEntries().length, 1, "post gate は実行しない");
    assert.equal(backendState.requests.length, 1, "Formatter request は1回");
    const run = runsOf(harness)[0];
    assert.equal(run.decision?.reason, "no-change");
    assert.equal(run.decision?.verification, "pre");
    assert.equal(run.outcome, "unchanged");
  } finally {
    await harness.cleanup();
  }
});

test("mode off は pre gate のみで Formatter を呼ばない（validation-only）", async () => {
  const { harness, backendState } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS },
    globalConfig: { japanese: { mode: "off" } },
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL);
    assert.equal(backendState.requests.length, 0, "モデル0回");
    assert.equal(harness.checkEntries().length, 1, "pre gate のみ");
    assert.equal(runsOf(harness).length, 0, "Formatter 実行記録なし");
  } finally {
    await harness.cleanup();
  }
});

test("mode gate: trigger（errors）が pre fail のときだけ Formatter を起動する", async () => {
  const config = mergeApproved({ japanese: { mode: "gate", gate: { trigger: "errors" } } });
  {
    const { harness, backendState } = await runPipelineHarness({
      gate: { [ORIGINAL]: fail(1, 0), [FIX]: PASS },
      globalConfig: config,
      backendRewrite: formatterOkFix,
    });
    try {
      await harness.session.prompt("test");
      assert.equal(lastAssistantMessage(harness.session)?.text, FIX, "trigger 時は修正を採用");
      assert.equal(backendState.requests.length, 1);
      assert.equal(harness.checkEntries().length, 1, "pre のみ（post は provenance 記録）");
      assert.equal(runsOf(harness)[0].postCheck?.status, "pass");
    } finally {
      await harness.cleanup();
    }
  }
  {
    const { harness, backendState } = await runPipelineHarness({
      gate: { [ORIGINAL]: PASS },
      globalConfig: config,
      backendRewrite: formatterOkFix,
    });
    try {
      await harness.session.prompt("test");
      assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL, "trigger なしは原文維持");
      assert.equal(backendState.requests.length, 0, "Formatter 0回");
      assert.equal(harness.checkEntries().length, 1);
      assert.equal(runsOf(harness).length, 0);
    } finally {
      await harness.cleanup();
    }
  }
});

test("backend 障害（length）は post 0回・原文維持・failed 記録", async () => {
  const { harness } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS },
    backendRewrite: () => formatterFailure("stop-reason-length"),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL, "原文維持");
    assert.equal(harness.checkEntries().length, 1, "post gate は開始しない");
    const run = runsOf(harness)[0];
    assert.equal(run.requested, true, "障害 request も回数に含める");
    assert.equal(run.backendCode, "stop-reason-length");
    assert.equal(run.outcome, "failed");
    const target = harness
      .candidateEntries()
      .find((c) => c.inputHash === sha256Utf8(ORIGINAL));
    assert.equal(target?.phase, "failed");
    assert.equal(harness.mockState.requests.length, 1, "追加 Executor ターン 0回");
  } finally {
    await harness.cleanup();
  }
});

test("post gate 障害は原文維持（gate-unusable）", async () => {
  const { harness } = await runPipelineHarness({
    gate: {
      [ORIGINAL]: PASS,
      [FIX]: { ok: false, code: "timeout" } as CheckJapaneseResult,
    },
    backendRewrite: formatterOkFix,
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL, "post 障害は原文維持");
    const run = runsOf(harness)[0];
    assert.equal(run.decision?.reason, "gate-unusable:post-gate-failed:timeout");
    assert.equal(run.decision?.verification, "pre");
    assert.equal(run.outcome, "unchanged");
  } finally {
    await harness.cleanup();
  }
});

test("sentinel の欠落は拒否し、再要求しない（post gate 0回）", async () => {
  const { harness, backendState } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS },
    backendRewrite: (request) => formatterOk(stripSentinels(request.text)),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL);
    assert.equal(backendState.requests.length, 1, "再要求しない");
    const run = runsOf(harness)[0];
    assert.equal(run.decision?.reason, "unsafe-rewrite:sentinel-missing");
    assert.equal(harness.checkEntries().length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("レビュー文の文頭追加を拒否する（ADR 0003 fixture 1）", async () => {
  const { harness, backendState } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS },
    backendRewrite: (request) => formatterOk(`修正案:${request.text}`),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL, "レビュー文入りは原文維持");
    const run = runsOf(harness)[0];
    assert.equal(run.decision?.reason, "unsafe-rewrite:commentary-inserted");
    assert.equal(backendState.requests.length, 1, "再要求しない");
  } finally {
    await harness.cleanup();
  }
});

test("レビュー文の段落内挿入を拒否する（ADR 0003 fixture 2）", async () => {
  const { harness } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS },
    backendRewrite: (request) =>
      formatterOk(correctInRequest(request.text, "この実装方案では、", "この実装方案では、修正案です:")),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL);
    const run = runsOf(harness)[0];
    assert.equal(run.decision?.reason, "unsafe-rewrite:commentary-inserted");
  } finally {
    await harness.cleanup();
  }
});

test("主体・対象を反転させる助詞変更（が ⇄ を）は拒否する", async () => {
  const { harness } = await runPipelineHarness({
    responses: [{ text: "A が B を削除します。" }],
    gate: { "A が B を削除します。": PASS },
    backendRewrite: (request) => formatterOk(correctInRequest(request.text, "が B を", "を B が")),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, "A が B を削除します。", "反転は採用しない");
    const run = runsOf(harness)[0];
    assert.equal(run.decision?.reason, "unsafe-rewrite:particle-change");
  } finally {
    await harness.cleanup();
  }
});

test("否定の反転（しません → します）は PASS でも拒否する", async () => {
  const { harness } = await runPipelineHarness({
    responses: [{ text: "削除しません。" }],
    gate: { "削除しません。": PASS },
    backendRewrite: (request) => formatterOk(correctInRequest(request.text, "しません。", "します。")),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, "削除しません。", "否定の反転は原文維持");
    const run = runsOf(harness)[0];
    assert.equal(run.decision?.reason, "unsafe-rewrite:risk-word-change");
  } finally {
    await harness.cleanup();
  }
});

test("segment chunk の入れ替えは拒否する（所属構造の変化）", async () => {
  const { harness } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS },
    backendRewrite: (request) =>
      formatterOk(swapInRequest(request.text, "この実装方案では、", " の返却値を直接利用します。")),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL, "chunk 入れ替えは原文維持");
    const run = runsOf(harness)[0];
    assert.ok(
      String(run.decision?.reason).startsWith("unsafe-rewrite:"),
      `unsafe-rewrite で拒否: ${run.decision?.reason}`,
    );
  } finally {
    await harness.cleanup();
  }
});

test("(0,0) → (0,5) は post PASS でも拒否（quality-regression）", async () => {
  const { harness } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS, [FIX]: fail(0, 5) },
    backendRewrite: formatterOkFix,
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL, "PASS より regression を優先");
    const run = runsOf(harness)[0];
    assert.equal(run.decision?.reason, "quality-regression");
    assert.equal(run.decision?.verification, "pre");
    assert.deepEqual(run.postCheck, { status: "pass", score: { errors: 0, warnings: 5 } });
  } finally {
    await harness.cleanup();
  }
});

test("post FAIL の score 改善は acceptImprovement で採用（残存問題を記録）", async () => {
  const { harness } = await runPipelineHarness({
    gate: { [ORIGINAL]: fail(2, 0), [FIX]: fail(1, 0) },
    backendRewrite: formatterOkFix,
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, FIX, "部分改善の採用");
    const run = runsOf(harness)[0];
    assert.equal(run.decision?.reason, "post-fail-improved");
    assert.equal(run.decision?.remainingIssues, true);
    assert.equal(run.outcome, "formatted");
  } finally {
    await harness.cleanup();
  }
});

test("candidate deadline は backend stage を実停止させ post 0回", async () => {
  const backendState: MockBackendState = { requests: [] };
  let sawAbort = false;
  const harness = await createHarness({
    responses: [{ text: ORIGINAL }],
    backend: createMockBackend({
      rewrite: async (request) => {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) {
            sawAbort = true;
            resolve();
            return;
          }
          request.signal?.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          });
        });
        return formatterOkFix(request);
      },
      state: backendState,
    }),
    checkJapaneseFn: gateScript({ [ORIGINAL]: PASS, [FIX]: PASS }),
    globalConfig: mergeApproved({ finalization: { deadlineMs: 250 } }),
  });
  try {
    await harness.session.prompt("test");
    assert.ok(sawAbort, "backend は signal abort を観測する");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL, "遅延結果は適用されない");
    assert.equal(harness.checkEntries().length, 1, "post gate は開始しない");
    assert.equal(backendState.requests.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("利用量が不明の場合も記録はゼロ化しない（known=false を保持）", async () => {
  const { harness } = await runPipelineHarness({
    gate: { [ORIGINAL]: PASS, [FIX]: PASS },
    backendRewrite: (request) => formatterOk(correctInRequest(request.text, "方案", "方針"), { known: false }),
  });
  try {
    await harness.session.prompt("test");
    const run = runsOf(harness)[0];
    assert.equal(run.usage?.known, false);
    assert.equal(run.usage?.inputTokens, undefined, "不明値をゼロにしない");
    assert.equal(lastAssistantMessage(harness.session)?.text, FIX);
  } finally {
    await harness.cleanup();
  }
});

