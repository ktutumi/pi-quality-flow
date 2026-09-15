/**
 * Sentinel 保護と復元（設計書 第21.2・21.3章、Issue #8）。
 *
 * Formatter への request は編集可能 segment だけを露出する。segment 以外の
 * 全範囲（保護 span と Markdown 構文の境界・区切り）は request 固有 nonce の
 * sentinel に置き換える。これにより Formatter は保護領域も Markdown 境界も
 * 物理的に変更できない（露出した本文だけが編集対象）。
 *
 * 復元は送信前に取った immutable map だけから行う。モデル出力内の保護内容・
 * sentinel の再現は信用しない。欠落・重複・改変・未知 token・順序変更は
 * すべて拒否する（設計書 第21.2章）。
 */
import { randomBytes } from "node:crypto";

/** sentinel token の共通 prefix。原文にこの列が現れたら候補全体を拒否する。 */
export const SENTINEL_PREFIX = "⟦PQF_PROTECTED_";

export interface SentinelRange {
  /** 原文 UTF-16 offset 区間（送信前に固定した immutable map の要素）。 */
  start: number;
  end: number;
  /** 復元する原文の部分列（保護 byte 列 + Markdown 区切りを含む）。 */
  text: string;
}

/** Formatter request の本文と、復元に使う immutable map。 */
export interface ProtectedRequest {
  /** sentinel と編集可能 segment のみで構成された request 本文。 */
  text: string;
  /** index 順の sentinel 範囲（document 順）。 */
  ranges: SentinelRange[];
  /** index 順の sentinel token。 */
  tokens: string[];
}

export type ProtectedRequestFailure = "sentinel-collision" | "request-too-large";

/** request 固有の sentinel token。nonce は request ごとに新しくする。 */
export function sentinelToken(nonce: string, index: number): string {
  return `${SENTINEL_PREFIX}${nonce}_${index}⟧`;
}

/** request 固有の nonce（cryptographically random）。 */
export function newSentinelNonce(): string {
  return randomBytes(12).toString("hex");
}

export type BuildProtectedRequestResult =
  | { ok: true; request: ProtectedRequest }
  | { ok: false; code: ProtectedRequestFailure };

/**
 * 編集可能 segment 以外の全範囲を sentinel 化した request を組み立てる。
 *
 * - 原文に sentinel prefix が含まれる場合は衝突として拒否する（第21.2章）
 * - 範囲は原文 UTF-16 offset で保持し、復元で元の byte 列を完全に再現する
 *   （全文の Unicode 正規化は行わない）
 * - request 本文の UTF-8 byte 長が上限を超えたら拒否する（切り詰めない）
 */
export function buildProtectedRequest(input: {
  source: string;
  segments: ReadonlyArray<{ start: number; end: number; text: string }>;
  maxRequestBytes: number;
  /** テスト注入用。省略時は crypto.randomBytes。 */
  nonce?: string;
}): BuildProtectedRequestResult {
  const { source, maxRequestBytes } = input;
  if (source.includes(SENTINEL_PREFIX)) {
    return { ok: false, code: "sentinel-collision" };
  }
  const sorted = [...input.segments].sort((a, b) => a.start - b.start);

  // document 頒に gap（保護 span と Markdown 構文・区切り）と segment を交互に
  // 並べる。gap と segment の個数は 1:1 に対応しないため、part 列で出力順を
  // 決める（先頭・末尾の gap も元の位置に保つ）。
  type Part = { kind: "gap"; range: SentinelRange } | { kind: "seg"; text: string };
  const parts: Part[] = [];
  const gaps: SentinelRange[] = [];
  let cursor = 0;
  const pushGap = (end: number): void => {
    const range: SentinelRange = { start: cursor, end, text: source.slice(cursor, end) };
    gaps.push(range);
    parts.push({ kind: "gap", range });
  };
  for (const segment of sorted) {
    if (segment.start < cursor) {
      // 重なる segment は EditableDocument の不変条件違反。fail-closed。
      return { ok: false, code: "sentinel-collision" };
    }
    if (segment.start > cursor) pushGap(segment.start);
    cursor = Math.max(cursor, segment.end);
    parts.push({ kind: "seg", text: segment.text });
  }
  if (cursor < source.length) pushGap(source.length);

  const nonce = input.nonce ?? newSentinelNonce();
  const tokens = gaps.map((_, index) => sentinelToken(nonce, index));

  // request 本文: gap を sentinel に置き換え、segment の本文だけを露出する。
  let gapIndex = 0;
  let text = "";
  for (const part of parts) {
    text += part.kind === "gap" ? tokens[gapIndex++] : part.text;
  }

  if (Buffer.byteLength(text, "utf8") > maxRequestBytes) {
    return { ok: false, code: "request-too-large" };
  }
  return { ok: true, request: { text, ranges: gaps, tokens } };
}

export type SentinelVerification =
  | { ok: true; restored: string }
  | {
      ok: false;
      code: "sentinel-missing" | "sentinel-duplicate" | "sentinel-unknown" | "sentinel-out-of-order";
    };

/**
 * モデル出力から sentinel を検査して復元する（副作用のない純粋関数）。
 *
 * - 集合・個数: 各 token がちょうど1回現れること。不足は missing、複数回は duplicate
 * - 改変・未知: prefix の出現はすべて有効な token であること（切れた・別 nonce・
 *   index 範囲外は unknown）
 * - 順序: token index の document 順が保存されていること（out-of-order）
 * - 復元: immutable map（ranges）だけを使う。出力内の保護内容は参照しない
 */
interface SentinelOccurrence {
  /** token index（未知 token は -1）。 */
  index: number;
  position: number;
  token: string;
}

/** prefix の全出現を収集する（切れた・別 nonce の token は unknown に分類）。 */
function scanOccurrences(output: string, byToken: Map<string, number>):
  | { ok: true; occurrences: SentinelOccurrence[] }
  | { ok: false; code: "sentinel-unknown" } {
  const occurrences: SentinelOccurrence[] = [];
  let from = 0;
  for (;;) {
    const at = output.indexOf(SENTINEL_PREFIX, from);
    if (at === -1) break;
    let token: string | undefined;
    for (const candidate of byToken.keys()) {
      if (output.startsWith(candidate, at)) {
        token = candidate;
        break;
      }
    }
    if (token === undefined) return { ok: false, code: "sentinel-unknown" };
    const index = byToken.get(token);
    if (index === undefined) return { ok: false, code: "sentinel-unknown" };
    occurrences.push({ index, position: at, token });
    from = at + SENTINEL_PREFIX.length;
  }
  return { ok: true, occurrences };
}

/** 集合・個数・順序の検査（設計書 第21.2章）。 */
function checkMultiplicityAndOrder(
  occurrences: SentinelOccurrence[],
  tokenCount: number,
): { ok: true } | { ok: false; code: Exclude<SentinelVerification, { ok: true }>["code"] } {
  const seen = new Map<number, number>();
  for (const occurrence of occurrences) {
    seen.set(occurrence.index, (seen.get(occurrence.index) ?? 0) + 1);
  }
  for (let i = 0; i < tokenCount; i++) {
    const count = seen.get(i) ?? 0;
    if (count === 0) return { ok: false, code: "sentinel-missing" };
    if (count > 1) return { ok: false, code: "sentinel-duplicate" };
  }
  let lastPosition = -1;
  let lastIndex = -1;
  for (const occurrence of occurrences) {
    if (occurrence.position < lastPosition || occurrence.index <= lastIndex) {
      return { ok: false, code: "sentinel-out-of-order" };
    }
    lastPosition = occurrence.position;
    lastIndex = occurrence.index;
  }
  return { ok: true };
}

export function verifyAndRestore(
  output: string,
  request: Pick<ProtectedRequest, "ranges" | "tokens">,
): SentinelVerification {
  const byToken = new Map<string, number>();
  request.tokens.forEach((token, index) => byToken.set(token, index));

  const scanned = scanOccurrences(output, byToken);
  if (!scanned.ok) return scanned;
  const checked = checkMultiplicityAndOrder(scanned.occurrences, request.tokens.length);
  if (!checked.ok) return checked;

  // 復元: immutable map の範囲だけを使う（document 順に置換）。
  let restored = "";
  let cursor = 0;
  for (const occurrence of scanned.occurrences) {
    restored += output.slice(cursor, occurrence.position);
    restored += request.ranges[occurrence.index].text;
    cursor = occurrence.position + occurrence.token.length;
  }
  restored += output.slice(cursor);
  return { ok: true, restored };
}
