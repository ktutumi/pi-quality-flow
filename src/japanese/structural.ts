/**
 * 復元後の構造不変条件（設計書 第22.1章、Issue #8）。
 *
 * 復元した全文を EditableDocument として再 parse し、原文と同じ構造で
 * あることを検査する。検査は相互に独立した比較にする:
 *
 * 1. 復元文が対応構造として parse できること（unsupported なら拒否）
 * 2. 保護 span の byte 列一致（実装の sentinel 復元とは独立に、再 parse した
 *    span と原文の span を文字列比較する）
 * 3. 編集可能 segment の個数と所属 block の対応関係
 * 4. Markdown 構造 fingerprint（見出し・list・table・block 境界の変更を拒否）
 */
import type { Root, RootContent, PhrasingContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  MDAST_PARSE_OPTIONS,
  prepareEditableDocument,
  type EditableSegment,
} from "./editable-document.ts";

export type StructuralCode =
  | "unsupported-structure"
  | "protected-span-changed"
  | "segment-count-changed"
  | "block-boundary-changed"
  | "structure-changed";

export type StructuralCheckResult =
  | { ok: true; doc: SupportedDoc }
  | { ok: false; code: StructuralCode };

type SupportedDoc = Extract<ReturnType<typeof prepareEditableDocument>, { supported: true }>;

export function verifyRestoredStructure(
  original: SupportedDoc,
  restoredText: string,
): StructuralCheckResult {
  const corrected = prepareEditableDocument(restoredText);
  if (!corrected.supported) {
    return { ok: false, code: "unsupported-structure" };
  }

  // 保護 span の byte 列一致（設計書 第22.1章: 元の UTF-8 byte 列と一致）。
  if (corrected.protectedSpans.length !== original.protectedSpans.length) {
    return { ok: false, code: "protected-span-changed" };
  }
  for (let i = 0; i < original.protectedSpans.length; i++) {
    if (corrected.protectedSpans[i].text !== original.protectedSpans[i].text) {
      return { ok: false, code: "protected-span-changed" };
    }
  }

  // 編集可能 segment の個数と所属 block の対応関係（第21.2章: 所属構造の維持）。
  if (corrected.segments.length !== original.segments.length) {
    return { ok: false, code: "segment-count-changed" };
  }
  const originalBoundaries = blockBoundarySequence(original.segments);
  const correctedBoundaries = blockBoundarySequence(corrected.segments);
  for (let i = 0; i < originalBoundaries.length; i++) {
    if (originalBoundaries[i] !== correctedBoundaries[i]) {
      return { ok: false, code: "block-boundary-changed" };
    }
  }

  // Markdown 構造 fingerprint（見出し・list・table・block 境界）。
  const originalFingerprint = structureFingerprint(original.source);
  const correctedFingerprint = structureFingerprint(restoredText);
  if (originalFingerprint === undefined || correctedFingerprint === undefined) {
    return { ok: false, code: "structure-changed" };
  }
  if (originalFingerprint !== correctedFingerprint) {
    return { ok: false, code: "structure-changed" };
  }
  return { ok: true, doc: corrected };
}

/** 隣接 segment の所属 block の対応関係（同じ block 内かどうかの系列）。 */
function blockBoundarySequence(segments: EditableSegment[]): boolean[] {
  const sequence: boolean[] = [];
  for (let i = 1; i < segments.length; i++) {
    sequence.push(segments[i].blockId === segments[i - 1].blockId);
  }
  return sequence;
}

/**
 * Markdown 構造の fingerprint。node の型と構造上の性質だけを並べ、
 * text leaf の内容は含めない（内容の比較は意味リスク検査で行う）。
 * 深度を含めることで入れ子構造の変化も検出する。
 */
export function structureFingerprint(text: string): string | undefined {
  let root: Root;
  try {
    root = fromMarkdown(text, MDAST_PARSE_OPTIONS);
  } catch {
    return undefined;
  }
  const entries: string[] = [];
  walk(root, 0, entries);
  return entries.join("\u0001");
}

function walk(node: Root | RootContent | PhrasingContent, depth: number, out: string[]): void {
  let entry = `${depth}:${node.type}`;
  if (node.type === "heading") entry += `:${(node as { depth?: number }).depth ?? ""}`;
  if (node.type === "list") entry += `:${(node as { ordered?: boolean }).ordered ? "o" : "u"}`;
  if (node.type === "listItem") {
    const checked = (node as { checked?: boolean | null }).checked;
    let mark = "-";
    if (checked === true) mark = "x";
    else if (checked === false) mark = "o";
    entry += `:${mark}`;
  }
  out.push(entry);
  const children = (node as { children?: RootContent[] | PhrasingContent[] }).children;
  if (Array.isArray(children)) {
    for (const child of children) walk(child, depth + 1, out);
  }
}
