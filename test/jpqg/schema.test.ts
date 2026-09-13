/**
 * 単体試験: jp-quality-gate CLI 出力の厳密パース（設計書 第15.1章）。
 *
 * 不正 JSON、schema 不一致、exit と payload の矛盾、未知 version は
 * すべて失敗（internal error）として扱う。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseGateOutput, type WireIssue } from "../../src/jpqg/schema.ts";

const PASS_JSON =
  '{"pass":true,"summary":{"errors":0,"warnings":0,"issues":0},"issues":[],"meta":{"cj_min_cjk":4,"cj_min_gap":0.15,"cjclassifier_version":"1.0.5","include_code":false,"unicode_version":"18.0.0"}}';

const FAIL_ISSUE: WireIssue = {
  rule: "simplified_chinese_form",
  severity: "error",
  message: "Japanese-unattested simplified Chinese form detected: 简",
  start: 0,
  end: 1,
  text: "简",
  line: 1,
  column: 1,
  details: { codepoint: "U+7B80" },
};

const FAIL_JSON = JSON.stringify({
  pass: false,
  summary: { errors: 1, warnings: 0, issues: 1 },
  issues: [FAIL_ISSUE],
  meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
});


function expectFail(result: ReturnType<typeof parseGateOutput>): { code: string } {
  if (result.ok) throw new Error("expected failure");
  return result;
}

test("正常な PASS 出力をパースする", () => {
  const result = parseGateOutput({ stdout: `${PASS_JSON}\n`, exitCode: 0 });
  assert.ok(result.ok);
  assert.equal(result.report.status, "pass");
  assert.deepEqual(result.report.score, { errors: 0, warnings: 0 });
  assert.deepEqual(result.report.issues, []);
});

test("正常な FAIL 出力をパースする", () => {
  const result = parseGateOutput({ stdout: `${FAIL_JSON}\n`, exitCode: 1 });
  assert.ok(result.ok);
  assert.equal(result.report.status, "fail");
  assert.deepEqual(result.report.score, { errors: 1, warnings: 0 });
  assert.equal(result.report.issues.length, 1);
});

test("warning のみは pass（exit 0）", () => {
  const json = JSON.stringify({
    pass: true,
    summary: { errors: 0, warnings: 2, issues: 2 },
    issues: [
      { ...FAIL_ISSUE, rule: "chinese_segment", severity: "warning" },
      { ...FAIL_ISSUE, rule: "chinese_segment", severity: "warning" },
    ],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
  });
  const result = parseGateOutput({ stdout: json, exitCode: 0 });
  assert.ok(result.ok);
  assert.equal(result.report.status, "pass");
});

test("不正 JSON は失敗", () => {
  const result = parseGateOutput({ stdout: "not json\n", exitCode: 2 });
  assert.ok(!result.ok);
  assert.equal(result.code, "invalid-json");
});

test("JSON の前後の余分な出力は失敗", () => {
  const result = parseGateOutput({ stdout: `noise\n${PASS_JSON}\n`, exitCode: 0 });
  assert.ok(!result.ok);
  assert.equal(result.code, "invalid-json");
});

test("空 stdout は失敗", () => {
  const result = parseGateOutput({ stdout: "", exitCode: 2 });
  assert.ok(!result.ok);
  assert.equal(result.code, "invalid-json");
});

test("internal_error は失敗（exit 2 と一致する場合）", () => {
  const result = parseGateOutput({
    stdout: '{"pass":false,"internal_error":"boom"}\n',
    exitCode: 2,
  });
  assert.ok(!result.ok);
  assert.equal(result.code, "cli-internal-error");
});

test("exit と pass の矛盾は失敗", () => {
  const mismatch1 = parseGateOutput({ stdout: PASS_JSON, exitCode: 1 });
  assert.ok(!mismatch1.ok);
  assert.equal(mismatch1.code, "exit-mismatch");

  const mismatch2 = parseGateOutput({ stdout: FAIL_JSON, exitCode: 0 });
  assert.ok(!mismatch2.ok);
  assert.equal(mismatch2.code, "exit-mismatch");
});

test("未知の unicode version は失敗", () => {
  const json = JSON.stringify({
    pass: true,
    summary: { errors: 0, warnings: 0, issues: 0 },
    issues: [],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "17.0.0" },
  });
  const result = parseGateOutput({ stdout: json, exitCode: 0 });
  assert.ok(!result.ok);
  assert.equal(result.code, "unknown-version");
});

test("未知の cjclassifier version は失敗", () => {
  const json = JSON.stringify({
    pass: true,
    summary: { errors: 0, warnings: 0, issues: 0 },
    issues: [],
    meta: { cjclassifier_version: "9.9.9", unicode_version: "18.0.0" },
  });
  const result = parseGateOutput({ stdout: json, exitCode: 0 });
  assert.ok(!result.ok);
  assert.equal(result.code, "unknown-version");
});

test("summary と issues の件数不一致は失敗", () => {
  const json = JSON.stringify({
    pass: false,
    summary: { errors: 2, warnings: 0, issues: 1 },
    issues: [FAIL_ISSUE],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
  });
  const result = parseGateOutput({ stdout: json, exitCode: 1 });
  assert.ok(!result.ok);
  assert.equal(result.code, "schema-mismatch");
});

test("pass=true なのに errors>0 は失敗", () => {
  const json = JSON.stringify({
    pass: true,
    summary: { errors: 1, warnings: 0, issues: 1 },
    issues: [FAIL_ISSUE],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
  });
  const result = parseGateOutput({ stdout: json, exitCode: 0 });
  assert.ok(!result.ok);
  assert.equal(result.code, "schema-mismatch");
});

test("未知の severity / 不正な offset は失敗", () => {
  const badSeverity = JSON.stringify({
    pass: true,
    summary: { errors: 0, warnings: 1, issues: 1 },
    issues: [{ ...FAIL_ISSUE, severity: "info" }],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
  });
  assert.equal(expectFail(parseGateOutput({ stdout: badSeverity, exitCode: 0 })).code, "schema-mismatch");

  const badOffset = JSON.stringify({
    pass: false,
    summary: { errors: 1, warnings: 0, issues: 1 },
    issues: [{ ...FAIL_ISSUE, start: -1 }],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
  });
  assert.equal(expectFail(parseGateOutput({ stdout: badOffset, exitCode: 1 })).code, "schema-mismatch");
});

test("未知の exit code は失敗", () => {
  const result = parseGateOutput({ stdout: PASS_JSON, exitCode: 3 });
  assert.ok(!result.ok);
  assert.equal(result.code, "unknown-exit");
});

test("summary.issues が実件数と不一致なら失敗", () => {
  const json = JSON.stringify({
    pass: false,
    summary: { errors: 1, warnings: 0, issues: 5 },
    issues: [FAIL_ISSUE],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
  });
  const result = parseGateOutput({ stdout: json, exitCode: 1 });
  assert.ok(!result.ok);
  assert.equal(result.code, "schema-mismatch");
});

test("summary の件数が非負整数でなければ失敗", () => {
  const fractional = JSON.stringify({
    pass: false,
    summary: { errors: 1.5, warnings: 0, issues: 1 },
    issues: [FAIL_ISSUE],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
  });
  assert.equal(expectFail(parseGateOutput({ stdout: fractional, exitCode: 1 })).code, "schema-mismatch");

  const negative = JSON.stringify({
    pass: true,
    summary: { errors: -1, warnings: 0, issues: 0 },
    issues: [],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
  });
  assert.equal(expectFail(parseGateOutput({ stdout: negative, exitCode: 0 })).code, "schema-mismatch");

  const nan = JSON.stringify({
    pass: true,
    summary: { errors: 0, warnings: Number.NaN, issues: 0 },
    issues: [],
    meta: { cjclassifier_version: "1.0.5", unicode_version: "18.0.0" },
  });
  assert.equal(expectFail(parseGateOutput({ stdout: nan, exitCode: 0 })).code, "schema-mismatch");
});
