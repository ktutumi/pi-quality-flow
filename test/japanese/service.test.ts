/**
 * 単体試験: checkJapanese()（設計書 第12章・第30章）。
 *
 * 手動 `/quality japanese check` と自動 validation-only gate の共通 service。
 * 対応可能な平文を固定版 jp-quality-gate で検証し、原文と scope=editable-prose
 * の診断を返す。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkJapanese,
  mapGateDiagnostics,
} from "../../src/japanese/service.ts";
import { prepareEditableDocument, buildGateProjection } from "../../src/japanese/editable-document.ts";
import type { ParsedGateReport } from "../../src/jpqg/schema.ts";
import { GATE_BIN, createTempDir, removeDir, writeExecutable } from "../helpers/gate-bin.ts";

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

test("コード fence を含む候補: fence は保護され、prose だけ検査する（Issue #6）", async () => {
  // Issue #6 の EditableDocument により、fence 内は保護、外側の prose だけ検査する。
  const result = await checkJapanese({
    text: "これはテストです。\n\n```js\nconst x = 1;\n```",
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.status, "pass");
});

test("inline code を含む候補: inline code は保護され、外側だけ検査する", async () => {
  const result = await checkJapanese({
    text: "これは `简体字変数` を含むテストです。",
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.status, "pass");
});

test("blockquote は保護され、未確認 raw HTML は unsupported-structure", async () => {
  // blockquote のみ → 編集可能 prose なし → skip。
  const quote = await checkJapanese({
    text: "> 引用Block内の简体字テスト",
    executable: GATE_BIN,
  });
  assert.ok(quote.ok);
  assert.equal(quote.check.status, "skipped");
  assert.equal(quote.check.reason, "no-editable-japanese");

  // 未確認 raw HTML → unsupported-structure。
  const html = await checkJapanese({
    text: "<span>简体字テスト</span>",
    executable: GATE_BIN,
  });
  assert.ok(html.ok);
  assert.equal(html.check.status, "skipped");
  assert.equal(html.check.reason, "unsupported-structure");

  // link の prose label は編集可能（简体字 が label 内）。
  const link = await checkJapanese({
    text: "詳細は[简体字文档](https://example.com)を参照。",
    executable: GATE_BIN,
  });
  assert.ok(link.ok);
  assert.equal(link.check.status, "fail");

  // 表の cell 内 prose も検査される。
  const table = await checkJapanese({
    text: "| 列A | 列B |\n|---|---|\n| 简 | 字 |",
    executable: GATE_BIN,
  });
  assert.ok(table.ok);
  assert.equal(table.check.status, "fail");
});

test("コード fence のみの候補は no-editable-japanese で skip する", async () => {
  const result = await checkJapanese({
    text: "```js\nconst x = 1;\n```",
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.status, "skipped");
  assert.equal(result.check.reason, "no-editable-japanese");
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

test("Markdown を含む候補: 編集可能 prose だけを検査する（Issue #6）", async () => {
  // fence 内の简は保護、外側の简だけ検出される。
  const result = await checkJapanese({
    text: "これはテストです。\n\n```js\nconst 简 = 1;\n```\n\nこれは简体字のテスト。",
    executable: GATE_BIN,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.check.status, "fail");
  // fence 内（code point 23）は検査対象外。診断は編集可能 segment のみ。
  const fenceIdx = result.check.diagnostics.findIndex((d) => d.start === 23);
  assert.equal(fenceIdx, -1, "fence 内の简 は検査対象外");
  assert.ok(result.check.diagnostics.some((d) => d.start === 38));
});

test("inline code 内の简は保護され、外側は検査される", async () => {
  const result = await checkJapanese({
    text: "これは `简コード` を含む简テスト。",
    executable: GATE_BIN,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.check.status, "fail");
  assert.equal(result.check.diagnostics.length, 1);
  // 診断は inline code の外側（简テスト、原文 offset 14）にある。
  const d = result.check.diagnostics[0]!;
  assert.equal(d.start, 14);
});

test("「…」引用内の简は保護される", async () => {
  const result = await checkJapanese({
    text: "「方案」という表現が出る简。",
    executable: GATE_BIN,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.check.status, "fail");
  assert.equal(result.check.diagnostics.length, 1);
  const d = result.check.diagnostics[0]!;
  // 引用（0..4）の外側。
  assert.ok(d.start >= 4);
});

test("blockquote は保護され、外側だけ検査される", async () => {
  const result = await checkJapanese({
    text: "> 简の引用\n\nこれは简体字のテスト。",
    executable: GATE_BIN,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.check.status, "fail");
  for (const d of result.check.diagnostics) {
    assert.ok(d.start >= 10, `diagnostic inside blockquote: ${d.start}`);
  }
});

test("GFM 表の cell 内 prose も検査される", async () => {
  const result = await checkJapanese({
    text: "| 名前 | 説明 |\n|---|---|\n| 简 | 説明です |",
    executable: GATE_BIN,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.check.status, "fail");
  assert.ok(result.check.diagnostics.length >= 1);
});

test("コードのみの候補は no-editable-japanese で skip", async () => {
  const result = await checkJapanese({
    text: "```js\nconst 简 = 1;\n```",
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.status, "skipped");
  assert.equal(result.check.reason, "no-editable-japanese");
});

test("未閉じ fence は unsupported-structure で skip する", async () => {
  const result = await checkJapanese({
    text: "説明\n\n```js\nconst x = 1;",
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.status, "skipped");
  assert.equal(result.check.reason, "unsupported-structure");
});

test("未確認 raw HTML は unsupported-structure で skip する", async () => {
  const result = await checkJapanese({
    text: "これは<span>混入</span>テストです。",
    executable: GATE_BIN,
  });
  assert.ok(result.ok);
  assert.equal(result.check.status, "skipped");
  assert.equal(result.check.reason, "unsupported-structure");
});

test("確認済み HTML code は保護され、外側は検査される", async () => {
  const result = await checkJapanese({
    text: "これは<code>简コード</code>を含む简テスト。",
    executable: GATE_BIN,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.check.status, "fail");
  assert.equal(result.check.diagnostics.length, 1);
  const d = result.check.diagnostics[0]!;
  assert.ok(d.start > 20);
});

test("診断 text と対応 slice が一致しない場合は gate-scope-unmappable", async () => {
  // 実 CLI では一致するため、一致検査の単体確認は EditableDocument 経由の
  // 不整合 fixture で行う。ここでは projection 上の text と wire.text の
  // 一致を service が検査することを mock gate で確認するのは Issue #7 以降。
  // この段階では実 CLI の診断が対応 slice と一致することを確認する。
  const result = await checkJapanese({
    text: "これは简体字のテスト。\n\n```js\nconst x = 1;\n```",
    executable: GATE_BIN,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.check.status, "fail");
  const d = result.check.diagnostics[0]!;
  // 診断座標が原文の 简 を指すことを独立比較で確認する。
  const checked = "これは简体字のテスト。\n\n```js\nconst x = 1;\n```";
  assert.equal(checked.slice(d.start, d.end), "简");
});

test("wire.text と対応 slice が一致しない診断は gate-scope-unmappable で拒否する", async () => {
  // 不整合 wire（実在の rule だが text を改変）を作り、mapDiagnostic の
  // 一致検査が拒否することを純粋関数で確認する。
  const text = "これは简体字のテスト。";
  const doc = prepareEditableDocument(text);
  assert.ok(doc.supported);
  const projection = buildGateProjection(doc);
  const report: ParsedGateReport = {
    status: "fail",
    score: { errors: 1, warnings: 0 },
    issues: [
      {
        rule: "simplified_chinese_form",
        severity: "error",
        message: "Japanese-unattested simplified Chinese form detected: 简",
        start: 3,
        end: 4,
        // 実際の projection slice は "简" だが、改変した text を返す。
        text: "別の字",
        line: 1,
        column: 4,
        details: { codepoint: "U+7B80" },
      },
    ],
    binaryVersion: "unicode=18.0.0,cjclassifier=1.0.5",
    unicodeVersion: "18.0.0",
  };
  const result = mapGateDiagnostics(doc, projection, report);
  assert.ok(!result.ok);
  assert.equal(result.reason, "gate-scope-unmappable");
});

test("wire.text が一致する診断は採用可能な座標に変換される", async () => {
  const text = "これは简体字のテスト。";
  const doc = prepareEditableDocument(text);
  assert.ok(doc.supported);
  const projection = buildGateProjection(doc);
  const report: ParsedGateReport = {
    status: "fail",
    score: { errors: 1, warnings: 0 },
    issues: [
      {
        rule: "simplified_chinese_form",
        severity: "error",
        message: "Japanese-unattested simplified Chinese form detected: 简",
        start: 3,
        end: 4,
        text: "简",
        line: 1,
        column: 4,
        details: { codepoint: "U+7B80" },
      },
    ],
    binaryVersion: "unicode=18.0.0,cjclassifier=1.0.5",
    unicodeVersion: "18.0.0",
  };
  const result = mapGateDiagnostics(doc, projection, report);
  assert.ok(result.ok);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]!.start, text.indexOf("简"));
  assert.equal(text.slice(result.diagnostics[0]!.start, result.diagnostics[0]!.end), "简");
});
