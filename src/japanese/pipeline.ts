/**
 * Japanese Formatter pipeline（設計書 第12.1章、Issue #8）。
 *
 * pre gate の後の編成:
 *
 *   sentinel 保護 → Formatter（最大1回）→ sentinel 検査と復元
 *   → 構造不変条件 → 意味変更リスク検査 → post gate（同じ scope と policy）
 *   → decideAdoption
 *
 * - Formatter request には編集可能 segment だけを露出し、保護領域と Markdown
 *   境界は request 固有 sentinel に置き換える（src/japanese/sentinel.ts）
 * - 復元は送信前の immutable map だけで行い、保護 byte 列・構造・意味リスクの
 *   検査を通った修正案だけを採用する。安全そうな部分だけの抽出はしない
 * - stage の障害（backend / post gate）は ok:false で返し、修正案の拒否は
 *   ok:true + adopted undefined で返す。採用判断は decideAdoption に集約する
 */
import type { JapaneseConfig } from "../config/schema.ts";
import type { FormatterRequest, FormatterResult, FormatterUsage } from "../formatter/backend.ts";
import { TECH_MINIMAL_PROMPT } from "../formatter/prompt.ts";
import type { AdoptionDecision } from "./adoption.ts";
import { decideAdoption } from "./adoption.ts";
import { prepareEditableDocument } from "./editable-document.ts";
import { buildProtectedRequest, verifyAndRestore } from "./sentinel.ts";
import { verifySemanticRisk } from "./semantic-risk.ts";
import { verifyRestoredStructure } from "./structural.ts";
import { checkJapanese, type GateCheck } from "./service.ts";

/** backend が満たすべき最小の形（StatelessApiBackend と構造的に適合）。 */
export interface FormatterBackendLike {
  isReady(): boolean;
  rewrite(request: FormatterRequest): Promise<FormatterResult>;
}

export interface FormatterPipelineInput {
  candidateId: string;
  originalText: string;
  /** pre gate の結果（status pass/fail、診断完全とする。skipped は呼び出し前弾き）。 */
  preGate: GateCheck;
  /** Formatter stage の signal（deadline / user cancel / 無効化）。 */
  signal?: AbortSignal;
  /** Formatter stage の許可時間（ms）。post gate は残り時間で実行する。 */
  timeoutMs?: number;
}

export interface FormatterPipelineContext {
  backend: FormatterBackendLike;
  /** post gate に使う検証済み gate executable。 */
  executable: string;
  config: JapaneseConfig;
  /** テスト注入用。省略時は本物の checkJapanese。 */
  checkJapaneseFn?: typeof checkJapanese;
  /**
   * model request の開始直前に呼ぶ（設計書 第18章: Formatter attempt は
   * request を開始する前に記録する）。実 backend request が出ることだけを
   * 記録するため、request 前打ち切りの誤記録を防ぐ。 */
  onRequestStart?: (candidateId: string) => void;
}

export type FormatterPipelineResult =
  | {
      ok: true;
      /** 採用本文。undefined は原文維持（decideAdoption または無変更）。 */
      adopted?: string;
      decision?: AdoptionDecision;
      /** provenance 記録用の実行情報（本文を含まない）。 */
      run: FormatterRunRecord;
    }
  | { ok: false; code: string; message?: string; run: FormatterRunRecord };

/**
 * provenance 記録（本文とは別記録。hash と回数・利用量のみ。本文・診断対象文字列は含まない）。
 */
export interface FormatterRunRecord {
  candidateId: string;
  /** model request を開始したか（障害・拒否も回数に含める）。 */
  requested: boolean;
  /** Formatter backend の障害 code（成功時・gate 障害時は undefined）。 */
  backendCode?: string;
  /** post gate CLI の障害 code（stage 障害のときのみ）。 */
  postGateCode?: string;
  model?: string;
  usage?: FormatterUsage;
  /** request 本文の UTF-8 byte 長（sentinel を含む）。 */
  requestBytes?: number;
  decision?: AdoptionDecision;
  /** 処理時間（ms）。 */
  latencyMs?: number;
  /** 採用判断に使った pre/post gate の検証状態（score のみ。診断本文は含まない）。 */
  preCheck?: { status: string; score: { errors: number; warnings: number } };
  postCheck?: { status: string; score: { errors: number; warnings: number } };
}

/** request 前の拒否・無変更など、採用判断に至らない終了（原文維持）。 */
function unchanged(reason: string, candidateId: string): FormatterPipelineResult {
  return {
    ok: true,
    adopted: undefined,
    run: { candidateId, requested: false, decision: { result: "original", reason, verification: "pre" } },
  };
}

/** 不合格の修正案の拒否（原文維持、model request は実行済み）。決定表第3行を
 *  decideAdoption に通して判断する（ロジックを pipeline 側に複製しない）。 */
function rejectedProposal(
  invariantViolation: string,
  input: FormatterPipelineInput,
  context: FormatterPipelineContext,
  finishRun: (base: Omit<FormatterRunRecord, "candidateId" | "latencyMs" | "preCheck">) => FormatterRunRecord,
  requested: Pick<FormatterRunRecord, "requested" | "backendCode" | "model" | "usage" | "requestBytes">,
): FormatterPipelineResult {
  const decision = decideAdoption({
    pre: input.preGate,
    invariantViolation,
    config: context.config.adoption,
  });
  return {
    ok: true,
    run: finishRun({ ...requested, decision }),
  };
}

export async function runFormatterPipeline(
  input: FormatterPipelineInput,
  context: FormatterPipelineContext,
): Promise<FormatterPipelineResult> {
  const { candidateId, originalText, signal } = input;
  const startedAt = Date.now();
  const preCheck = { status: input.preGate.status, score: { ...input.preGate.score } };
  const finishRun = (
    base: Omit<FormatterRunRecord, "candidateId" | "latencyMs" | "preCheck">,
  ): FormatterRunRecord => ({ candidateId, latencyMs: Date.now() - startedAt, preCheck, ...base });

  // 編集可能範囲の解析（pre gate と同じ EditableDocument）。
  const doc = prepareEditableDocument(originalText);
  if (!doc.supported) {
    return unchanged("unsupported-structure", candidateId);
  }

  const protectedRequest = buildProtectedRequest({
    source: originalText,
    segments: doc.segments,
    maxRequestBytes: context.config.formatter.maxInputBytes,
  });
  if (!protectedRequest.ok) {
    return unchanged(protectedRequest.code, candidateId);
  }
  if (signal?.aborted) {
    return { ok: false, code: "aborted", run: finishRun({ requested: false }) };
  }

  // Formatter request（回答候補あたり最大1回。失敗でも再要求しない）。
  // 試行は request の開始直前に記録する（第18章）。
  context.onRequestStart?.(candidateId);
  const rewrite = await context.backend.rewrite({
    systemPrompt: TECH_MINIMAL_PROMPT,
    text: protectedRequest.request.text,
    signal,
    maxOutputBytes: context.config.formatter.maxOutputBytes,
  });
  const requested: Pick<FormatterRunRecord, "requested" | "backendCode" | "model" | "usage" | "requestBytes"> = {
    requested: true,
    requestBytes: Buffer.byteLength(protectedRequest.request.text, "utf8"),
  };
  if (!rewrite.ok) {
    // backend 障害・中断。post gate は開始しない（Formatter 障害時は post 0回）。
    return {
      ok: false,
      code: `formatter-${rewrite.code}`,
      message: rewrite.detail,
      run: finishRun({ ...requested, backendCode: rewrite.code }),
    };
  }
  requested.model = rewrite.model;
  requested.usage = rewrite.usage;

  // sentinel 検査と復元（第21.2・21.3章: 衝突・集合・個数・順序・所属の検査）。
  const restoredCheck = verifyAndRestore(rewrite.text, protectedRequest.request);
  if (!restoredCheck.ok) {
    return rejectedProposal(restoredCheck.code, input, context, finishRun, requested);
  }
  const restored = restoredCheck.restored;

  // 復元後の構造不変条件（保護 byte 列・segment 対応・Markdown 構造）。
  const structural = verifyRestoredStructure(doc, restored);
  if (!structural.ok) {
    return rejectedProposal(structural.code, input, context, finishRun, requested);
  }

  // 意味変更リスク検査（否定・助詞・変更量・レビュー文・文境界）。
  // 記録する reason は code のみ（detail は変更文字を含むため本文と同様に保存しない）。
  const semantic = verifySemanticRisk(doc, structural.doc);
  if (!semantic.ok) {
    return rejectedProposal(semantic.code, input, context, finishRun, requested);
  }

  // 無変更は post gate を実行しない（CLI 呼び出しの上限は pre/post 各最大1回）。
  // 修正案が原文と同一であることは決定表第7行の「同一本文なら unchanged」に
  // 当たるため、ここで原文維持として打ち切る（post gate 省略）。
  if (restored === originalText) {
    return {
      ok: true,
      run: finishRun({
        ...requested,
        decision: { result: "original", reason: "no-change", verification: "pre" },
      }),
    };
  }

  // post gate（同じ scope と policy）。stage の残り時間で実行する。
  if (signal?.aborted) {
    return { ok: false, code: "aborted", run: finishRun(requested) };
  }
  const postTimeoutMs = postGateTimeoutMs(input.timeoutMs, startedAt, context.config.gate.timeoutMs);
  if (postTimeoutMs === undefined) {
    return { ok: false, code: "post-gate-deadline", run: finishRun(requested) };
  }
  const post = await (context.checkJapaneseFn ?? checkJapanese)({
    text: restored,
    executable: context.executable,
    timeoutMs: postTimeoutMs,
    signal,
  });
  if (!post.ok) {
    // CLI 障害（timeout / 不正 JSON / exit 矛盾等）は stage 障害。
    // 原文維持・post 再実行なし・後続処理なし（第26.3章）。中断は
    // signal 経由で再分類される（deadline / cancelled）。
    return {
      ok: false,
      code: `post-gate-${post.code}`,
      run: finishRun({ ...requested, postGateCode: post.code }),
    };
  }
  const postCheck = { status: post.check.status, score: { ...post.check.score } };
  const decision = decideAdoption({
    pre: input.preGate,
    post: post.check,
    gateUnusable: postGateUnusable(post.check),
    invalidated: signal?.aborted ? "cancelled" : undefined,
    config: context.config.adoption,
  });
  if (decision.result === "adopt") {
    return { ok: true, adopted: restored, run: finishRun({ ...requested, decision, postCheck }) };
  }
  if (decision.result === "abort") {
    // cancelled / stale / deadline。後続処理は拡張側の分類に従う。
    return { ok: false, code: decision.reason, run: finishRun({ ...requested, decision, postCheck }) };
  }
  return { ok: true, run: finishRun({ ...requested, decision, postCheck }) };
}

/** stage の残り時間と gate 個別上限の最小値。尽きていれば undefined。 */
function postGateTimeoutMs(
  stageTimeoutMs: number | undefined,
  startedAt: number,
  gateLimitMs: number,
): number | undefined {
  if (stageTimeoutMs === undefined) return undefined;
  const remaining = stageTimeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) return undefined;
  return Math.min(gateLimitMs, remaining);
}

/** post gate の結果が pre と比較できる状態か（第17.1章 第4行）。
 *  CLI の process 障害は呼び出し側で stage 障害に分類済み。
 *  incomplete / binaryVersion / scope / policyDigest は decideAdoption の
 *  第4行で検査するため、ここでは skipped だけを判定する。 */
function postGateUnusable(post: GateCheck): string | undefined {
  if (post.status === "skipped") return `post-skipped:${post.reason ?? "unknown"}`;
  return undefined;
}
