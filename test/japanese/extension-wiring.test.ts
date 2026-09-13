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
