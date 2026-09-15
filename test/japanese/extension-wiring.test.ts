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
    await harness.session.prompt("/quality japanese check");
    const check = harness.checkEntries();
    assert.ok(check.length > before, "check entry が追加される");
    const latest = check[check.length - 1];
    assert.equal(latest?.source, "manual");
    assert.equal(latest?.status, "fail");
    // read-only: モデル要求は増えない。
    assert.equal(harness.mockState.requests.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("手動 check と自動検証の競合: 手動 check は自動処理の candidate を claim しない", async () => {
  // 手動 check は read-only 検証であり、自動検証（candidate claim / single-flight）
  // と干渉しないことを確認する。auto gate が candidate を claim した後でも
  // 手動 check は同じ本文を独立に検証できる。
  const harness = await createHarness({
    responses: [{ text: "これは简体字のテスト。" }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("test");
    const autoChecks = harness.checkEntries().filter((c) => c.source === "auto");
    assert.equal(autoChecks.length, 1, "自動 gate の check 記録");
    // 手動 check を実行する。
    await harness.session.prompt("/quality japanese check");
    const checks = harness.checkEntries();
    const manual = checks.filter((c) => c.source === "manual");
    assert.equal(manual.length, 1, "手動 check は独立に記録される");
    assert.equal(manual[0]?.status, "fail");
    // モデル要求は増えない（手動 check は Formatter / Executor を起動しない）。
    assert.equal(harness.mockState.requests.length, 1);
    // 手動 check で candidate 記録は増えない（claim を取らない）。
    assert.equal(harness.candidateEntries().length, autoChecks.length, "candidate 記録は変化しない");
  } finally {
    await harness.cleanup();
  }
});

test("手動 check と自動検証の遅延競合: 自動処理の結果は手動 check で壊れない", async () => {
  // 手動 check 中に自動処理が完了しても、lastCheck / entry の上書きで
  // 両方の記録が保持されることを確認する。
  const harness = await createHarness({
    responses: [{ text: "これは简体字のテストです。" }],
    gateExecutable: GATE_BIN,
    finalize: ({ originalText }) =>
      originalText === "これは简体字のテストです。" ? "これは簡体字のテストです。" : undefined,
  });
  try {
    await harness.session.prompt("test");
    const autoBefore = harness.checkEntries().filter((c) => c.source === "auto").length;
    assert.equal(autoBefore, 1, "自動 gate の記録");
    // 置換後の採用本文を手動 check する。
    await harness.session.prompt("/quality japanese check");
    const checks = harness.checkEntries();
    assert.equal(checks.filter((c) => c.source === "auto").length, autoBefore, "自動記録は保持");
    assert.equal(checks.filter((c) => c.source === "manual").length, 1, "手動記録は保持");
    const manual = checks.find((c) => c.source === "manual");
    assert.ok(manual);
    // 採用本文（簡体字）は error 0 になる。
    assert.equal(manual.status, "pass", "採用本文の check は pass");
    assert.equal(harness.mockState.requests.length, 1, "モデル要求は増えない");
  } finally {
    await harness.cleanup();
  }
});
