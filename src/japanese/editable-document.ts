/**
 * EditableDocument（設計書 第12.2・21章、Issue #6）。
 *
 * CommonMark + GFM（micromark）で parse し、source offset を保持したまま
 * 編集可能 prose と保護 span を分離する。parse → stringify は行わず、
 * 原文の source range から byte 列を保持する。全文の Unicode 正規化もしない。
 *
 * 対応範囲（allowlist 外は unsupported-structure で候補全体を skip）:
 * - 編集可能 leaf: text
 * - 編集可能 container: paragraph / heading / emphasis / strong / delete /
 *   listItem / tableCell / link・linkReference の prose label
 * - 保護 leaf: inlineCode / code / image / break / thematicBreak /
 *   blockquote 全体 / footnoteReference / footnoteDefinition /
 *   link・linkReference の構文部分（括弧・destination）
 * - 未確認 raw HTML（code / pre 以外）は unsupported-structure
 * - text leaf 内の `「…」` / `『…』` は保護（不平衡は unsupported）
 * - text leaf 内の URL / path / version / CLI flag / 数値+単位 は保護
 */
import { codePointOffsetToUtf16 } from "../jpqg/diagnostics.ts";
import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { PhrasingContent, Root, RootContent } from "mdast";

export interface ProtectedSpan {
  start: number;
  end: number;
  text: string;
}

export interface EditableSegment {
  start: number;
  end: number;
  text: string;
  /** 所属する Markdown block の識別子（同一 block 内の inline 分割を連結する）。 */
  blockId: number;
}

export type EditableDocument =
  | {
      supported: true;
      /** 原文の完全な保持（byte 保持の独立確認用）。 */
      source: string;
      segments: EditableSegment[];
      protectedSpans: ProtectedSpan[];
    }
  | { supported: false; reason: "unsupported-structure" };

const PARSE_OPTIONS: Options = {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
};

/** 構造 fingerprint など、同じ parse 結果を必要とする検査と共有する。 */
export const MDAST_PARSE_OPTIONS: Options = PARSE_OPTIONS;

/** 編集可能 prose とする node 型（子を走査する container）。 */
const EDITABLE_CONTAINERS = new Set([
  "root",
  "paragraph",
  "heading",
  "emphasis",
  "strong",
  "delete",
  "listItem",
  "tableCell",
  "link",
  "linkReference",
  "table",
  "tableRow",
  "list",
]);

/** 編集可能な leaf。 */
const EDITABLE_LEAF = "text";

/** 保護する leaf node 型。 */
const PROTECTED_LEAVES = new Set([
  "inlineCode",
  "code",
  "image",
  "break",
  "thematicBreak",
  "footnoteReference",
  "html",
  "footnoteDefinition",
  "definition",
  "yaml",
]);

/** 確認済み HTML code / pre のみ保護する（設計書 21.1）。 */
const SAFE_HTML = /^<(code|pre)(\s[^>]*)?>[\s\S]*<\/\1>$/i;

/** 「…」 / 『…』 の pair。 */
const QUOTE_PAIRS: Array<[string, string]> = [
  ["「", "」"],
  ["『", "』"],
];

/** text leaf 内の保護対象（URL / path / version / flag / 数値+単位 / 識別子）。 */
type InlineProtection = {
  pattern: RegExp;
  filter?: (token: string) => boolean;
};
const INLINE_PROTECTED_PATTERNS: InlineProtection[] = [
  { pattern: /https?:\/\/[^\s<>()「」『』、。]+/gu },
  { pattern: /\/?[a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9._-]+)+/gu },
  { pattern: /\d+\.\d+(?:\.\d+)?/gu },
  { pattern: /--?[a-zA-Z][a-zA-Z0-9-]*/gu },
  {
    pattern: /\d+(?:\.\d+)?(?:%|秒|分|時間|日|週|ヶ月|年|KiB|MiB|GiB|bytes?)/gu,
  },
  // 識別子 / API / package 名（設計書 21.1）:
  // - token 内に大文字を2個以上含む語（API / SDK / JSON / IPv6 等）
  // - camelCase（maxTokens 等・小文字の後に大文字）と snake_case（max_tokens 等）
  // 通常の英語語（先頭大文字のみ・全小文字）は保護しない。
  {
    pattern: /[a-zA-Z0-9_-]+/gu,
    filter: (token: string) => (token.match(/[A-Z]/g)?.length ?? 0) >= 2,
  },
  { pattern: /[a-z]+(?:[A-Z][a-z0-9]+)+|[a-zA-Z0-9_]*_[a-zA-Z0-9_]+/gu },
];

/**
 * 編集可能な Markdown 原文を EditableDocument に変換する。
 */
const BOM = "\uFEFF";

export function prepareEditableDocument(text: string): EditableDocument {
  // frontmatter（先頭 --- … --- / +++ … +++）は対応範囲外。parser は
  // 対応せず thematicBreak + heading に分解するため、閉じ区切りまでの
  // 対が存在するときだけ候補全体を skip する（単独の --- は CommonMark の
  // 正当な thematic break として扱う。設計書 21.1: 未対応の拡張構文は skip）。
  if (hasFrontmatter(text)) {
    return { supported: false, reason: "unsupported-structure" };
  }
  let root: Root;
  try {
    root = fromMarkdown(text, PARSE_OPTIONS);
  } catch {
    return { supported: false, reason: "unsupported-structure" };
  }
  // micromark は先頭 BOM を strip し offset を詰める。BOM 分を補正し、
  // BOM 自体は保護 span として保持する（byte 保持のため）。
  const bomOffset = text.startsWith(BOM) ? 1 : 0;

  const protectedRanges: Array<{ start: number; end: number }> = [];
  const segments: EditableSegment[] = [];

  if (bomOffset > 0) {
    protectedRanges.push({ start: 0, end: 1 });
  }

  const blockCounter = { next: 0 };
  if (
    !visit(
      root,
      text,
      protectedRanges,
      segments,
      0,
      bomOffset,
      blockCounter.next++,
      blockCounter,
    )
  ) {
    return { supported: false, reason: "unsupported-structure" };
  }

  const mergedRanges = mergeRanges(protectedRanges);
  // text は merge 後に原文から再構築する（byte 保持の独立確認用）。
  const protectedSpans: ProtectedSpan[] = mergedRanges.map((r) => ({
    start: r.start,
    end: r.end,
    text: text.slice(r.start, r.end),
  }));
  const finalSegments = subtractSegments(segments, protectedSpans);
  return {
    supported: true,
    source: text,
    segments: finalSegments,
    protectedSpans,
  };
}

type Range = { start: number; end: number };

function visit(
  node: Root | RootContent | PhrasingContent,
  text: string,
  protectedRanges: Range[],
  segments: EditableSegment[],
  depth: number,
  bomOffset: number,
  blockId: number,
  blockCounter: { next: number },
): boolean {
  if (depth > 64) return false;
  const pos = node.position;
  if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) {
    return false;
  }
  const start = pos.start.offset + bomOffset;
  const end = pos.end.offset + bomOffset;

  // blockquote は原則保護（children の内容が引用であるため）。
  if (node.type === "blockquote") {
    protectedRanges.push({ start, end });
    return true;
  }

  if (PROTECTED_LEAVES.has(node.type)) {
    if (node.type === "html" && !SAFE_HTML.test(node.value)) {
      // 未確認の raw HTML は候補全体を skip（設計書 21.1）。
      return false;
    }
    if (node.type === "code" && !hasClosingFence(text, start, end)) {
      // 未閉じ fence は候補全体を skip（設計書 21.1）。
      return false;
    }
    protectedRanges.push({ start, end });
    return true;
  }

  if (node.type === EDITABLE_LEAF) {
    return extractTextProtections(
      start,
      end,
      text,
      protectedRanges,
      segments,
      blockId,
    );
  }

  if (EDITABLE_CONTAINERS.has(node.type)) {
    if (node.type === "link" || node.type === "linkReference") {
      // prose label（子 text）は編集可能、構文部分（括弧・destination）は保護。
      return visitLink(
        node,
        text,
        protectedRanges,
        segments,
        depth,
        bomOffset,
        blockId,
        blockCounter,
      );
    }
    // block-level container かどうか: 子を新しい block として走査するか。
    // paragraph / heading / tableCell / emphasis / strong / delete は
    // inline content の親（同一 blockId 維持）。
    // root / list / table / listItem は子 block を分ける。
    const INLINE_PARENT = new Set([
      "paragraph",
      "heading",
      "tableCell",
      "emphasis",
      "strong",
      "delete",
    ]);
    const childBlockId = INLINE_PARENT.has(node.type) ? blockId : -1;
    const children =
      (node as { children?: RootContent[] | PhrasingContent[] }).children ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      // inline の <code>…</code> / <pre>…</pre> は html + text + html に分解
      // されるため、開始タグを見つけたら対応する終了タグまでを保護する。
      if (child.type === "html") {
        // 開始・終了タグを1つの node に含む block level の code/pre。
        if (SAFE_HTML.test(child.value ?? "")) {
          const pos = child.position;
          if (
            !pos ||
            pos.start.offset === undefined ||
            pos.end.offset === undefined
          )
            return false;
          protectedRanges.push({
            start: pos.start.offset + bomOffset,
            end: pos.end.offset + bomOffset,
          });
          continue;
        }
        const openMatch = /^<(code|pre)(\s[^>]*)?>/i.exec(child.value ?? "");
        if (openMatch) {
          const closeEnd = findClosingHtmlTag(
            children,
            i,
            openMatch[1]!.toLowerCase(),
          );
          if (closeEnd === undefined) return false;
          const closePos = children[closeEnd]!.position;
          if (!closePos || closePos.end.offset === undefined) return false;
          protectedRanges.push({
            start: (child.position?.start.offset ?? 0) + bomOffset,
            end: closePos.end.offset + bomOffset,
          });
          i = closeEnd;
          continue;
        }
        if (!/^<\/(code|pre)>$/i.test(child.value ?? "")) {
          // code/pre の pair に属さない raw HTML は unsupported。
          return false;
        }
        // 孤立した終了タグは unsupported。
        return false;
      }
      const nextBlockId =
        childBlockId === -1 ? blockCounter.next++ : childBlockId;
      if (
        !visit(
          child,
          text,
          protectedRanges,
          segments,
          depth + 1,
          bomOffset,
          nextBlockId,
          blockCounter,
        )
      )
        return false;
    }
    return true;
  }

  // 未知の node 型は fail-closed。
  return false;
}

function visitLink(
  node: Extract<PhrasingContent, { type: "link" | "linkReference" }>,
  text: string,
  protectedRanges: Range[],
  segments: EditableSegment[],
  depth: number,
  bomOffset: number,
  blockId: number,
  blockCounter: { next: number },
): boolean {
  const pos = node.position;
  if (!pos || pos.start.offset === undefined || pos.end.offset === undefined)
    return false;
  const nodeStart = pos.start.offset + bomOffset;
  const nodeEnd = pos.end.offset + bomOffset;

  // prose label 部分（子 node の範囲）だけを編集可能として走査する。
  const children = node.children ?? [];
  for (const child of children) {
    if (
      !visit(
        child,
        text,
        protectedRanges,
        segments,
        depth + 1,
        bomOffset,
        blockId,
        blockCounter,
      )
    )
      return false;
  }

  // 構文部分（label 外）を保護 range 化する。
  const childRanges: Array<[number, number]> = [];
  for (const child of children) {
    const p = child.position;
    if (!p || p.start.offset === undefined || p.end.offset === undefined)
      return false;
    childRanges.push([p.start.offset + bomOffset, p.end.offset + bomOffset]);
  }
  childRanges.sort((a, b) => a[0] - b[0]);

  let cursor = nodeStart;
  for (const [cs, ce] of childRanges) {
    if (cs > cursor) {
      protectedRanges.push({ start: cursor, end: cs });
    }
    cursor = Math.max(cursor, ce);
  }
  if (nodeEnd > cursor) {
    protectedRanges.push({ start: cursor, end: nodeEnd });
  }
  return true;
}

function extractTextProtections(
  start: number,
  end: number,
  text: string,
  protectedRanges: Range[],
  segments: EditableSegment[],
  blockId: number,
): boolean {
  // mdast は escape / entity を decode するため node.value は source と
  // 長さがずれる。match index を source offset として使うため、
  // 必ず raw source slice を走査する（設計書 21.3 の byte 保持）。
  const raw = text.slice(start, end);

  // 未解決の reference link（definition なしの [x][y]）は plain text に
  // 分解される。曖昧な引用 marker 相当として候補全体を skip する
  // （正当な linkReference は AST node 型で判別するためここに到達しない）。
  if (/\[[^\]\\]*\]\[[^\]\\]*\]/.test(raw)) {
    return false;
  }

  // 「…」 / 『…』 の balance 検査（不平衡は unsupported）。
  for (const [open, close] of QUOTE_PAIRS) {
    const opens = countChar(raw, open);
    const closes = countChar(raw, close);
    if (opens !== closes) return false;
    let from = 0;
    for (let i = 0; i < opens; i++) {
      const os = raw.indexOf(open, from);
      const cs = raw.indexOf(close, os + open.length);
      if (os < 0 || cs < 0) return false;
      protectedRanges.push({
        start: start + os,
        end: start + cs + close.length,
      });
      from = cs + close.length;
    }
  }

  // URL / path / version / flag / 数値+単位 / 識別子 の保護。
  for (const { pattern, filter } of INLINE_PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      if (filter && !filter(match[0])) continue;
      const ms = start + (match.index ?? 0);
      protectedRanges.push({ start: ms, end: ms + match[0].length });
    }
  }

  segments.push({ start, end, text: text.slice(start, end), blockId });
  return true;
}

/**
 * fenced code block の閉じ fence が存在するか。
 * CommonMark では未閉じ fence は文書末まで伸びるため、node の末尾が
 * 閉じ fence で終わっていなければ未閉じと判断する。
 */
function hasClosingFence(text: string, start: number, end: number): boolean {
  const slice = text.slice(start, end);
  const lines = slice.split("\n");
  const first = lines[0]!.trim();
  const fenceMatch = /^(`{3,}|~{3,})/.exec(first);
  // indented code block には閉じ fence がない（1行でも有効）。
  if (!fenceMatch) return true;
  const fence = fenceMatch[1]!;
  // 最終行が閉じ fence（同じ文字・同長以上、後続空白のみ）か。
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    return isClosingFenceLine(line, fence);
  }
  return false;
}

/** 開始タグに対応する終了タグの children index を返す。 */
function findClosingHtmlTag(
  children: ReadonlyArray<RootContent | PhrasingContent>,
  from: number,
  tag: string,
): number | undefined {
  const lower = tag.toLowerCase();
  for (let i = from + 1; i < children.length; i++) {
    const child = children[i]!;
    if (child.type !== "html") continue;
    const value = (child.value ?? "").trim().toLowerCase();
    if (value === `</${lower}>` || new RegExp(`^</${lower}\\s+$`).test(value))
      return i;
    // 入れ子の同種タグは未対応として扱う（fail-closed は呼び出し側）。
    if (
      value.startsWith(`<${lower}`) &&
      (value === `<${lower}>` || value.startsWith(`<${lower} `))
    ) {
      return undefined;
    }
  }
  return undefined;
}

/** 先頭に frontmatter の対（--- … --- / +++ … +++)が存在するか。 */
function hasFrontmatter(text: string): boolean {
  const lines = text.split("\n");
  const first = lines[0]!.replace(/\r$/, "");
  if (!/^(---|\+\+\+)[ \t]*$/.test(first)) return false;
  const marker = first.slice(0, 3);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.replace(/\r$/, "") === marker) return true;
  }
  return false;
}

/** 行が閉じ fence（marker 同長以上 + 後続空白のみ）か。 */
function isClosingFenceLine(line: string, fence: string): boolean {
  const trimmed = line.replace(/^[ \t]+/, "");
  const marker = fence[0]!;
  let count = 0;
  while (count < trimmed.length && trimmed[count] === marker) count++;
  if (count < fence.length) return false;
  return trimmed.slice(count).trim() === "";
}

function countChar(value: string, ch: string): number {
  let count = 0;
  let idx = value.indexOf(ch);
  while (idx >= 0) {
    count++;
    idx = value.indexOf(ch, idx + ch.length);
  }
  return count;
}

/**
 * gate projection（設計書 第12.2章）。
 *
 * 編集可能 segment を原文順に連結し、保護部分を中立区切り（空行）で置換する。
 * sentinel は gate に渡さない。CLI は projection 全体に対する code point
 * offset を返すため、mapDiagnostic は global offset を受け取り、単一の
 * segment に完全に含まれる場合だけ原文 UTF-16 座標へ変換する。
 * 区切りにまたがる・segment をまたぐ診断は対応不能（gate-scope-unmappable）。
 */
export interface GateProjection {
  /** gate へ渡す本文（保護部分は中立区切り）。 */
  projection: string;
  segments: Array<{
    segmentId: string;
    /** projection 上の segment 開始 code point offset。 */
    projectionStartCp: number;
    /** projection 上の segment 終了 code point offset（排他）。 */
    projectionEndCp: number;
    /** segment 先頭の原文 UTF-16 offset。 */
    sourceStart: number;
  }>;
  /**
   * projection 全体の code point [start, end) を原文 UTF-16 [start, end) へ変換する。
   * 単一 segment に完全に含まれない場合は undefined（対応不能）。
   */
  mapDiagnostic: (
    startCp: number,
    endCp: number,
  ) => { segmentId: string; start: number; end: number } | undefined;
}

export function buildGateProjection(
  doc: Extract<EditableDocument, { supported: true }>,
): GateProjection {
  // 中立区切り: 空行。block 境界の segment 間だけ空行を入れ、同一 block 内の
  // inline 構文（strong / emphasis / link label 等）で分かれた segment は
  // 連結する（検査文脈を壊さない。設計書 12.2 の gate projection）。
  const SEPARATOR = "\n\n";
  const SEPARATOR_CP = [...SEPARATOR].length;
  let projection = "";
  const segments: GateProjection["segments"] = [];
  const sourceSegments = doc.segments;
  let cpOffset = 0;
  let prevBlockId = -1;

  for (let i = 0; i < sourceSegments.length; i++) {
    const segment = sourceSegments[i]!;
    // 同一 block 内の inline 分割（strong / emphasis / link label 等）は
    // 連結し、block が変わる場所だけ空行区切りを入れる。
    const sameBlock = segment.blockId === prevBlockId;
    if (!sameBlock && i > 0) {
      projection += SEPARATOR;
      cpOffset += SEPARATOR_CP;
    }
    segments.push({
      segmentId: `s${i}`,
      projectionStartCp: cpOffset,
      projectionEndCp: cpOffset + [...segment.text].length,
      sourceStart: segment.start,
    });
    projection += segment.text;
    cpOffset += [...segment.text].length;
    prevBlockId = segment.blockId;
  }

  return {
    projection,
    segments,
    mapDiagnostic: (startCp, endCp) => {
      if (!Number.isInteger(startCp) || !Number.isInteger(endCp))
        return undefined;
      if (startCp < 0 || endCp <= startCp) return undefined;
      const seg = segments.find(
        (s) => startCp >= s.projectionStartCp && endCp <= s.projectionEndCp,
      );
      if (!seg) return undefined;
      const text = sourceSegments[Number(seg.segmentId.slice(1))]!.text;
      const localStart = startCp - seg.projectionStartCp;
      const localEnd = endCp - seg.projectionStartCp;
      return {
        segmentId: seg.segmentId,
        start: seg.sourceStart + codePointOffsetToUtf16(text, localStart),
        end: seg.sourceStart + codePointOffsetToUtf16(text, localEnd),
      };
    },
  };
}

/** 保護 range を原文順に sort し、重なりを併合する（設計書 21.3）。 */
function mergeRanges(spans: Range[]): Range[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/** segment から保護 range を引いた非空部分を編集可能 segment として残す。 */
function subtractSegments(
  segments: EditableSegment[],
  protectedRanges: ProtectedSpan[],
): EditableSegment[] {
  const result: EditableSegment[] = [];
  for (const segment of segments) {
    let cursor = segment.start;
    const overlaps = protectedRanges.filter(
      (r) => r.end > cursor && r.start < segment.end,
    );
    for (const r of overlaps) {
      if (r.start > cursor) {
        result.push({
          start: cursor,
          end: r.start,
          text: segment.text.slice(
            cursor - segment.start,
            r.start - segment.start,
          ),
          blockId: segment.blockId,
        });
      }
      cursor = Math.max(cursor, r.end);
    }
    if (cursor < segment.end) {
      result.push({
        start: cursor,
        end: segment.end,
        text: segment.text.slice(cursor - segment.start),
        blockId: segment.blockId,
      });
    }
  }
  return result;
}
