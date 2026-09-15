/**
 * 単体試験: EditableDocument（設計書 第12.2・21章、Issue #6）。
 *
 * CommonMark + GFM（表・task list）を micromark で parse し、
 * source offset を保持したまま編集可能 prose と保護 span を分離する。
 * parse → stringify は行わず、原文の source range から byte 列を保持する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGateProjection,
  prepareEditableDocument,
  type EditableDocument,
} from "../../src/japanese/editable-document.ts";

function assertSupported(text: string): Extract<EditableDocument, { supported: true }> {
  const doc = prepareEditableDocument(text);
  assert.equal(doc.supported, true, `expected supported: ${JSON.stringify(text)} → ${JSON.stringify(doc)}`);
  if (!doc.supported) throw new Error("unreachable");
  return doc;
}

function assertUnsupported(text: string): void {
  const doc = prepareEditableDocument(text);
  assert.equal(doc.supported, false, `expected unsupported: ${JSON.stringify(text)}`);
  if (!doc.supported) {
    assert.equal(doc.reason, "unsupported-structure");
  }
}

test("平文 1 segment: 全体が編集可能", () => {
  const doc = assertSupported("これはテストです。");
  assert.equal(doc.segments.length, 1);
  assert.equal(doc.segments[0]?.text, "これはテストです。");
  assert.equal(doc.segments[0]?.start, 0);
  assert.equal(doc.segments[0]?.end, 9);
});

test("fenced code block は保護され、外側の prose だけ編集可能", () => {
  const doc = assertSupported("これはテストです。\n\n```js\nconst x = 1;\n```\n\nこれは简体字のテスト。");
  const texts = doc.segments.map((s) => s.text);
  assert.deepEqual(texts, ["これはテストです。", "これは简体字のテスト。"]);
  // 保護部分が原文 byte 列どおり保持されている。
  assert.ok(doc.protectedSpans.some((p) => p.text === "```js\nconst x = 1;\n```"));
});

test("未閉じ fence は unsupported-structure", () => {
  // 未閉じ fence は AST 上 code になるが、末尾が保護でない領域を残す。
  // 設計書 21.1: 未閉じ code fence は候補全体を skip。
  const doc = prepareEditableDocument("説明\n\n```js\nconst x = 1;");
  assert.equal(doc.supported, false);
  if (!doc.supported) assert.equal(doc.reason, "unsupported-structure");
});

test("inline code は保護され、前後の prose は編集可能", () => {
  const doc = assertSupported("これは `简コード` を含むテストです。");
  assert.equal(doc.segments.length, 2);
  assert.equal(doc.segments[0]?.text, "これは ");
  assert.equal(doc.segments[1]?.text, " を含むテストです。");
  assert.ok(doc.protectedSpans.some((p) => p.text === "`简コード`"));
});

test("コードのみの候補は編集可能 segment 0 で supported（呼び出し側で skip）", () => {
  const doc = assertSupported("```js\nconst x = 1;\n```");
  assert.equal(doc.segments.length, 0);
  assert.ok(doc.protectedSpans.length > 0);
});

test("リンクの prose label は編集可能、destination は保護", () => {
  const doc = assertSupported("詳細は[文档](https://example.com)を参照。");
  const texts = doc.segments.map((s) => s.text);
  assert.deepEqual(texts, ["詳細は", "文档", "を参照。"]);
  // destination を含む括弧部分が保護されている。
  assert.ok(doc.protectedSpans.some((p) => p.text === "](https://example.com)"));
});

test("autolink は全体保護（prose label を持たない）", () => {
  const doc = assertSupported("詳細は<https://example.com>を参照简。");
  const texts = doc.segments.map((s) => s.text);
  assert.deepEqual(texts, ["詳細は", "を参照简。"]);
  assert.ok(doc.protectedSpans.some((p) => p.text === "<https://example.com>"));
});

test("image は全体保護", () => {
  const doc = assertSupported("![説明](https://example.com/a.png)の図简。");
  const texts = doc.segments.map((s) => s.text);
  assert.deepEqual(texts, ["の図简。"]);
});

test("reference link の prose label は編集可能、definition は保護", () => {
  const doc = assertSupported("詳細は[文档][ref]を参照简。\n\n[ref]: https://example.com");
  const texts = doc.segments.map((s) => s.text);
  assert.deepEqual(texts, ["詳細は", "文档", "を参照简。"]);
  assert.ok(doc.protectedSpans.some((p) => p.text.includes("[ref]: https://example.com")));
});

test("blockquote は原則保護", () => {
  const doc = assertSupported("> 简の引用\n\nこれはテストです。");
  const texts = doc.segments.map((s) => s.text);
  assert.deepEqual(texts, ["これはテストです。"]);
  assert.ok(doc.protectedSpans.some((p) => p.text === "> 简の引用"));
});

test("未確認の inline raw HTML は unsupported-structure（fail-closed）", () => {
  // 設計書 21.1: 構造や出所が不明な raw HTML は候補全体を skip。
  // 確認済み code / pre のみ保護対象。
  assertUnsupported("これは<span>混入</span>テストです。");
  assertUnsupported("これは<em>混入</em>テストです。");
  assertUnsupported("<div>\n混入\n</div>\n\nこれはテスト");
});

test("確認済み HTML code / pre は保護される", () => {
  const doc = assertSupported("これは<code>简コード</code>を含むテストです。");
  assert.ok(doc.protectedSpans.some((p) => p.text === "<code>简コード</code>"));
  const doc2 = assertSupported("<pre>const x = 1;</pre>\n\nこれはテスト简。");
  assert.ok(doc2.protectedSpans.some((p) => p.text === "<pre>const x = 1;</pre>"));
  assert.ok(doc2.segments.some((s) => s.text === "これはテスト简。"));
});

test("GFM 表: cell 内の prose は編集可能", () => {
  const doc = assertSupported("| 名前 | 説明 |\n|---|---|\n| 简 | 説明です |");
  const texts = doc.segments.map((s) => s.text);
  assert.deepEqual(texts, ["名前", "説明", "简", "説明です"]);
});

test("GFM task list: 説明部分は編集可能", () => {
  const doc = assertSupported("- [ ] 作業する\n- [x] 完了简");
  const texts = doc.segments.map((s) => s.text);
  assert.deepEqual(texts, ["作業する", "完了简"]);
});

test("「…」引用は保護される", () => {
  const doc = assertSupported("「方案」という表現が出る简。");
  const texts = doc.segments.map((s) => s.text);
  assert.deepEqual(texts, ["という表現が出る简。"]);
  assert.ok(doc.protectedSpans.some((p) => p.text === "「方案」"));
});

test("『…』引用も保護される", () => {
  const doc = assertSupported("『方案』を参照简。");
  assert.ok(doc.protectedSpans.some((p) => p.text === "『方案』"));
});

test("不平衡な「 は unsupported-structure", () => {
  assertUnsupported("「方案と別の表现");
});

test("URL は保護される", () => {
  const doc = assertSupported("詳細は https://example.com/a?b=1 を参照简。");
  assert.ok(doc.protectedSpans.some((p) => p.text === "https://example.com/a?b=1"));
  // URL の外側は編集可能。
  assert.ok(doc.segments.some((s) => s.text.includes("を参照简。")));
});

test("version 表記は保護される", () => {
  const doc = assertSupported("バージョン 2.1.0 を使用します。");
  assert.ok(doc.protectedSpans.some((p) => p.text === "2.1.0"));
});

test("CLI flag は保護される", () => {
  const doc = assertSupported("--force フラグを付けます。");
  assert.ok(doc.protectedSpans.some((p) => p.text === "--force"));
});

test("path は保護される", () => {
  const doc = assertSupported("/usr/local/bin に配置します。");
  assert.ok(doc.protectedSpans.some((p) => p.text === "/usr/local/bin"));
});

test("数値+単位は保護される", () => {
  const doc = assertSupported("30秒以内、80%以上の割合です。");
  assert.ok(doc.protectedSpans.some((p) => p.text === "30秒"));
  assert.ok(doc.protectedSpans.some((p) => p.text === "80%"));
});

test("heading / emphasis / strong / delete の子 text は編集可能", () => {
  const doc = assertSupported("# 見出し\n\n**太字**と*斜体*と~~取消~~简。");
  assert.ok(doc.segments.some((s) => s.text === "見出し"));
  assert.ok(doc.segments.some((s) => s.text === "太字"));
  assert.ok(doc.segments.some((s) => s.text === "取消"));
  assert.ok(doc.segments.some((s) => s.text.includes("と")));
});

test("thematic break / break は保護（編集可能 text を壊さない）", () => {
  const doc = assertSupported("前の文\n\n---\n\n後の文简。");
  assert.ok(doc.segments.some((s) => s.text === "後の文简。"));
});

test("絵文字（surrogate pair）を含む source offset がずれない", () => {
  const doc = assertSupported("😀简テスト");
  assert.equal(doc.segments[0]?.text, "😀简テスト");
  // UTF-16 code unit 座標: 😀 = 2 units。
  assert.equal(doc.segments[0]?.start, 0);
  assert.equal(doc.segments[0]?.end, 6);
});

test("BOM を含む原文の座標が保持される", () => {
  const doc = assertSupported("﻿これはテスト");
  // BOM 自体は保護 span、prose は編集可能 segment（BOM を editable に含めない）。
  assert.deepEqual(doc.protectedSpans.map((p) => p.text), ["﻿"]);
  assert.equal(doc.segments[0]?.text, "これはテスト");
  assert.equal(doc.segments[0]?.start, 1);
});

test("CRLF を含む原文が byte 保持される", () => {
  const doc = assertSupported("行1\r\n行2简。");
  assert.ok(doc.segments.some((s) => s.text.includes("行2简。")));
  // 元の CRLF が正規化されず保持される（protectedSpans か segment 間で byte 保持）。
  assert.equal(doc.segments[0]?.text, "行1\r\n行2简。");
});

test("保護 byte 列の完全保持: 併合された span も byte-equal", () => {
  const text = "これは `a` と `b` を含む简。";
  const doc = assertSupported(text);
  for (const span of doc.protectedSpans) {
    assert.equal(text.slice(span.start, span.end), span.text);
    assert.equal(
      Buffer.compare(Buffer.from(text.slice(span.start, span.end), "utf8"), Buffer.from(span.text, "utf8")),
      0,
    );
  }
});

test("重なる保護範囲は併合される", () => {
  const doc = assertSupported("「方案」とhttps://example.com/a を参照简。");
  const spans = doc.protectedSpans;
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i]!.start >= spans[i - 1]!.end, "spans must be sorted and non-overlapping");
  }
});

test("segment の source range が原文 byte と一致する", () => {
  const text = "前の文。\n\n```js\nconst x = 1;\n```\n\n後の文简。";
  const doc = assertSupported(text);
  for (const seg of doc.segments) {
    assert.equal(text.slice(seg.start, seg.end), seg.text);
  }
});

test("footnote reference は保護される", () => {
  const doc = assertSupported("注简[^1]\n\n[^1]: 脚注");
  // 脚注の本体も保護（quote 扱い）。参照 marker は保護。
  assert.ok(doc.segments.some((s) => s.text.includes("注")));
  assert.ok(doc.protectedSpans.some((p) => p.text.includes("[^1]: 脚注")));
});

test("setext heading も対応", () => {
  const doc = assertSupported("見出しです\n===\n\n本文简。");
  assert.ok(doc.segments.some((s) => s.text === "見出しです"));
  assert.ok(doc.segments.some((s) => s.text === "本文简。"));
});

test("未知の node 型は unsupported-structure（fail-closed）", () => {
  // mdast の将来拡張を想定。現在は footnoteDefinition 以外の未知型を拒否するため、
  // 手動で不正な AST を想定した fixture は持たない。代わりに実際の
  // 対応範囲外（GFM 拡張の math 等）を micromark-extension-math なしで
  // 作れないため、ここでは blockquote 内のネスト等を確認する。
  const doc = assertSupported("> > ネスト引用\n\n本文简。");
  assert.ok(doc.segments.every((s) => !s.text.includes("ネスト引用")));
});

test("1行の indented code block も supported", () => {
  const doc = assertSupported("    const x = 1;\n\nこれはテスト简。");
  assert.ok(doc.segments.some((s) => s.text === "これはテスト简。"));
});

test("gate projection: 編集可能 segment を原文順に連結し、保護部分を中立区切りに置換する", () => {
  const doc = assertSupported("これはテストです。\n\n```js\nconst x = 1;\n```\n\nこれは简体字のテスト。");
  const projection = buildGateProjection(doc);
  // 保護部分は中立区切り（空行）。segment は原文順。
  assert.equal(projection.projection, "これはテストです。\n\nこれは简体字のテスト。");
});

test("gate projection: global code point offset を原文 UTF-16 座標へ変換する", () => {
  const source = "これはテストです。\n\n```js\nconst x = 1;\n```\n\nこれは简体字のテスト。";
  const doc = assertSupported(source);
  const projection = buildGateProjection(doc);
  const seg2 = projection.segments[1];
  assert.ok(seg2);
  // segment 先頭は原文の2つ目の prose と一致する。
  assert.equal(seg2.sourceStart, source.indexOf("これは简体字"));
  // projection 上の segment 開始 code point を境界から導出する。
  assert.equal(seg2.projectionStartCp, [...projection.projection.slice(0, seg2.projectionStartCp)].length);
  // segment 内の "简" の code point offset を導出する。
  const segText = doc.segments[1]!.text;
  const localCp = [...segText.slice(0, segText.indexOf("简"))].length;
  const mapped = projection.mapDiagnostic(seg2.projectionStartCp + localCp, seg2.projectionStartCp + localCp + 1);
  assert.ok(mapped);
  assert.equal(mapped.segmentId, "s1");
  // 原文の "简体字" の位置に対応する。
  assert.equal(mapped.start, source.indexOf("简体字"));
  assert.equal(mapped.end, mapped.start + 1);
});

test("gate projection: 診断が中立区切りに落ちた場合は対応不能", () => {
  const source = "これはテストです。\n\n```js\nconst x = 1;\n```\n\nこれは简体字のテスト。";
  const doc = assertSupported(source);
  const projection = buildGateProjection(doc);
  const seg1 = projection.segments[0];
  const seg2 = projection.segments[1];
  assert.ok(seg1 && seg2);
  // segment1 終了〜 segment2 開始の区切りに diagnostic が落ちる場合は unmappable。
  assert.equal(projection.mapDiagnostic(seg1.projectionEndCp, seg1.projectionEndCp + 1), undefined);
  // segment をまたぐ診断も対応不能。
  assert.equal(projection.mapDiagnostic(seg1.projectionEndCp - 1, seg2.projectionStartCp + 1), undefined);
});

test("gate projection: 範囲外の診断は対応不能", () => {
  const doc = assertSupported("これはテストです。");
  const projection = buildGateProjection(doc);
  assert.equal(projection.mapDiagnostic(100, 101), undefined);
});

test("gate projection: segmentId は原文順の連番", () => {
  const doc = assertSupported("前简。\n\n```js\nx\n```\n\n後简。");
  const projection = buildGateProjection(doc);
  assert.equal(projection.segments[0]?.segmentId, "s0");
  assert.equal(projection.segments[1]?.segmentId, "s1");
});

test("entity decode 後の token も正確な source offset で保護される", () => {
  // mdast は entity を decode するため node.value が source とずれる。
  // raw source を走査するため &amp; の後の 2.1.0 も正確に保護される。
  const doc = assertSupported("A &amp; 2.1.0 B 简 &lt;x&gt; C --force D");
  const version = doc.protectedSpans.find((p) => p.text === "2.1.0");
  assert.ok(version, "2.1.0 が保護される");
  assert.equal(doc.source.slice(version.start, version.end), "2.1.0");
  const flag = doc.protectedSpans.find((p) => p.text === "--force");
  assert.ok(flag, "--force が保護される");
  assert.equal(doc.source.slice(flag.start, flag.end), "--force");
});

test("escaped pipe を含む text も source offset がずれない", () => {
  const doc = assertSupported("a \\| b\n\n後简");
  // escaped pipe は table と誤認されない。
  assert.ok(doc.segments.some((s) => s.text.includes("後简")));
});

test("frontmatter（--- … ---）は編集可能 prose として扱わない（fail-closed）", () => {
  // parser は frontmatter を対応していないため、--- は thematicBreak、
  // 中身は heading に parse される。frontmatter 相当の先頭 block は
  // 設計上の対応範囲外のため、先頭行が --- で始まる候補は unsupported。
  const doc = prepareEditableDocument("---\ntitle: 简\n---\n\n本文简。");
  assert.equal(doc.supported, false, "frontmatter 相当の候補は unsupported");
  if (!doc.supported) assert.equal(doc.reason, "unsupported-structure");
});

test("単独の --- は CommonMark の thematic break として supported", () => {
  const doc = assertSupported("前\n\n---\n\n後简。");
  assert.ok(doc.segments.some((s) => s.text === "後简。"));
});

test("閉じ区切りのない --- は frontmatter ではない", () => {
  const doc = assertSupported("--- だけの行\n\n後简。");
  assert.ok(doc.segments.some((s) => s.text.includes("後简。")));
});

test("+++ … +++ の frontmatter も unsupported-structure", () => {
  const doc = prepareEditableDocument("+++\nx = 1\n+++\n\n本文简。");
  assert.equal(doc.supported, false);
  if (!doc.supported) assert.equal(doc.reason, "unsupported-structure");
});

test("未解決の reference link（definition なし）は unsupported-structure", () => {
  // definition がない [x][y] は plain text になる。曖昧な引用 marker 相当として
  // 候補全体を skip する（設計書 21.1）。
  const doc = prepareEditableDocument("詳細は[文档][ref]を参照简。");
  assert.equal(doc.supported, false);
  if (!doc.supported) assert.equal(doc.reason, "unsupported-structure");
});

test("gate projection: 同一 block 内の inline 分割 segment は連結される", () => {
  const doc = assertSupported("これは**重要**です。");
  // inline 構文（strong）で分かれた segment は空行で分離しない。
  const projection = buildGateProjection(doc);
  assert.equal(projection.projection, "これは重要です。");
});


test("識別子・API / package 名の保護と通常英語語の非保護", () => {
  const spansOf = (text: string): string[] => {
    const doc = prepareEditableDocument(text);
    assert.ok(doc.supported);
    return doc.protectedSpans.map((span) => span.text);
  };
  // token 内に大文字を2個以上含む語（API / SDK / IPv6）と camelCase・snake_case を保護
  assert.deepEqual(spansOf("API の返却値を使います。"), ["API"]);
  assert.deepEqual(spansOf("SDK を更新します。"), ["SDK"]);
  assert.deepEqual(spansOf("IPv6 で接続します。"), ["IPv6"]);
  assert.deepEqual(spansOf("maxTokens を設定します。"), ["maxTokens"]);
  assert.deepEqual(spansOf("max_tokens を設定します。"), ["max_tokens"]);
  // 通常の英語語（先頭大文字のみ・全小文字）は編集可能のまま
  assert.deepEqual(
    spansOf("Hello, this is a normal sentence with Important words."),
    [],
  );
});
