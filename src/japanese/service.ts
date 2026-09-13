/**
 * checkJapanese() — 日本語検証 service（設計書 第12・30章）。
 *
 * 手動 `/quality japanese check` と自動 validation-only gate の共通 service。
 * Issue #3 の範囲は「対応可能な平文」のみ。Markdown 構造（fence / inline code /
 * 表 / task list）の保護と source map は Issue #6（EditableDocument）の領域であり、
 * この段階では構造を含む候補全体を unsupported-structure として skip する。
 *
 * モデル要求・追加 Executor ターンは 0 回。CLI 失敗時は原文維持の情報のみ返す。
 */
import { detectJapaneseProse } from "./japanese-detect.ts";
import { normalizeDiagnostic, type GateDiagnostic } from "../jpqg/diagnostics.ts";
import type { GateScore } from "../jpqg/score.ts";
import { PINNED_GATE_SHA256, runGate, verifyExecutableDigest, type GateFailureCode } from "../jpqg/runner.ts";

/** 編集可能 prose の診断（原文座標、UTF-16 code unit）。 */
export interface ProseDiagnostic extends GateDiagnostic {
  message: string;
}

export type CheckStatus = "pass" | "fail" | "skipped";

export interface GateCheck {
  status: CheckStatus;
  scope: "editable-prose";
  /** status=skipped の理由。 */
  reason?: "no-editable-japanese" | "unsupported-structure";
  diagnostics: ProseDiagnostic[];
  score: GateScore;
  binaryVersion?: string;
  /** 診断の完全性が不明な場合の理由（採用判断には使えない）。 */
  incomplete?: "gate-diagnostics-incomplete";
}

export type CheckJapaneseResult =
  | { ok: true; check: GateCheck }
  | { ok: false; code: GateFailureCode; message?: string };

export interface CheckJapaneseOptions {
  text: string;
  executable: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Issue #3 で扱えない構造。Issue #6 の EditableDocument が引き継ぐ。
 * 保守的な fail-closed: 構造の可能性があれば候補全体を skip する。
 * - fence / inline code: ` ``
 * - blockquote: 行頭の `>`
 * - raw HTML: `<tag>`
 * - link / image: `](...)`
 * - 表: `|`
 */
const UNSUPPORTED_STRUCTURE =
  /```|`|^>[ \t]?|<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?>|\]\([^)]*\)|\|/m;

export async function checkJapanese(options: CheckJapaneseOptions): Promise<CheckJapaneseResult> {
  const { text, executable } = options;

  // 検証済み executable のみを実行する（fail-closed）。
  const digest = await verifyExecutableDigest(executable, PINNED_GATE_SHA256);
  if (!digest.ok) {
    return {
      ok: false,
      code: digest.code,
      message: `executable digest check failed: ${executable}`,
    };
  }

  // 構造の有無を先に判定する（Issue #6 前の平文限定スコープ）。
  if (UNSUPPORTED_STRUCTURE.test(text)) {
    return skipped("unsupported-structure");
  }

  // 英語のみ・コードのみ・記号のみは gate に渡さない。
  if (!detectJapaneseProse(text)) {
    return skipped("no-editable-japanese");
  }

  const run = await runGate({
    executable,
    input: text,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (!run.ok) {
    return { ok: false, code: run.code, message: run.message };
  }

  // 単一 segment（segmentId "s0"）として原文全体を検査する。
  // 診断の code point offset を原文座標（UTF-16）へ変換する。
  const diagnostics: ProseDiagnostic[] = [];
  for (const wire of run.report.issues) {
    try {
      const normalized = normalizeDiagnostic(wire, text, "s0");
      diagnostics.push({ ...normalized, message: wire.message });
    } catch {
      // 座標の対応が不能な場合は検査を無効とする（採用判断に使わない）。
      return skipped("unsupported-structure");
    }
  }

  // Unihan 診断が50件に達したら全文を表さないため採用判断に使えない
  // （設計書 第15.1章 gate-diagnostics-incomplete）。
  const UNIHAN_RULES = new Set(["simplified_chinese_form", "chinese_han_without_japanese_source"]);
  const unihanCount = diagnostics.filter((d) => UNIHAN_RULES.has(d.ruleId)).length;
  const incomplete = unihanCount >= 50 ? ("gate-diagnostics-incomplete" as const) : undefined;

  return {
    ok: true,
    check: {
      status: run.report.status,
      scope: "editable-prose",
      diagnostics,
      score: run.report.score,
      binaryVersion: run.report.binaryVersion,
      incomplete,
    },
  };
}

function skipped(reason: "no-editable-japanese" | "unsupported-structure"): CheckJapaneseResult {
  return {
    ok: true,
    check: {
      status: "skipped",
      scope: "editable-prose",
      reason,
      diagnostics: [],
      score: { errors: 0, warnings: 0 },
    },
  };
}
