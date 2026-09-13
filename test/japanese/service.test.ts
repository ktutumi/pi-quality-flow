/**
 * 単体試験: checkJapanese()（設計書 第12章・第30章）。
 *
 * 手動 `/quality japanese check` と自動 validation-only gate の共通 service。
 * 対応可能な平文を固定版 jp-quality-gate で検証し、原文と scope=editable-prose
 * の診断を返す。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkJapanese } from "../../src/japanese/service.ts";
import { GATE_BIN, assertGateBinaryPinned, createTempDir, removeDir, writeExecutable } from "../helpers/gate-bin.ts";

test("日本語の平文を検証して診断を返す", async () => {
  const result = await checkJapanese({ text: "これは简体字のテスト。", executable: GATE_BIN });
  assert.ok(result.ok);
  assert.equal(result.check.status, "fail");
  assert.equal(result.check.scope, "editable-prose");
  assert.equal(result.check.diagnostics.length, 1);
  assert.equal(result.check.diagnostics[0]?.ruleId, "simplified_chinese_form");
});

test("PASS でも原文と scope を返す", async () => {
  const result = await checkJapanese({ text: "これはテストです。", executable: GATE_BIN });
  assert.ok(result.ok);
  assert.equal(result.check.status, "pass");
  assert.deepEqual(result.check.diagnostics, []);
});

test("英語のみの平文は skip する（モデル要求・CLI 呼び出し 0 回）", async () => {
  const result = await checkJapanese({ text: "This is a test.", executable: GATE_BIN });
  assert.ok(result.ok);
  assert.equal(result.check.status, "skipped");
  assert.equal(result.check.reason, "no-editable-japanese");
});

test("コード fence を含む候補はこの段階では unsupported-structure で skip する", async () => {
  // Markdown 構造の保護と source map は Issue #6（EditableDocument）の領域。
  // Issue #3 は平文のみを検証し、扱えない構造は候補全体を skip する。
  const result = await checkJapanese({
    text: "これはテストです。\n\n```js\nconst x = 1;\n```",
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.status, "skipped");
  assert.equal(result.check.reason, "unsupported-structure");
});

test("inline code を含む候補も unsupported-structure で skip する", async () => {
  const result = await checkJapanese({
    text: "これは `简体字変数` を含むテストです。",
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.status, "skipped");
  assert.equal(result.check.reason, "unsupported-structure");
});

test("blockquote / raw HTML / link / 表 も unsupported-structure で skip する", async () => {
  for (const text of [
    "> 引用Block内の简体字テスト",
    "<span>简体字テスト</span>",
    "詳細は[文档](https://example.com)を参照。",
    "| 列A | 列B |\n|---|---|\n| 简 | 字 |",
  ]) {
    const result = await checkJapanese({ text, executable: GATE_BIN });
    assert.ok(result.ok);
    assert.equal(result.check.status, "skipped", JSON.stringify({ text, check: result.check }));
    assert.equal(result.check.reason, "unsupported-structure");
  }
});

test("コード fence のみの候補は unsupported-structure で skip する", async () => {
  const result = await checkJapanese({
    text: "```js\nconst x = 1;\n```",
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.status, "skipped");
  assert.equal(result.check.reason, "unsupported-structure");
});

test("存在しない executable は spawn せず失敗を返す", async () => {
  const result = await checkJapanese({
    text: "これはテストです。",
    executable: "/nonexistent/pi-qf-gate",
  });
  assert.ok(!result.ok);
  assert.equal(result.code, "read-failed");
});

test("digest が一致しない executable は spawn しない", async () => {
  const dir = await createTempDir("pi-qf-svc-");
  try {
    const fake = await writeExecutable(dir, "fake-gate", "#!/bin/sh\necho '{}\n'\n");
    const result = await checkJapanese({ text: "これはテストです。", executable: fake });
    assert.ok(!result.ok);
    assert.equal(result.code, "digest-mismatch");
  } finally {
    await removeDir(dir);
  }
});

test("実 CLI の code point offset が UTF-16 に変換される（surrogate pair fixture）", async () => {
  // "😀" は 1 code point / 2 UTF-16 units。"简" は code point 1 → UTF-16 offset 2。
  const result = await checkJapanese({ text: "😀简", executable: GATE_BIN });
  assert.ok(result.ok);
  assert.equal(result.check.status, "fail");
  const d = result.check.diagnostics[0];
  assert.ok(d);
  assert.equal(d.ruleId, "simplified_chinese_form");
  assert.equal(d.start, 2);
  assert.equal(d.end, 3);
});

test("Unihan 診断が50件に達したら gate-diagnostics-incomplete", async () => {
  const result = await checkJapanese({
    text: "简".repeat(60),
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.incomplete, "gate-diagnostics-incomplete");
});
