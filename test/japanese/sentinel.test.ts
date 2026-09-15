/**
 * sentinel 保護と復元の単体試験（Issue #8、設計書 第21.2・21.3章）。
 *
 * - request は編集可能 segment だけを露出する（保護領域・Markdown 境界は sentinel）
 * - 衝突・集合・個数・順序・改変・未知 token を検査して復元する
 * - 復元は送信前の immutable map だけで行う（出力内の保護内容を信用しない）
 * - 絵文字・結合文字・CRLF・BOM で byte 列を完全に保持する
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProtectedRequest,
  sentinelToken,
  verifyAndRestore,
  SENTINEL_PREFIX,
} from "../../src/japanese/sentinel.ts";
import { prepareEditableDocument } from "../../src/japanese/editable-document.ts";
import { swapInText } from "../helpers/mock-backend.ts";

const MAX_BYTES = 131072;

interface Built {
  text: string;
  tokens: string[];
  ranges: Array<{ start: number; end: number; text: string }>;
}

function build(source: string): Built {
  const doc = prepareEditableDocument(source);
  assert.ok(doc.supported, `unsupported: ${source}`);
  const result = buildProtectedRequest({
    source,
    segments: doc.segments,
    maxRequestBytes: MAX_BYTES,
  });
  assert.ok(result.ok, `build failed: ${JSON.stringify(result)}`);
  return { text: result.request.text, tokens: result.request.tokens, ranges: result.request.ranges };
}

test("request は編集可能 segment だけを露出し、保護領域と構文は sentinel 化される", () => {
  const source = "この実装方案では、`API` の返却値を直接利用します。";
  const built = build(source);
  // inline code は sentinel になる（request に原文が露出しない）。
  assert.ok(built.text.includes("この実装方案では、"), "segment は露出する");
  assert.ok(!built.text.includes("`API`"), "保護 span は露出しない");
  assert.equal(built.tokens.length, built.ranges.length, "token と範囲の個数が一致");
  for (const token of built.tokens) {
    assert.ok(token.startsWith(SENTINEL_PREFIX) && token.endsWith("⟧"), `token 形式: ${token}`);
  }
});

test("request は Markdown 境界も sentinel 化し、元の位置に保つ", () => {
  const source = "見出し\n\n- 項目1\n- 項目2\n";
  const built = build(source);
  // 先頭の「見出し」と item の本文は segment、見出し marker / 区切り / list marker は sentinel。
  assert.ok(built.text.startsWith("見出し"), "先頭 segment が最初に来る");
  assert.ok(built.text.includes("項目1"), "segment が含まれる");
  assert.ok(built.text.includes("項目2"));
  // sentinel が segment の前後の元の位置に現れる（見出し marker は見出し語の後ろに来ない）。
  const firstSentinelAt = built.text.indexOf(SENTINEL_PREFIX);
  assert.ok(firstSentinelAt > 0, "見出し語の後で sentinel に切り替わる");
});

test("build は sentinel prefix を含む原文を衝突として拒否する", () => {
  const doc = prepareEditableDocument(`⟦PQF_PROTECTED_x_0⟧ これは本文です。`);
  assert.ok(doc.supported);
  const result = buildProtectedRequest({
    source: `⟦PQF_PROTECTED_x_0⟧ これは本文です。`,
    segments: doc.segments,
    maxRequestBytes: MAX_BYTES,
  });
  assert.deepEqual(result, { ok: false, code: "sentinel-collision" });
});

test("request サイズ上限を超えたら切り詰めず拒否する", () => {
  const doc = prepareEditableDocument("日本語の本文です。");
  assert.ok(doc.supported);
  const result = buildProtectedRequest({
    source: "日本語の本文です。",
    segments: doc.segments,
    maxRequestBytes: 4,
  });
  assert.deepEqual(result, { ok: false, code: "request-too-large" });
});

function roundTrip(source: string): string {
  const built = build(source);
  const restored = verifyAndRestore(built.text, { tokens: built.tokens, ranges: built.ranges });
  assert.ok(restored.ok, `verify failed: ${JSON.stringify(restored)}`);
  return restored.restored;
}

test("復元は原文の byte 列を完全に保持する（絵文字・結合文字・CRLF・BOM）", () => {
  for (const source of [
    "確認をお願ｲします。🀄🀛",
    "結合文字: か\u3099き",
    "CRLF 行1\r\n行2\r\n",
    "\uFEFF BOM 付き本文です。",
    "「引用」の中の方案と『二重』です。",
    "| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n",
    "- [ ] task 1\n- [x] task 2\n",
    "emoji 👩‍👩‍👧‍👦 family",
  ]) {
    assert.equal(roundTrip(source), source, `byte 保持: ${JSON.stringify(source)}`);
  }
});

test("sentinel の欠落・重複・未知 token・順序変更・改変を拒否する", () => {
  const source = "前に説明、`code` 後に本文。";
  const built = build(source);
  const request = { tokens: built.tokens, ranges: built.ranges };
  const [firstToken] = built.tokens;

  // 欠落: token を削る。
  const without = built.text.replace(firstToken, "");
  assertMatch(verifyAndRestore(without, request), "sentinel-missing");

  // 重複: 同じ token を2回。
  assertMatch(verifyAndRestore(built.text + firstToken, request), "sentinel-duplicate");

  // 未知 token: 別 nonce / 切れた token。
  assertMatch(
    verifyAndRestore(built.text + `${SENTINEL_PREFIX}deadbeef_0⟧`, request),
    "sentinel-unknown",
  );
  assertMatch(
    verifyAndRestore(built.text + SENTINEL_PREFIX, request),
    "sentinel-unknown",
  );

  // 順序変更: token を入れ替える（2 token 以上の fixture）。
  if (built.tokens.length >= 2) {
    const swapped = swapInText(built.text, built.tokens[0], built.tokens[1]);
    assertMatch(verifyAndRestore(swapped, request), "sentinel-out-of-order");
  }

  // 改変: token の末尾だけ変える → prefix の出現は unknown token になる。
  const tampered = built.text.replace(firstToken, firstToken.slice(0, -2) + "xx⟧");
  assertMatch(verifyAndRestore(tampered, request), "sentinel-unknown");
});

function assertMatch(
  actual: { ok: boolean; code?: string },
  expected: string,
): void {
  assert.equal(actual.ok, false, `拒否されるべき: ${JSON.stringify(actual)}`);
  assert.equal(actual.code, expected);
}

test("verifyAndRestore は token の出現位置だけを見て map から復元する", () => {
  const source = "「原文の引用」を含む本文です。";
  const built = build(source);
  const request = { tokens: built.tokens, ranges: built.ranges };

  // sentinel 層の契約: token の集合・個数・順序が正しければ復元する。
  // sentinel 直後に書かれた偽のテキストは編集可能領域への挿入であり、
  // 意味リスク検査（変更量・マーカー検査）の管轄であって sentinel ではない。
  const appended = built.text + "偽の保護内容";
  const restored = verifyAndRestore(appended, request);
  assert.ok(restored.ok);
  // 復元は map の byte 列（原文の引用）で行われ、出力の他の text はそのまま残る。
  assert.equal(restored.restored, "「原文の引用」を含む本文です。偽の保護内容");

  // token の見た目を偽装した未知 token（別 nonce）は拒否する。
  assertMatch(
    verifyAndRestore(`${SENTINEL_PREFIX}ffffffff_0⟧`, request),
    "sentinel-unknown",
  );
});

test("複数 segment・複数 sentinel の request で往復する", () => {
  const source = "最初の段落です。\n\n**強調**された段落、`code` です。\n\n- list 項目\n";
  const restored = roundTrip(source);
  assert.equal(restored, source);
});
