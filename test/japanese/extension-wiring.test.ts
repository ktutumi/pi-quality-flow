/**
 * 単体試験: 拡張配線 — 自動 validation-only gate と /quality japanese check。
 *
 * Issue #3 の受け入れ基準:
 * - 自動処理は正常 stop・非空 text block 1つ・toolCall なし・8192 bytes 以内
 * - 英語のみは skip、編集可能 CJK-only は gate に渡す
 * - モデル要求と追加 Executor ターンは 0 回
 * - 手動 check は現在の final response の read-only 検証
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, lastAssistantMessage } from "../helpers/harness.ts";
import { GATE_BIN, assertGateBinaryPinned } from "../helpers/gate-bin.ts";

test("gate binary が固定版 digest と一致する", async () => {
  await assertGateBinaryPinned();
});

test("自動 validation-only gate: 日本語応答を検証し entry に記録する", async () => {
  const harness = await createHarness({
    responses: [{ text: "これは简体字のテスト。" }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("test");
    const entries = harness
      .candidateEntries()
      .concat(harness.checkEntries());
    const check = harness.checkEntries();
    assert.equal(check.length, 1);
    assert.equal(check[0]?.status, "fail");
    assert.equal(check[0]?.scope, "editable-prose");
    // モデル要求は 1 回のみ（Formatter なし）。
    assert.equal(harness.mockState.requests.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("自動 validation-only gate: 英語のみは skip を記録する", async () => {
  const harness = await createHarness({
    responses: [{ text: "This is a plain answer." }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("test");
    const check = harness.checkEntries();
    assert.equal(check.length, 1);
    assert.equal(check[0]?.status, "skipped");
    assert.equal(check[0]?.reason, "no-editable-japanese");
  } finally {
    await harness.cleanup();
  }
});

test("自動 validation-only gate: CJK-only も gate に渡す", async () => {
  const harness = await createHarness({
    responses: [{ text: "简体中文文本" }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("test");
    const check = harness.checkEntries();
    assert.equal(check.length, 1);
    // gate 実行の結果（CJ 分類）をそのまま記録する。
    assert.notEqual(check[0]?.status, undefined);
  } finally {
    await harness.cleanup();
  }
});

test("自動 validation-only gate: 本文は置換しない（validation-only）", async () => {
  const harness = await createHarness({
    responses: [{ text: "これは简体字のテスト。" }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("test");
    const last = lastAssistantMessage(harness.session);
    assert.ok(last);
    assert.equal(last.text, "これは简体字のテスト。");
  } finally {
    await harness.cleanup();
  }
});

test("/quality japanese check: 最後の assistant message を read-only 検証する", async () => {
  const harness = await createHarness({
    responses: [{ text: "これは简体字のテスト。" }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("test");
    const before = harness.checkEntries().length;
    const candidatesBefore = harness.candidateEntries().length;
    await harness.session.prompt("/quality japanese check");
    const check = harness.checkEntries();
    assert.ok(check.length > before, "check entry が追加される");
    const latest = check[check.length - 1];
    assert.equal(latest?.source, "manual");
    assert.equal(latest?.status, "fail");
    // read-only: モデル要求は増えない。
    assert.equal(harness.mockState.requests.length, 1);
    // 手動 check は candidate を claim しない（single-flight 状態を変えない）。
    assert.equal(
      harness.candidateEntries().length,
      candidatesBefore,
      "candidate 記録は変化しない",
    );
  } finally {
    await harness.cleanup();
  }
});

test("手動 check と自動 gate の真の競合: 遅延 gate 中の手動 check は自動結果を壊さない", async () => {
  // 自動 gate を ordinal 制御の遅延 fixture で保持する。手順:
  // 1. 最初の turn を通常に完了させ lastFinalText を seed する（call #1 即時）。
  // 2. 2つ目の turn を開始し、自動 gate（call #2）を遅延 fixture で保持する。
  // 3. 保持中に /quality japanese check を発行し（call #3 即時）、手動 check が
  //    先に確定することを観測する。
  // 4. call #2 を解放し、遅延した自動結果が手動 check の記録を壊さないことを
  //    確認する（第33.3章: 遅延結果の副作用 0）。
  const release: Array<() => void> = [];
  let autoCalls = 0;
  const harness = await createHarness({
    responses: [
      // call #1: seed 用（即時）。
      { text: "これは简体字のテストです。" },
      // call #2: 自動 gate を遅延 fixture で保持する。
      { text: "これは简体字のテストです。" },
      // 手動 check は seeded lastFinalText を対象にする（call #3）。
      { text: "（使われない）" },
    ],
    gateExecutable: GATE_BIN,
    checkJapaneseFn: async (options) => {
      autoCalls++;
      if (autoCalls === 2) {
        await new Promise<void>((resolve) => release.push(resolve));
      }
      const { checkJapanese } = await import("../../src/japanese/service.ts");
      return checkJapanese(options);
    },
    finalize: ({ originalText }) =>
      originalText === "これは简体字のテストです。" ? "これは簡体字のテストです。" : undefined,
  });
  try {
    // call #1: seed turn（lastFinalText を設定する）。
    await harness.session.prompt("seed");
    assert.equal(harness.checkEntries().filter((c) => c.source === "manual").length, 0);

    // call #2: 自動 gate を遅延 fixture で保持する turn を開始する。
    const blockedPrompt = harness.session.prompt("2つ目").then(() => "done" as const);
    await new Promise<void>((resolve) => {
      const wait = () => {
        if (autoCalls >= 2) resolve();
        else setTimeout(wait, 5);
      };
      wait();
    });

    // call #3: 手動 check を発行する（自動 gate 保持中）。call #3 は即時。
    await harness.session.prompt("/quality japanese check");
    const manualEntries = harness.checkEntries().filter((c) => c.source === "manual");
    assert.equal(manualEntries.length, 1, "手動 check は遅延 gate 中に確定する");
    assert.equal(manualEntries[0]?.status, "pass", "seed した採用本文（簡体字修正済み）は pass");

    // call #2 を解放する。
    release.splice(0).forEach((r) => r());
    await blockedPrompt;

    // 自動 gate の記録は保持される（手動 check に上書きされない）。
    const checks = harness.checkEntries();
    const auto = checks.filter((c) => c.source === "auto");
    const manualAfter = checks.filter((c) => c.source === "manual");
    assert.equal(auto.length, 2, "自動 gate の check 記録が保持される");
    assert.equal(manualAfter.length, 1, "手動 check の記録は保持される");
    assert.equal(manualAfter[0]?.status, "pass", "手動 check の status は release 後も変わらない");
    // 自動 gate は candidate を claim する（single-flight 状態を保持）。
    const candidates = harness.candidateEntries();
    assert.equal(candidates.length, 2, "candidate 記録は保持される");
    assert.equal(candidates[1]?.phase, "formatted", "自動処理の採用判断は壊れない");
    assert.equal(lastAssistantMessage(harness.session)?.text, "これは簡体字のテストです。");
  } finally {
    await harness.cleanup();
  }
});
