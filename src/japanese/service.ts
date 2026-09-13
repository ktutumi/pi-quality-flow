/**
 * checkJapanese() — 日本語検証 service（設計書 第12.2章・Issue #6）。
 *
 * 手動 `/quality japanese check` と自動 validation-only gate の共通 service。
 * EditableDocument で Markdown 構造（fence / inline code / 表 / task list /
 * 引用 / URL / version 等）を保護し、編集可能 prose だけを gate に渡す
 * （gate projection は pre/post 各1回の CLI 呼び出しに使う）。
 *
 * モデル要求・追加 Executor ターンは 0 回。CLI 失敗時は原文維持の情報のみ返す。
 */
import { detectJapaneseProse } from "./japanese-detect.ts";
import { buildGateProjection, prepareEditableDocument } from "./editable-document.ts";
import { codePointOffsetToUtf16, normalizeDiagnostic, type GateDiagnostic } from "../jpqg/diagnostics.ts";
import type { GateScore } from "../jpqg/score.ts";
import { PINNED_GATE_SHA256, runGate, verifyExecutableDigest, type GateFailureCode } from "../jpqg/runner.ts";
import type { ParsedGateReport } from "../jpqg/schema.ts";

/** 編集可能 prose の診断（原文座標、UTF-16 code unit）。 */
export interface ProseDiagnostic extends GateDiagnostic {
  message: string;
}

export type CheckStatus = "pass" | "fail" | "skipped";

export interface GateCheck {
  status: CheckStatus;
  scope: "editable-prose";
  /** status=skipped の理由。 */
  reason?: "no-editable-japanese" | "unsupported-structure" | "gate-scope-unmappable";
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
 * gate report の診断を原文座標へ対応付ける（副作用のない純粋関数）。
 *
 * wire の code point offset を projection → segment → 原文 UTF-16 へ変換し、
 * wire.text が対応する projection slice と一致しない診断は対応不能
 * （gate-scope-unmappable）として拒否する（設計書 第12.2章の fail-closed）。
 */
export type GateDiagnosticsResult =
  | { ok: true; diagnostics: ProseDiagnostic[] }
  | { ok: false; reason: "gate-scope-unmappable" };

export function mapGateDiagnostics(
  doc: Extract<ReturnType<typeof prepareEditableDocument>, { supported: true }>,
  projection: ReturnType<typeof buildGateProjection>,
  report: ParsedGateReport,
): GateDiagnosticsResult {
  const diagnostics: ProseDiagnostic[] = [];
  for (const wire of report.issues) {
    const mapped = projection.mapDiagnostic(wire.start, wire.end);
    if (!mapped) {
      return { ok: false, reason: "gate-scope-unmappable" };
    }
    // wire.text が対応する projection slice と一致することを確認する
    // （座標が範囲内でも text が不一致なら対応不能。fail-closed）。
    const slice = projection.projection.slice(
      codePointOffsetToUtf16(projection.projection, wire.start),
      codePointOffsetToUtf16(projection.projection, wire.end),
    );
    if (slice !== wire.text) {
      return { ok: false, reason: "gate-scope-unmappable" };
    }
    const segmentIndex = projection.segments.findIndex((s) => s.segmentId === mapped.segmentId);
    const projectionSegment = projection.segments[segmentIndex];
    const segmentText = doc.segments[segmentIndex]?.text;
    if (!projectionSegment || segmentText === undefined) {
      return { ok: false, reason: "gate-scope-unmappable" };
    }
    const localStartCp = wire.start - projectionSegment.projectionStartCp;
    const localEndCp = wire.end - projectionSegment.projectionStartCp;
    try {
      const normalized = normalizeDiagnostic(
        { ...wire, start: localStartCp, end: localEndCp },
        segmentText,
        mapped.segmentId,
      );
      // 診断の原文座標は projection の対応結果（UTF-16）を使う。
      diagnostics.push({
        ...normalized,
        start: mapped.start,
        end: mapped.end,
        message: wire.message,
      });
    } catch {
      return { ok: false, reason: "gate-scope-unmappable" };
    }
  }
  return { ok: true, diagnostics };
}

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

  // Markdown 構造を parse し、編集可能 prose と保護 span を分離する
  // （Issue #6: EditableDocument）。対応不能構造は候補全体を skip。
  const doc = prepareEditableDocument(text);
  if (!doc.supported) {
    return skipped("unsupported-structure");
  }

  // 英語のみ・コードのみ・保護引用のみは gate に渡さない。
  // 編集可能 CJK-only は gate に渡す（Issue #6 の受け入れ基準）。
  const editableText = doc.segments.map((s) => s.text).join("");
  if (!detectJapaneseProse(editableText)) {
    return skipped("no-editable-japanese");
  }

  const projection = buildGateProjection(doc);
  const run = await runGate({
    executable,
    input: projection.projection,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (!run.ok) {
    return { ok: false, code: run.code, message: run.message };
  }

  const mappedDiagnostics = mapGateDiagnostics(doc, projection, run.report);
  if (!mappedDiagnostics.ok) {
    return skipped(mappedDiagnostics.reason);
  }
  const diagnostics = mappedDiagnostics.diagnostics;

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

function skipped(
  reason: "no-editable-japanese" | "unsupported-structure" | "gate-scope-unmappable",
): CheckJapaneseResult {
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
