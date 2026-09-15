/**
 * 復元後の構造不変条件の単体試験（Issue #8、設計書 第22.1章）。
 *
 * - 良性の誤字修正は構造検査を通る
 * - 保護 span の byte 変化・segment 数・所属 block 境界・Markdown 構造の
 *   変更を検出する
 * - 検査は sentinel 復元と独立に、再 parse した比較で行う
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prepareEditableDocument } from "../../src/japanese/editable-document.ts";
import { verifyRestoredStructure, structureFingerprint } from "../../src/japanese/structural.ts";

const ORIGINAL = "この実装方案では、`API` の返却値を直接利用します。";

function originalDoc() {
  const doc = prepareEditableDocument(ORIGINAL);
  assert.ok(doc.supported);
  return doc;
}

test("局所的な誤字修正は構造検査を通る", () => {
  const doc = originalDoc();
  const corrected = ORIGINAL.replace("方案", "方針");
  const result = verifyRestoredStructure(doc, corrected);
  assert.ok(result.ok, `拒否された: ${JSON.stringify(result)}`);
  assert.equal(result.doc.segments.length, doc.segments.length);
});

test("保護 span の byte 列の変化を拒否する", () => {
  const doc = originalDoc();
  // inline code の内容を再 parse して変える（sentinel 復元と独立した比較）。
  const corrected = ORIGINAL.replace("`API`", "`api`");
  const result = verifyRestoredStructure(doc, corrected);
  assert.deepEqual({ ok: result.ok, code: result.ok ? undefined : result.code }, {
    ok: false,
    code: "protected-span-changed",
  });
});

test("segment 数の変化（block の増減）を拒否する", () => {
  const doc = originalDoc();
  // 段落を追加すると segment 数が変わる（文の追加は意味リスク検査の管轄）。
  const result = verifyRestoredStructure(doc, `${ORIGINAL}\n\n追加の段落です。`);
  assert.deepEqual({ ok: result.ok, code: result.ok ? undefined : result.code }, {
    ok: false,
    code: "segment-count-changed",
  });
});

test("所属 block 境界の変化を拒否する（blockId 系列の不一致）", () => {
  // paragraph を heading に変えると block 構成と fingerprint が変わる。
  const source = "普通の段落です。\n\n二つ目の段落です。";
  const doc = prepareEditableDocument(source);
  assert.ok(doc.supported);
  const result = verifyRestoredStructure(doc, "# 普通の段落です。\n\n二つ目の段落です。");
  assert.ok(!result.ok);
  assert.ok(
    result.code === "block-boundary-changed" || result.code === "structure-changed",
    `期待外のコード: ${result.code}`,
  );
});

test("Markdown 構造 fingerprint は見出し・list・table の変化を検出する", () => {
  assert.notEqual(
    structureFingerprint("見出しです。"),
    structureFingerprint("# 見出しです。"),
  );
  assert.notEqual(
    structureFingerprint("- a\n- b\n"),
    structureFingerprint("1. a\n2. b\n"),
  );
  assert.notEqual(
    structureFingerprint("- a\n- b\n"),
    structureFingerprint("- [ ] a\n- [x] b\n"),
  );
  assert.notEqual(
    structureFingerprint("| a |\n| --- |\n| 1 |\n"),
    structureFingerprint("| a | b |\n| --- | --- |\n| 1 | 2 |\n"),
  );
  // 良性の誤字修正では同一。
  assert.equal(
    structureFingerprint("この実装方案では、返却値を利用します。"),
    structureFingerprint("この実装方針では、返却値を利用します。"),
  );
});

test("対応不能な復元文（未閉じ quote 等）を unsupported で拒否する", () => {
  const source = "「閉じられた引用」です。";
  const doc = prepareEditableDocument(source);
  assert.ok(doc.supported);
  const result = verifyRestoredStructure(doc, "「不平衡な引用です。");
  assert.deepEqual({ ok: result.ok, code: result.ok ? undefined : result.code }, {
    ok: false,
    code: "unsupported-structure",
  });
});

test("表の列構成の変化と block の並べ替えを fingerprint で拒否する", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const doc = prepareEditableDocument(table);
  assert.ok(doc.supported);
  const changed = "| a |\n| --- |\n| 1 |\n";
  const result = verifyRestoredStructure(doc, changed);
  assert.ok(!result.ok);
});
