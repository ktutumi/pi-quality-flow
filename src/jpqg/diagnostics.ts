/**
 * 診断の正規化（設計書 第15.1章）。
 *
 * CLI wire format の Issue（code point offset）を内部 DTO
 * （UTF-16 code unit offset、segmentId 付き）へ変換する。
 * wire と DTO を分離し、CLI の schema 変更をここに閉じ込める。
 */

/** jp-quality-gate の JSON issue（wire format）。offset は code point。 */
export interface WireIssue {
  rule: string;
  severity: string;
  message: string;
  start: number;
  end: number;
  text: string;
  line: number;
  column: number;
  details: Record<string, unknown>;
}

/** 内部 DTO（schemaVersion 1）。offset は UTF-16 code unit。 */
export interface GateDiagnostic {
  ruleId: string;
  severity: "error" | "warning";
  segmentId: string;
  issueKey: string;
  start: number;
  end: number;
}

/** code point offset を UTF-16 code unit offset に変換する。 */
export function codePointOffsetToUtf16(
  text: string,
  start: number,
  end?: number,
): number | [number, number] {
  if (end === undefined) {
    return [...text].slice(0, start).reduce((n, ch) => n + ch.length, 0);
  }
  return [codePointOffsetToUtf16(text, start) as number, codePointOffsetToUtf16(text, end) as number];
}

/**
 * wire issue を内部 DTO へ正規化する。
 * offset が原文の code point 数を超える場合は拒否する（座標の曖昧さは
 * 保守的に失敗させる。設計書 第12.2章 gate-scope-unmappable の原則）。
 */
export function normalizeDiagnostic(wire: WireIssue, segmentText: string, segmentId: string): GateDiagnostic {
  const codePoints = [...segmentText].length;
  if (
    !Number.isInteger(wire.start) ||
    !Number.isInteger(wire.end) ||
    wire.start < 0 ||
    wire.end <= wire.start ||
    wire.end > codePoints
  ) {
    throw new RangeError(`diagnostic offset out of range: start=${wire.start} end=${wire.end} codePoints=${codePoints}`);
  }
  const [start, end] = codePointOffsetToUtf16(segmentText, wire.start, wire.end) as [number, number];
  return {
    ruleId: wire.rule,
    severity: wire.severity === "error" ? "error" : "warning",
    segmentId,
    // issueKey は rule + 該当テキスト + details の安定な識別。raw offset では照合しない
    // （設計書 第16.2章）。details は key 順に JSON 化して multiset 照合に使う。
    issueKey: `${wire.rule}\u0000${wire.text}\u0000${stableDetails(wire.details)}`,
    start,
    end,
  };
}

function stableDetails(details: Record<string, unknown>): string {
  const keys = Object.keys(details).sort();
  const parts = keys.map((key) => `${key}=${stringify(details[key])}`);
  return parts.join("\u0001");
}

function stringify(value: unknown): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(stringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return stableDetails(value as Record<string, unknown>);
  }
  return String(value);
}
