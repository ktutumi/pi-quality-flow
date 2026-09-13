/**
 * 単体試験: 診断の正規化と Unicode code point → UTF-16 code unit 変換。
 *
 * jp-quality-gate の start/end は Unicode code point（rune）offset
 * （internal/report/report.go のコメントどおり）。内部 DTO は UTF-16 に統一する
 * （設計書 第15.1章）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  codePointOffsetToUtf16,
  normalizeDiagnostic,
  type WireIssue,
} from "../../src/jpqg/diagnostics.ts";

test("BMP のみのテキストでは code point と UTF-16 が一致する", () => {
  const text = "これはテストです。";
  assert.equal(codePointOffsetToUtf16(text, 3), 3);
  assert.equal(codePointOffsetToUtf16(text, 9), 9);
});

test("surrogate pair を含むテキストで変換する", () => {
  // "😀" は 1 code point / 2 UTF-16 code units。
  const text = "あ😀い";
  // code point 2（"い"）は UTF-16 offset 3。
  assert.equal(codePointOffsetToUtf16(text, 2), 3);
  assert.equal(codePointOffsetToUtf16(text, 3), 4);
});

test("結合文字（合字が無い場合は単純な code point 数）でも一致する", () => {
  // 結合文字も 1 code point = 1 UTF-16 unit（BMP 内）。
  const text = "がぎ"; // か + combining dakuten
  assert.equal(codePointOffsetToUtf16(text, 4), 4);
});

test("範囲を示す start/end が範囲の UTF-16 offsets に変換される", () => {
  const text = "あ😀い";
  assert.deepEqual(codePointOffsetToUtf16(text, 2, 3), [3, 4]);
});

test("normalizeDiagnostic が rule/severity/offset を正規化する", () => {
  const text = "これは简体字のテストです。"; // "简" は code point 3
  const wire: WireIssue = {
    rule: "simplified_chinese_form",
    severity: "error",
    message: "Japanese-unattested simplified Chinese form detected: 简",
    start: 3,
    end: 4,
    text: "简",
    line: 1,
    column: 4,
    details: { codepoint: "U+7B80" },
  };
  const d = normalizeDiagnostic(wire, text, "s0");
  assert.equal(d.ruleId, "simplified_chinese_form");
  assert.equal(d.severity, "error");
  assert.equal(d.segmentId, "s0");
  assert.equal(d.start, 3);
  assert.equal(d.end, 4);
});

test("surrogate pair 前の診断位置が UTF-16 にずれる", () => {
  const text = "😀简体字"; // "简" は code point 1, UTF-16 offset 2
  const wire: WireIssue = {
    rule: "simplified_chinese_form",
    severity: "error",
    message: "m",
    start: 1,
    end: 2,
    text: "简",
    line: 1,
    column: 2,
    details: {},
  };
  const d = normalizeDiagnostic(wire, text, "s0");
  assert.equal(d.start, 2);
  assert.equal(d.end, 3);
});

test("範囲外の offset は拒否する", () => {
  const wire: WireIssue = {
    rule: "chinese_segment",
    severity: "warning",
    message: "m",
    start: 5,
    end: 9,
    text: "x",
    line: 1,
    column: 1,
    details: {},
  };
  assert.throws(() => normalizeDiagnostic(wire, "あいう", "s0"));
});
