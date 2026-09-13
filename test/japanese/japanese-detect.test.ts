/**
 * 単体試験: Japanese detection（設計書 第31章）。
 *
 * 判定対象は編集可能 prose。英語のみ・コードのみは skip、
 * CJK-only も gate に渡す（中国語混入の可能性があるため除外しない）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectJapaneseProse } from "../../src/japanese/japanese-detect.ts";

test("日本語の prose を検出する", () => {
  assert.equal(detectJapaneseProse("これはテストです。"), true);
});

test("英語のみは検出しない（skip 対象）", () => {
  assert.equal(detectJapaneseProse("This is a test."), false);
});

test("コードのみは検出しない", () => {
  assert.equal(detectJapaneseProse("const x = 1;"), false);
});

test("CJK-only も検出する（gate に渡す）", () => {
  // 中国語混入の可能性があるため軽量判定で除外しない。
  assert.equal(detectJapaneseProse("简体中文文本"), true);
});

test("記号のみは検出しない", () => {
  assert.equal(detectJapaneseProse("---\n- item\n"), false);
});

test("日本語を含む混在文を検出する", () => {
  assert.equal(detectJapaneseProse("Use `npm install` してください。"), true);
});

test("空文字列は検出しない", () => {
  assert.equal(detectJapaneseProse(""), false);
});

test("CJK 拡張B の漢字も検出する", () => {
  assert.equal(detectJapaneseProse("𠀀は古代漢字です"), true);
  assert.equal(detectJapaneseProse("𠀀"), true);
});

test("CJK 互換漢字・拡張A も検出する", () => {
  assert.equal(detectJapaneseProse("豈"), true);
  assert.equal(detectJapaneseProse("㐀"), true);
});
