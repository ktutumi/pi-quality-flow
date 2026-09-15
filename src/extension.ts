/**
 * pi-quality-flow Extension（Phase 0A〜1、Issue #4/#7/#8）。
 *
 * 現在の範囲:
 * - terminal candidate の識別（正常 stop / 非空 text block 1つ / toolCall なし / 8 KiB 以内）
 * - candidateId と inputHash / outputHash の分離、single-flight claim
 * - `message_end` 返却 `{ message }` による本文 A → B の直接置換
 * - queued continuation が観測できる場合は置換を開始しない
 * - 設定 schema v2 の解決（defaults → global → trusted project）と configRevision
 * - /quality command 群（status / doctor / on / off / japanese / debug）
 * - mode 表に従う pre gate（validation-only）と trigger 評価
 * - Issue #8: backend 注入時は Formatter pipeline（sentinel 保護 → 復元 →
 *   構造/意味リスク検査 → post gate → decideAdoption）を採用シームとして配線し、
 *   provenance（本文とは別記録）を session entry に残す
 *
 * 実モデルによる自動修正は、backend の適合記録（docs/compat/formatter-backend.md）
 * が検証済みになるまで有効化しない（`backend-not-verified` で fail-closed）。
 *
 * 設計: docs/pi-quality-flow-design-v0.2.md 第6・11・12・13・17・23・27・29・32・33章。
 */
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CandidateLedger, type CandidateRecord } from "./coordinator/candidates.ts";
import { createStageController, StageBudget, type BudgetExpiry } from "./coordinator/budget.ts";
import { loadQualityFlowConfig, type ResolvedConfig } from "./config/loader.ts";
import { QualityFlowConfigStore, shouldKeepLastKnownGood, type ConfigSnapshot } from "./config/store.ts";
import { shouldTriggerFormatter } from "./config/trigger.ts";
import { PINNED_GATE_SHA256, verifyExecutableDigest } from "./jpqg/runner.ts";
import {
  isEligibleTerminalCandidate,
  MAX_SOURCE_BYTES,
  replaceSingleTextBlock,
  sha256Utf8,
} from "./pi/adapter.ts";
import { checkJapanese, type CheckJapaneseResult, type GateCheck } from "./japanese/service.ts";
import {
  runFormatterPipeline,
  type FormatterBackendLike,
  type FormatterRunRecord,
} from "./japanese/pipeline.ts";
import { TECH_MINIMAL_PROFILE_VERSION } from "./japanese/semantic-risk.ts";

/** Phase 0A〜0B の採用シーム。採用本文を返す。undefined は原文維持。 */
export type Finalizer = (input: {
  candidateId: string;
  originalText: string;
  /** claim 後・採用判断前に実行された pre gate の結果。 */
  preGate?: CheckJapaneseResult;
  /**
   * Formatter stage の abort signal（Issue #7、設計書 第32.3章）。
   * candidate / japanese 予算の期限切れ、user cancel（Escape）、
   * session 切替・設定変更による無効化で abort する。実装はこの signal を
   * backend（model request）へ伝播し、実停止させなければならない。
   * deadline 後の返り値は遅延結果として破棄される。
   */
  signal?: AbortSignal;
  /** signal と同じ予算計算に基づく stage 許可時間（ms）。 */
  timeoutMs?: number;
}) => FinalizerResult | Promise<FinalizerResult>;

/** 採用シームの返り値。文字列は採用本文、undefined は原文維持。 */
export type FinalizerResult =
  | string
  | undefined
  | {
      /** 採用本文。undefined は原文維持（拒否・無変更）。 */
      text?: string;
      /**
       * stage 障害（backend / post gate / 中断）。原文維持で outcome failed に
       * 分類する。障害なしの場合は省略する。
       */
      failed?: { code: string; message?: string };
    };

/** Finalizer の返り値を（採用本文、stage 障害）に正規化する。 */
function normalizeFinalizerResult(
  returned: FinalizerResult,
): { adopted: string | undefined; failed: { code: string; message?: string } | undefined } {
  if (typeof returned === "string") return { adopted: returned, failed: undefined };
  if (returned && typeof returned === "object") {
    return { adopted: returned.text, failed: returned.failed };
  }
  return { adopted: undefined, failed: undefined };
}

export interface QualityFlowOptions {
  /**
   * 採用シーム（テスト注入用）。省略時は backend から pipeline を組む。
   * 両者とも未指定は fail-closed: どの candidate も置換しない。
   */
  finalize?: Finalizer;
  /**
   * 隔離した Formatter backend（Issue #8）。省略時はローカル検証のみ
   * （自動 Formatter は無効）。実 model による backend の配線は #14。
   */
  backend?: FormatterBackendLike;
  /**
   * 固定版 jp-quality-gate の検証済み executable。
   * 省略時は設定の japanese.gate.command（絶対パスのみ）を使う。
   */
  gateExecutable?: string;
  /**
   * global 設定ディレクトリ。省略時は getAgentDir()。
   * テストがユーザーの実設定を読まないための注入点。
   */
  configAgentDir?: string;
  /**
   * 設定 store の観測 hook（契約試験専用。設定変更の競合試験で使う）。
   * 本番 entry point は渡さない。
   */
  configStoreHook?: (store: QualityFlowConfigStore) => void;
  /**
   * checkJapanese の注入点（契約試験専用）。固定版 binary の契約は維持され、
   * 既定では実物が使われる。遅延 gate fixture の試験で遅延を実装する。
   */
  checkJapaneseFn?: typeof checkJapanese;
}

export type ExtensionOutcome =
  | "formatted"
  | "unchanged"
  | "skipped"
  | "failed"
  | "cancelled"
  | "stale";

export interface FinalizeResult {
  outcome: ExtensionOutcome;
  reason: string;
  candidateId?: string;
  /** 置換する場合、対象 text block index と採用本文。 */
  replacement?: { textIndex: number; text: string };
}

/** message_end 処理の中核。非同期 stage 化と deadline は Issue #7。 */
export async function finalizeAssistantMessage(input: {
  message: AssistantMessage;
  pendingMessages: boolean;
  ledger: CandidateLedger;
  finalize?: Finalizer;
  /** claim 時点の configRevision。置換前に再検査する（in-flight 無効化）。 */
  configRevision?: number;
  isConfigCurrent?: (revision: number) => boolean;
  /** 解決済みの原文上限（UTF-8 bytes、設計書 第19章の japanese.maxSourceBytes）。 */
  maxSourceBytes?: number;
  /**
   * pre gate（原文の検証）。single-flight claim の後・採用判断の前に
   * 1回だけ実行する（重複 event による複数回 CLI 呼び出しを防ぐ）。
   */
  preGate?: (text: string) => Promise<CheckJapaneseResult>;
  /**
   * Formatter stage の中断・期限切れ分類（Issue #7）。finalize の await 後に呼ぶ。
   * cancelled → outcome cancelled、timeout → outcome failed（原文維持、
   * post gate / 再要求なし）。遅延結果は破棄される（第32.2章・第33.3章）。
   */
  classifyFinalizeStage?: () => "cancelled" | "timeout" | undefined;
  /**
   * 待機中 continuation の現在値（各 await 後・採用直前に再検査）。
   * Pi の steer は abort signal を発火させないため、開始時の snapshot だけでは
   * 処理中に届いた steer を検出できない（設計書 第33.2章）。
   */
  hasPendingMessages?: () => boolean;
}): Promise<FinalizeResult> {
  const { message, pendingMessages, ledger, finalize, preGate } = input;
  const maxSourceBytes = input.maxSourceBytes ?? MAX_SOURCE_BYTES;
  const eligibility = isEligibleTerminalCandidate(message, maxSourceBytes);
  if (!eligibility.ok) {
    return { outcome: "skipped", reason: eligibility.code };
  }
  if (pendingMessages) {
    // 待機中の continuation が観測できる場合は新しい Formatter 処理を開始しない。
    return { outcome: "skipped", reason: "pending-continuation" };
  }

  const inputHash = sha256Utf8(eligibility.text);
  const claim = ledger.claim({
    message,
    inputHash,
    claimedAtMs: Date.now(),
  });
  if (!claim.ok) {
    return {
      outcome: "stale",
      reason: claim.reason,
      candidateId: claim.candidateId,
    };
  }
  const record: CandidateRecord = claim.record;

  // pre gate は candidate 単位で最大1回（claim 後）。原文を対象とする。
  // 原文上限は isEligibleTerminalCandidate(maxSourceBytes) で claim 前に確認済み。
  let preGateResult: CheckJapaneseResult | undefined;
  if (preGate) {
    preGateResult = await preGate(eligibility.text);
    if (input.hasPendingMessages?.()) {
      // pre gate 実行中に steer / follow-up が届いた。遅延結果を破棄する
      // （置換を続行すると、steer で修正される前の本文を採用してしまう）。
      ledger.commit(record, "skipped", "pending-continuation");
      return { outcome: "skipped", reason: "pending-continuation", candidateId: record.candidateId };
    }
    // 中断・期限切れは以後の stage（Formatter）を開始しない（設計書 第32.2章）。
    // user cancel は cancelled、deadline は failed として区別する。
    if (preGateResult && !preGateResult.ok) {
      if (preGateResult.code === "cancelled") {
        ledger.commit(record, "skipped", "cancelled");
        return { outcome: "cancelled", reason: "pre-gate-cancelled", candidateId: record.candidateId };
      }
      if (preGateResult.code === "timeout") {
        ledger.commit(record, "failed", "pre-gate-timeout");
        return { outcome: "failed", reason: "pre-gate-timeout", candidateId: record.candidateId };
      }
    }
  }

  if (!finalize) {
    // fail-closed: 観測のみ。candidate は識別・記録するが置換はしない。
    ledger.commit(record, "unchanged", "finalizer-not-configured", inputHash);
    return {
      outcome: "unchanged",
      reason: "finalizer-not-configured",
      candidateId: record.candidateId,
    };
  }

  // Formatter stage の中断・期限切れ（Issue #7）: stage 開始前・実行中の
  // いずれも signal で検出し、遅延結果を破棄する（有効性確認と反映を同じ
  // 直列化区間で行う。第33.2章）。以後の stage（post gate / 再要求）は開始しない。
  const stageAbortResult = (): FinalizeResult | undefined => {
    const finalizeStageOutcome = input.classifyFinalizeStage?.();
    if (finalizeStageOutcome === "cancelled") {
      ledger.commit(record, "skipped", "cancelled");
      return { outcome: "cancelled", reason: "formatter-cancelled", candidateId: record.candidateId };
    }
    if (finalizeStageOutcome === "timeout") {
      ledger.commit(record, "failed", "formatter-deadline");
      return { outcome: "failed", reason: "formatter-deadline", candidateId: record.candidateId };
    }
    return undefined;
  };

  let adopted: string | undefined;
  let stageFailure: { code: string; message?: string } | undefined;
  try {
    const normalized = normalizeFinalizerResult(await finalize({
      candidateId: record.candidateId,
      originalText: eligibility.text,
      preGate: preGateResult,
    }));
    adopted = normalized.adopted;
    stageFailure = normalized.failed;
  } catch (error) {
    // signal abort による seam の reject（AbortError 等）も分類対象。
    // 中断・期限切れなら遅延結果を破棄し、candidate に終了記録を付ける。
    // abort 以外の backend error は従来どおり伝播する（握りつぶさない）。
    const aborted = stageAbortResult();
    if (aborted) return aborted;
    throw error;
  }
  const finalizedAbort = stageAbortResult();
  if (finalizedAbort) return finalizedAbort;
  if (input.hasPendingMessages?.()) {
    // finalize 実行中に steer / follow-up が届いた。採用判断の直前にも再検査する
    // （有効性確認と反映を同じ直列化区間で行う。設計書 第33.2章）。
    ledger.commit(record, "skipped", "pending-continuation");
    return { outcome: "skipped", reason: "pending-continuation", candidateId: record.candidateId };
  }
  if (stageFailure) {
    // stage 障害（backend / post gate）。原文維持、以後の処理なし（第26.3章）。
    ledger.commit(record, "failed", `formatter-stage:${stageFailure.code}`);
    return {
      outcome: "failed",
      reason: `formatter-stage:${stageFailure.code}`,
      candidateId: record.candidateId,
    };
  }
  if (adopted === undefined) {
    ledger.commit(record, "unchanged", "no-adoption", inputHash);
    return { outcome: "unchanged", reason: "no-adoption", candidateId: record.candidateId };
  }
  if (adopted === eligibility.text) {
    ledger.commit(record, "unchanged", "identical", inputHash);
    return { outcome: "unchanged", reason: "identical", candidateId: record.candidateId };
  }
  if (!ledger.isCurrent(record)) {
    // claim と commit の間に session が切り替わっていた場合は置換しない。
    ledger.commit(record, "skipped", "stale-session");
    return { outcome: "stale", reason: "stale-session", candidateId: record.candidateId };
  }
  if (input.configRevision !== undefined && input.isConfigCurrent && !input.isConfigCurrent(input.configRevision)) {
    // 処理中に設定が変わった（OFF / mode 変更 / reload）場合は旧結果を適用しない。
    ledger.commit(record, "skipped", "stale-config");
    return { outcome: "stale", reason: "stale-config", candidateId: record.candidateId };
  }

  const outputHash = sha256Utf8(adopted);
  ledger.commit(record, "formatted", "formatter-adopted", outputHash);
  return {
    outcome: "formatted",
    reason: "formatter-adopted",
    candidateId: record.candidateId,
    replacement: { textIndex: eligibility.textIndex, text: adopted },
  };
}

/** candidate 判断を session entry に記録する（LLM context には participation しない）。 */
function appendCandidateEntry(pi: ExtensionAPI, record: CandidateRecord): void {
  pi.appendEntry("pi-quality-flow:candidate", {
    candidateId: record.candidateId,
    sessionEpoch: record.sessionEpoch,
    runIndex: record.runIndex,
    turnIndex: record.turnIndex,
    candidateSequence: record.candidateSequence,
    inputHash: record.inputHash,
    outputHash: record.outputHash,
    phase: record.phase,
    reason: record.reason,
  });
}

export function createQualityFlowExtension(options: QualityFlowOptions = {}): ExtensionFactory {
  const { finalize: seamFinalize, backend, gateExecutable, configStoreHook } = options;
  const checkJapaneseFn = options.checkJapaneseFn ?? checkJapanese;
  const store = new QualityFlowConfigStore();
  /** session_start 時の解決結果（status / doctor の表示用）。 */
  let resolved: ResolvedConfig | undefined;
  /** 現在有効な設定の出所（last-known-good 保持時は旧解決の sources）。 */
  let effectiveSources: ResolvedConfig["sources"] | undefined;
  /** 不正 layer で以前の設定を維持しているか（status 表示用）。 */
  let keptLastKnownGood = false;
  /** 現在の final response（正常 stop の本文）。手動 check の対象。 */
  let lastFinalText: string | undefined;
  /** 最後の gate check（status 表示用）。 */
  let lastCheck: GateCheck | undefined;

  /** 設定に基づく実行可能な gate executable。 */
  const resolveGateExecutable = (): string | undefined => {
    if (gateExecutable) return gateExecutable;
    const command = store.current.config.japanese.gate.command;
    // 相対名は PATH 探索先が検証対象とずれるため実行しない（runner と同じ原則）。
    return isAbsolute(command) ? command : undefined;
  };

  /** 自動処理の可否と理由（mode 表、設計書 第13章）。 */
  const autoGateDecision = (snapshot: ConfigSnapshot): { run: boolean; reason: string } => {
    const cfg = snapshot.config;
    if (!cfg.enabled) return { run: false, reason: "extension-disabled" };
    if (!cfg.japanese.enabled) return { run: false, reason: "japanese-disabled" };
    if (!cfg.japanese.gate.enabled) {
      // 不正組合せ（gate 無効 + mode 非off）は loader で通知済み。自動処理は停止。
      return { run: false, reason: "gate-disabled" };
    }
    return { run: true, reason: "pre-gate" };
  };

  /**
   * Formatter の実行権限（送信許可と backend 適合、設計書 第27.2章）。
   * backend は許可値が stateless-api（remote API backend）のみのため、
   * remote として cloud egress + role 別 allowlist を必須にする。
   * local backend を許可値に追加するときは locality 別の条件をこの先に書く
   * （local model でも role 別 allowlist は必要）。未知 backend は fail-closed。
   */
  const formatterPermission = (
    snapshot: ConfigSnapshot,
  ): { allowed: boolean; reason: string } => {
    const cfg = snapshot.config;
    const jp = cfg.japanese;
    if (!cfg.enabled || !jp.enabled) return { allowed: false, reason: "extension-or-japanese-disabled" };
    if (!jp.gate.enabled) return { allowed: false, reason: "gate-disabled" };
    if (jp.mode === "off") return { allowed: false, reason: "mode-off" };
    if (jp.formatter.backend !== "stateless-api") {
      return { allowed: false, reason: "backend-unavailable" };
    }
    if (backend !== undefined && !backend.isReady()) {
      // 適合記録が未検証の backend は自動有効化しない（第51章・docs/compat）。
      return { allowed: false, reason: "backend-not-verified" };
    }
    if (cfg.security.cloudEgress !== "allow") {
      return { allowed: false, reason: "egress-denied" };
    }
    const allowlist = cfg.security.allowedModels.formatter;
    if (allowlist.length === 0) return { allowed: false, reason: "allowlist-empty" };
    const model = jp.model;
    const modelAllowed =
      model?.provider !== undefined &&
      model.modelId !== undefined &&
      allowlist.includes(`${model.provider}/${model.modelId}`);
    if (!modelAllowed) return { allowed: false, reason: "model-not-allowed" };
    return { allowed: true, reason: "permitted" };
  };

  /** check 結果を session entry に記録する（LLM context には participation しない）。 */
  const recordCheck = (
    pi: ExtensionAPI,
    source: "auto" | "manual",
    text: string | undefined,
    check:
      | { ok: true; check: GateCheck }
      | { ok: false; code: string },
    extra?: Record<string, unknown>,
  ): void => {
    if (!check.ok) {
      pi.appendEntry("pi-quality-flow:check", {
        source,
        scope: "editable-prose",
        status: "skipped",
        failureCode: check.code,
        ...extra,
      });
      return;
    }
    const c = check.check;
    pi.appendEntry("pi-quality-flow:check", {
      source,
      scope: c.scope,
      status: c.status,
      reason: c.reason,
      incomplete: c.incomplete,
      score: c.score,
      // 診断の詳細は本文断片を含むため entry には rule / 座標のみ。
      diagnostics: c.diagnostics.map((d) => ({
        ruleId: d.ruleId,
        severity: d.severity,
        start: d.start,
        end: d.end,
      })),
      inputBytes: text === undefined ? undefined : Buffer.byteLength(text, "utf8"),
      binaryVersion: c.binaryVersion,
      ...extra,
    });
  };

  /** check 結果の 1 行サマリ（本文断片を含まない）。 */
  const summarizeCheck = (check: GateCheck): string => {
    const parts = [
      `japanese check: ${check.status}`,
      "scope=editable-prose",
      `score=${check.score.errors}e/${check.score.warnings}w`,
    ];
    if (check.reason) parts.push(`reason=${check.reason}`);
    if (check.incomplete) parts.push(check.incomplete);
    if (check.diagnostics.length > 0) {
      parts.push(
        check.diagnostics
          .map((d) => `${d.ruleId}@${d.start}-${d.end}(${d.severity})`)
          .join(", "),
      );
    }
    return parts.join(" ");
  };

  const configLines = (snapshot: ConfigSnapshot): string[] => {
    const cfg = snapshot.config;
    const jp = cfg.japanese;
    const lines = [
      `extension: ${cfg.enabled ? "on" : "off"} (configRevision=${snapshot.revision}, ${snapshot.lastChangeReason})`,
      `japanese: ${jp.enabled ? "on" : "off"}, mode=${jp.mode}, profile=${jp.profile}, deadline=${jp.deadlineMs}ms`,
      `gate: ${jp.gate.enabled ? "on" : "off"}, trigger=${jp.gate.trigger}, command=${jp.gate.command}`,
      `formatter: backend=${jp.formatter.backend} (compat: ${describeBackendCompat()})`,
      `model (formatter): ${describeModelResolution(cfg)}`,
      `security: cloudEgress=${cfg.security.cloudEgress}, allowlist=[advisor:${cfg.security.allowedModels.advisor.length}, formatter:${cfg.security.allowedModels.formatter.length}]`,
      `gate CLI: ${resolveGateExecutable() ? "executable configured" : "not configured"}`,
    ];
    if (lastCheck !== undefined) {
      lines.push(`last check: ${lastCheck.status} score=${lastCheck.score.errors}e/${lastCheck.score.warnings}w scope=${lastCheck.scope}`);
    }
    return lines;
  };

  /** model resolution / permission / backend compat / CLI compat を1行に分けず表示する。 */
  const describeModelResolution = (cfg: ConfigSnapshot["config"]): string => {
    const allowlist = cfg.security.allowedModels.formatter;
    const model = cfg.japanese.model;
    if (cfg.security.cloudEgress === "deny") {
      return model
        ? `configured (${model.provider}/${model.modelId ?? "?"}) but egress=deny`
        : "not configured; egress=deny";
    }
    if (allowlist.length === 0) return "not configured; allowlist empty (no models allowed)";
    if (model === undefined) return `not configured; allowlist has ${allowlist.length} model(s)`;
    const allowed = allowlist.some(
      (entry) => model.provider !== undefined && entry === `${model.provider}/${model.modelId ?? ""}`,
    );
    if (!allowed) return `configured (${model.provider}/${model.modelId ?? "?"}) not in allowlist`;
    // 解決は ModelRegistry での適合確認（Issue #5）まで行わない。ready とは表示しない。
    return `configured (${model.provider}/${model.modelId ?? "?"}) — compat ${describeBackendCompat()}`;
  };

  /**
   * backend の適合状態（docs/compat/formatter-backend.md の記録に基づく表示）。
   * 実送信試験が完了していないため未検証。記録は手動で同期する
   * （記録が検証済みになったら、この表示と capability 注入を更新する）。
   */
  const describeBackendCompat = (): string => "unverified (live run pending; see docs/compat/formatter-backend.md)";

  /** 設定問題の通知（障害通知と同じ扱い。ui.notifyOnFailure に従う）。 */
  const notifyProblems = (
    pi: ExtensionAPI,
    ctx: { ui: { notify: (message: string, level: "info" | "warning" | "error") => void } },
    result: ResolvedConfig,
  ): void => {
    const cfg = result.config;
    if (!cfg.ui.notifyOnFailure) return;
    for (const problem of result.problems) {
      // 通知の 1 行サマリ（本文断片を含まない）。
      const detailLines: string[] = [];
      if (problem.code === "schema-invalid") {
        detailLines.push(...problem.issues.map((i) => `${i.path}: ${i.code}`));
      } else if (problem.code === "legacy-config") {
        detailLines.push(...problem.legacy.map((l) => `${l.path}${l.migration ? ` → ${l.migration}` : ""}`));
      } else {
        detailLines.push(problem.code);
      }
      const detail = detailLines.join("; ");
      pi.appendEntry("pi-quality-flow:config-problem", {
        scope: problem.scope,
        path: problem.path,
        code: problem.code,
        issues: problem.issues.map((i) => ({ path: i.path, code: i.code })),
        legacy: problem.legacy.map((l) => ({ path: l.path, migration: l.migration })),
      });
      ctx.ui.notify(
        `quality-flow: ${problem.scope} config (${problem.path}) not applied: ${problem.code} ${detail}`,
        "warning",
      );
      // headless / RPC でも観測できるように entry にも残す。
      pi.appendEntry("pi-quality-flow:notify", {
        message: `quality-flow: ${problem.scope} config not applied: ${problem.code} ${detail}`,
        level: "warning",
      });
    }
  };

  return (pi: ExtensionAPI) => {
    const ledger = new CandidateLedger();

    /**
     * candidate 無効化 signal（Issue #7、設計書 第33.1章）。
     * session 切替 / 設定変更 / OFF で abort し、処理中の backend work を
     * 実停止させる。abort 後は新しい candidate 用に作り直す
     * （旧 signal は abort 済みのまま残る）。
     *
     * 新 candidate 確定時・threshold compaction 時の明示的な無効化配線は
     * 不要である（Pi 0.85.1 の拡張 event は直列 await される:
     * agent-session.js は emitMessageEnd を await し、runner も handler を
     * 直列実行するため、旧 candidate の処理中に新 candidate の claim や
     * compaction は始まらない）。手動 compaction は先に session.abort() する
     * （agent-session.js teardown 経路）ため、ctx.signal 経由で停止する。
     */
    let invalidation = new AbortController();
    const invalidateWork = () => {
      invalidation.abort("invalidated");
      invalidation = new AbortController();
    };
    // 設定の確定（command / reload / hook からの直接変更）は常に in-flight の
    // backend work を無効化する（store 変更境界）。
    store.onChange = invalidateWork;

    // session 切替（new / fork / resume 等）の teardown で旧 session の処理を
    // 無効化する（session_start は新しい instance で発火するため、旧 instance は
    // session_shutdown だけで観測できる）。
    pi.on("session_shutdown", () => {
      invalidateWork();
    });

    configStoreHook?.(store);

    pi.on("session_start", (event, ctx) => {
      invalidateWork();
      ledger.beginSession(ctx.sessionManager.getSessionId());
      // session switch / new / fork で旧 final response を破棄する（Issue #7 の先取り）。
      lastFinalText = undefined;

      // 設定の再解決: packaged defaults → global → trusted project。
      // trust 不明・未信頼では project layer を読まない。
      const result = loadQualityFlowConfig({
        agentDir: options.configAgentDir ?? getAgentDir(),
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      resolved = result;
      // 不正 layer（読めない / schema 不正 / legacy）があれば last-known-good を
      // 維持する。勝手に制約の弱い defaults に戻さない（設計書 第27.2章）。
      // 剥がし通知（project-stripped）と組合せ通知（invalid-combination）は
      // 設定自体は採用済みのため対象外。
      if (shouldKeepLastKnownGood(result.problems, store.current)) {
        keptLastKnownGood = true;
        // effectiveSources は現在有効な設定の出所（旧解決結果）を維持する。
        store.reload(store.current.config, `session_start:${event.reason}:kept-last-known-good`);
      } else {
        keptLastKnownGood = false;
        effectiveSources = result.sources;
        store.reload(result.config, `session_start:${event.reason}`);
      }
      notifyProblems(pi, ctx, result);
      // session_start の全 reason（startup / new / resume / fork / reload）を
      // 契約観測のため entry に残す。
      pi.appendEntry("pi-quality-flow:session", { reason: event.reason });
    });

    pi.on("agent_start", async () => {
      ledger.beginRun();
    });

    pi.on("turn_start", async (event) => {
      ledger.observeTurnStart(event.turnIndex);
    });

    pi.on("message_end", async (event, ctx) => {
      if (event.message.role !== "assistant") return undefined;
      const message: AssistantMessage = event.message;
      const snapshot = store.current;
      const decision = autoGateDecision(snapshot);
      const executable = resolveGateExecutable();

      // 全体予算（Issue #7、設計書 第32.1章）: candidate 90秒・日本語処理10秒を
      // 個別 stage 上限より優先する。日本語処理の予算は編集可能範囲の解析開始
      // （pre gate 実行）で開始する。
      const budget = new StageBudget({
        candidateDeadlineMs: snapshot.config.finalization.deadlineMs,
        japaneseDeadlineMs: snapshot.config.japanese.deadlineMs,
      });

      // pre gate の結果と trigger 判断（entry 記録用）。
      let preCheck: CheckJapaneseResult | undefined;
      let preGateText: string | undefined;
      let formatterDecision: string | undefined;
      /** trigger 評価の結果（mode off / 未評価は undefined）。 */
      let triggeredResult: boolean | undefined;
      /** pre gate 完了後の configRevision 再検査結果。 */
      let preGateCurrent = true;
      /** 期限切れ・中断の区別（Issue #7 AC）。 */
      let budgetExpiry: BudgetExpiry | undefined;
      let userCancelled = false;
      /** Formatter stage の期限切れ・中断（Issue #7）。 */
      let formatterExpiry: BudgetExpiry | undefined;
      let formatterCancelled = false;

      /** pre gate（原文の検証）。claim 後に 1 回だけ実行される。
       *  各 await 後の有効性検査（Issue #4）: 完了後に設定が変わっていたら
       *  以後の stage（Formatter）を開始しない。 */
      let preGateRunner: ((text: string) => Promise<CheckJapaneseResult>) | undefined;
      if (decision.run && executable) {
        preGateRunner = async (text) => {
          // 無効化（session / 設定変更）と user cancel（Escape）を合成して検査する。
          const external = combineSignals(ctx.signal, invalidation.signal);
          // ユーザー中断済み（Escape）や無効化済みの turn では stage を開始しない
          // （設計書 第32.2章: user cancel は pipeline を始めない）。
          if (external.aborted) {
            userCancelled = true;
            const check: CheckJapaneseResult = { ok: false, code: "cancelled" };
            preCheck = check;
            preGateText = text;
            return check;
          }
          budget.markJapaneseStart(Date.now());
          // 予算切れのときは新 stage を開始しない（設計書 第32.1章）。
          const timeoutMs = budget.stageTimeoutMs(snapshot.config.japanese.gate.timeoutMs, Date.now());
          if (timeoutMs === undefined) {
            budgetExpiry = budget.expired(Date.now());
            const check: CheckJapaneseResult = {
              ok: false,
              code: "timeout",
              message: `budget exhausted (${budgetExpiry})`,
            };
            preCheck = check;
            preGateText = text;
            return check;
          }
          const stage = createStageController({
            budget,
            external,
            onExpiry: (expiry) => {
              budgetExpiry = expiry;
            },
            onCancel: () => {
              userCancelled = true;
            },
          });
          try {
            const check = await checkJapaneseFn({
              text,
              executable,
              timeoutMs,
              signal: stage.signal,
            });
            // 予算切れで stage signal が abort した場合、runGate は signal abort を
            // cancelled として返す。切れた予算（budgetExpiry）を優先して
            // timeout に正規化する（設計書 第32.2章: deadline ≠ user cancel）。
            const normalized: CheckJapaneseResult =
              budgetExpiry !== undefined && !check.ok && check.code === "cancelled"
                ? { ok: false, code: "timeout", message: `budget exhausted (${budgetExpiry})` }
                : check;
            preCheck = normalized;
            preGateText = text;
            lastCheck = normalized.ok ? normalized.check : undefined;
            if (!store.isCurrent(snapshot.revision)) preGateCurrent = false;
            return normalized;
          } finally {
            stage.dispose();
          }
        };
      }

      /** pipeline 実行の provenance（stale 検査を通ったときだけ entry に記録する）。 */
      let formatterRun: FormatterRunRecord | undefined;
      /** Formatter 実体: 注入 seam を優先し、なければ backend から pipeline を組む。 */
      const finalizeImpl: Finalizer | undefined =
        seamFinalize ??
        (backend && executable
          ? async (seamInput) => {
              if (!seamInput.preGate?.ok) {
                // wrapper の契約上到達しない（pre gate 不合格では呼ばれない）。fail-closed。
                return undefined;
              }
              const pipelineResult = await runFormatterPipeline(
                {
                  candidateId: seamInput.candidateId,
                  originalText: seamInput.originalText,
                  preGate: seamInput.preGate.check,
                  signal: seamInput.signal,
                  timeoutMs: seamInput.timeoutMs,
                },
                {
                  backend,
                  executable,
                  config: snapshot.config.japanese,
                  checkJapaneseFn: checkJapaneseFn,
                },
              );
              formatterRun = pipelineResult.run;
              if (!pipelineResult.ok) {
                // stage 障害は原文維持（outcome failed。第26.3章）。
                return {
                  failed: { code: pipelineResult.code, message: pipelineResult.message },
                };
              }
              return pipelineResult.adopted;
            }
          : undefined);

      const result = await finalizeAssistantMessage({
        message,
        pendingMessages: ctx.hasPendingMessages(),
        // steer は abort signal を発火させないため、各 await 後に再検査する。
        hasPendingMessages: () => ctx.hasPendingMessages(),
        ledger,
        maxSourceBytes: snapshot.config.japanese.maxSourceBytes,
        // 採用シーム: mode 表（第13章）に従い、pre gate の後で trigger を評価して
        // から Formatter（注入 seam または pipeline）を起動する。OFF / mode off /
        // trigger 不成立 / pre gate 不使用では Formatter を開始しない（原文維持）。
        finalize: async (input) => {
          if (!preGateCurrent) {
            // pre gate 実行中に設定が変わった（OFF / mode 変更 / reload）。
            // 以後の stage（Formatter）を開始しない（設計書 第33.2章）。
            formatterDecision = "stale-config";
            return undefined;
          }
          const pre = input.preGate;
          if (!pre || !pre.ok) {
            // pre gate が実行されない / 障害の場合は Formatter を開始しない
            // （pre 障害なら Formatter 0回。設計書 第43.3章）。
            formatterDecision = pre ? `pre-failed:${pre.code}` : "pre-unavailable";
            triggeredResult = false;
            return undefined;
          }
          if (pre.check.status === "skipped") {
            // 対象外（英語のみ / 未対応構造 / 対応不能）は全文原文維持。
            formatterDecision = `pre-skipped:${pre.check.reason ?? "unknown"}`;
            triggeredResult = false;
            return undefined;
          }
          if (pre.check.incomplete !== undefined) {
            // 診断完全性が不明な原文は Formatter に渡さない（第15.1章: pre で
            // 判明した場合は Formatter を起動せず原文を維持）。
            formatterDecision = "pre-diagnostics-incomplete";
            triggeredResult = false;
            return undefined;
          }
          const jp = snapshot.config.japanese;
          // trigger と権限は別の状態として評価・表示する（Issue #4 AC）。
          // trigger を先に評価し、permission は finalize 直前だけ確認する。
          triggeredResult =
            jp.mode === "always" ||
            shouldTriggerFormatter(pre.check.score, jp.gate.trigger);
          if (!triggeredResult) {
            formatterDecision = "gate-not-triggered";
            return undefined;
          }
          const permission = formatterPermission(snapshot);
          if (!permission.allowed) {
            // 送信不許可 / backend 未適合など。ローカル検証のみで留める。
            formatterDecision = permission.reason;
            return undefined;
          }
          if (!finalizeImpl) {
            // 権限はあっても Formatter 実体が未提供。ローカル検証のみで留める。
            formatterDecision = "formatter-unavailable";
            return undefined;
          }
          // Formatter stage（Issue #7、第32.1〜32.3章）: 開始前に無効化と残り
          // 予算を確認し、実行中の backend には deadline / user cancel / 無効化
          // を signal で伝播する（実停止。第32.3章）。
          const external = combineSignals(ctx.signal, invalidation.signal);
          if (external.aborted) {
            formatterCancelled = true;
            formatterDecision = "formatter-cancelled";
            return undefined;
          }
          const formatterTimeoutMs = budget.stageTimeoutMs(
            snapshot.config.japanese.formatter.timeoutMs,
            Date.now(),
          );
          if (formatterTimeoutMs === undefined) {
            // 期限後は次 stage を開始しない（第32.1章）。
            formatterExpiry = budget.expired(Date.now());
            formatterDecision = "formatter-deadline";
            return undefined;
          }
          const stage = createStageController({
            budget,
            external,
            onExpiry: (expiry) => {
              formatterExpiry = expiry;
            },
            onCancel: () => {
              formatterCancelled = true;
            },
          });
          try {
            return await finalizeImpl({
              ...input,
              signal: stage.signal,
              timeoutMs: formatterTimeoutMs,
            });
          } finally {
            stage.dispose();
          }
        },
        classifyFinalizeStage: () => {
          // timer tick の監視間隔内に返った結果も期限超過として破棄する
          // （採用判断の直前で wall-clock で再検査する。第32.1章）。
          const expiry = formatterExpiry ?? budget.expired(Date.now());
          if (expiry !== undefined) {
            formatterExpiry = expiry;
            formatterDecision = "formatter-deadline";
            return "timeout";
          }
          if (formatterCancelled) {
            formatterDecision = "formatter-cancelled";
            return "cancelled";
          }
          return undefined;
        },
        preGate: preGateRunner,
        configRevision: snapshot.revision,
        isConfigCurrent: (revision) => store.isCurrent(revision),
      });

      // 処理中に設定が変わっていた（OFF / mode 変更 / reload / last-known-good）
      // 場合は旧 snapshot に基づく状態更新を一切行わない（第33.3章: stale 結果は
      // 新しい session / config の状態を上書きしない）。candidate 記録より先に
      // 検査する（stale-config でも candidate entry は書かない）。
      if (!store.isCurrent(snapshot.revision)) {
        return undefined;
      }

      if (result.candidateId) {
        const record = ledger.find(result.candidateId);
        if (record) appendCandidateEntry(pi, record);
      }

      // 自動 gate の検証結果（pre gate の原文対象）。
      if (preCheck !== undefined) {
        const jp = snapshot.config.japanese;
        const extra: Record<string, unknown> = { mode: jp.mode };
        if (jp.mode !== "off") {
          extra.triggered = triggeredResult ?? false;
          extra.formatterReason = formatterDecision ?? "formatter-started";
        }
        // 中断・期限切れの区別を entry に記録する（Issue #7 AC）。
        if (userCancelled) extra.cancelled = true;
        if (budgetExpiry !== undefined) extra.budgetExpiry = budgetExpiry;
        // Formatter stage の中断・期限切れも entry に記録する（Issue #7 AC）。
        if (formatterCancelled) extra.formatterCancelled = true;
        if (formatterExpiry !== undefined) extra.formatterBudgetExpiry = formatterExpiry;
        recordCheck(pi, "auto", preGateText, preCheck, extra);
      }

      // Formatter 実行の provenance（本文とは別記録。Issue #8 AC）。
      // hash・採用理由・検証状態・呼び出し回数・利用量を本文・診断対象文字列と
      // 切り離して記録する。
      if (formatterRun !== undefined) {
        const candidateRecord = result.candidateId ? ledger.find(result.candidateId) : undefined;
        pi.appendEntry("pi-quality-flow:formatter", {
          ...formatterRun,
          inputHash: candidateRecord?.inputHash,
          outputHash: candidateRecord?.outputHash,
          outcome: result.outcome,
          profile: TECH_MINIMAL_PROFILE_VERSION,
        });
      }

      // 正常 stop の本文だけを手動 check の対象として追跡する。
      // 置換が成功した場合は採用本文を「現在の final response」とする。
      if (message.stopReason === "stop") {
        if (result.outcome === "formatted" && result.replacement) {
          lastFinalText = result.replacement.text;
        } else {
          let joined = "";
          for (const block of message.content ?? []) {
            if (block.type === "text" && block.text.length > 0) joined += block.text;
          }
          if (joined.length > 0) lastFinalText = joined;
        }
      }

      if (result.outcome !== "formatted" || !result.replacement) return undefined;
      // 通常の rewrite 通知は初期 OFF（設計書 第25章）。本文は通知に含めない。
      if (snapshot.config.ui.notifyOnRewrite) {
        const reason = result.reason;
        const message = `quality-flow: formatter correction adopted (reason=${reason}, verification=post)`;
        ctx.ui.notify(message, "info");
        pi.appendEntry("pi-quality-flow:notify", { message, level: "info" });
      }
      const corrected = replaceSingleTextBlock(
        message,
        result.replacement.textIndex,
        result.replacement.text,
      );
      return { message: corrected };
    });

    pi.on("turn_end", (event) => {
      if (event.message.role !== "assistant") return;
      // message_end と同じ message オブジェクトが届くことを使って対応付けを観測する。
      const mapped = ledger.resolveByMessage(event.message);
      if (mapped) {
        pi.appendEntry("pi-quality-flow:turn-mapping", {
          candidateId: mapped.candidateId,
          turnIndex: event.turnIndex,
        });
      }
    });

    // /quality command 群（設計書 第29章）。Advisor 起動 command と
    // Main tool は登録しない。command が送信許可を暗黙に変えることはない。
    pi.registerCommand("quality", {
      description: "pi-quality-flow status / doctor / japanese / debug",
      handler: async (args, ctx) => {
        const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
        const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
          ctx.ui.notify(message, level);
          pi.appendEntry("pi-quality-flow:notify", { message, level, command: parts.join(" ") });
        };
        const snapshot = store.current;

        if (parts.length === 0 || parts[0] === "help") {
          notify(
            [
              "usage: /quality status | doctor | on | off |",
              "  japanese on|off | japanese mode always|gate|off | japanese check |",
              "  debug on|off",
            ].join(" "),
          );
          return;
        }

        switch (parts[0]) {
          case "status": {
            const lines = [
              `pi-quality-flow (configRevision=${snapshot.revision})`,
              ...configLines(snapshot),
              describeSources(effectiveSources, keptLastKnownGood, resolved),
            ];
            notify(lines.join("\n"));
            return;
          }
          case "doctor": {
            const executable = resolveGateExecutable();
            const lines = [
              `doctor (model calls: 0)`,
              `config: ${describeConfigValidity(resolved)}`,
              `gate CLI: ${await describeGateCli(executable)}`,
              `model (formatter): ${describeModelResolution(snapshot.config)}`,
              `backend: ${snapshot.config.japanese.formatter.backend} — compat ${describeBackendCompat()} (not ready)`,
              `conflicts: ${describeConflicts(ctx.cwd, options.configAgentDir ?? getAgentDir())}`,
              `egress: ${snapshot.config.security.cloudEgress === "deny" ? "denied (local validation only)" : "allowed"}`,
            ];
            notify(lines.join("\n"));
            return;
          }
          case "on": {
            const change = store.setEnabled(true, "command:/quality on");
            recordConfigChange(pi, change, "enabled=true");
            notify("pi-quality-flow enabled");
            return;
          }
          case "off": {
            const change = store.setEnabled(false, "command:/quality off");
            recordConfigChange(pi, change, "enabled=false");
            notify("pi-quality-flow disabled");
            return;
          }
          case "debug": {
            const value = parts[1];
            if (value !== "on" && value !== "off") {
              notify("usage: /quality debug on|off", "warning");
              return;
            }
            const change = store.setDebug(value === "on", `command:/quality debug ${value}`);
            recordConfigChange(pi, change, `debug=${value}`);
            notify(`debug ${value}`);
            return;
          }
          case "advisor": {
            // 初回リリースは Advisor 未実装。起動 command は登録しない。
            notify("General Advisor is out of scope for the initial release (Phase 2)", "warning");
            return;
          }
          case "japanese": {
            const sub = parts[1];
            if (sub === "on" || sub === "off") {
              const change = store.setJapaneseEnabled(sub === "on", `command:/quality japanese ${sub}`);
              if (!change.ok) {
                notify(change.reason, "error");
                return;
              }
              recordConfigChange(pi, change, `japanese.enabled=${sub}`);
              notify(`japanese ${sub}`);
              return;
            }
            if (sub === "mode") {
              const mode = parts[2];
              if (mode !== "always" && mode !== "gate" && mode !== "off") {
                notify("usage: /quality japanese mode always|gate|off", "warning");
                return;
              }
              const change = store.setJapaneseMode(mode, `command:/quality japanese mode ${mode}`);
              if (!change.ok) {
                notify(change.reason, "error");
                return;
              }
              recordConfigChange(pi, change, `japanese.mode=${mode}`);
              notify(`japanese mode ${mode}`);
              return;
            }
            if (sub === "check") {
              const executable = resolveGateExecutable();
              if (executable === undefined) {
                notify("japanese gate is not configured", "warning");
                return;
              }
              // 現在の final response（正常 stop の本文）のみを対象にする。
              // 非アクティブ branch の履歴は参照しない。
              const lastText = lastFinalText;
              if (lastText === undefined) {
                notify("no final response to check", "warning");
                return;
              }
              const check = await checkJapaneseFn({
                text: lastText,
                executable,
                timeoutMs: store.current.config.japanese.deadlineMs,
                signal: ctx.signal,
              });
              lastCheck = check.ok ? check.check : undefined;
              recordCheck(pi, "manual", lastText, check);
              if (check.ok) {
                notify(summarizeCheck(check.check));
              } else {
                notify(`japanese check failed: ${check.code}`, "error");
              }
              return;
            }
            notify("usage: /quality japanese on|off|mode|check", "warning");
            return;
          }
          default:
            notify(`unknown subcommand: ${parts[0]}`, "warning");
            return;
        }
      },
    });
  };
}

/** handler 内で参照する実行時の executable（snapshot 不変）。 */

/**
 * 複数の外部 abort 要因（ctx.signal = user cancel、invalidation = session /
 * 設定変更）を 1 つの signal に合成する（Issue #7、第32.3章・第33.1章）。
 * どちらかが abort すると合成 signal も abort する。
 */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (a === undefined) return b;
  return AbortSignal.any([a, b]);
}

function recordConfigChange(
  pi: ExtensionAPI,
  change: { ok: true; snapshot: ConfigSnapshot } | { ok: false; reason: string },
  label: string,
): void {
  if (change.ok) {
    pi.appendEntry("pi-quality-flow:config", {
      revision: change.snapshot.revision,
      reason: change.snapshot.lastChangeReason,
      label,
    });
    return;
  }
  pi.appendEntry("pi-quality-flow:config-rejected", { label, reason: change.reason });
}

function describeSources(
  effective: ResolvedConfig["sources"] | undefined,
  keptLastKnownGood: boolean,
  resolved: ResolvedConfig | undefined,
): string {
  if (effective === undefined) return "sources: not loaded";
  const parts = ["defaults"];
  if (effective.globalPath !== undefined) {
    parts.push(`global(${effective.globalPath})`);
  }
  parts.push(
    effective.projectTrusted
      ? `project(${effective.projectPath ?? "n/a"})`
      : "project: skipped (untrusted)",
  );
  const chain = `sources: ${parts.join(" → ")}`;
  if (!keptLastKnownGood) return chain;
  // 不正 layer により以前の設定を維持している。出所と最新の問題を両方示す。
  return `${chain} (kept last-known-good; config problem: ${describeConfigValidity(resolved)})`;
}

function describeConfigValidity(resolved: ResolvedConfig | undefined): string {
  if (resolved === undefined) return "not loaded";
  if (resolved.problems.length === 0) return "valid";
  return `valid with ${resolved.problems.length} problem(s): ${resolved.problems
    .map((p) => `${p.scope}/${p.code}`)
    .join(", ")}`;
}

/** doctor の gate CLI 適合表示。digest 検証は実施する（モデル呼び出し 0 回）。 */
async function describeGateCli(executable: string | undefined): Promise<string> {
  if (executable === undefined) return "not configured (CLI 適合: unverified)";
  const digest = await verifyExecutableDigest(executable, PINNED_GATE_SHA256);
  if (digest.ok) return `${executable} (digest verified: ${PINNED_GATE_SHA256.slice(0, 8)}…)`;
  if (digest.code === "digest-mismatch") {
    return `${executable} — digest MISMATCH against pinned ${PINNED_GATE_SHA256.slice(0, 8)}… (CLI は実行しない)`;
  }
  return `${executable} — unreadable (${digest.code}); CLI 適合 unverified`;
}

function describeConflicts(ctxCwd: string, agentDir: string): string {
  // 既知の競合: 旧 pi-omplike-advisor、legacy jp-quality-gate Pi integration。
  // settings.json の extensions を best-effort で走査する（trust に関係なく
  // global settings の記録だけを見る。本文は読まない）。
  const found: string[] = [];
  for (const settingsPath of [
    joinPath(agentDir, "settings.json"),
    joinPath(ctxCwd, ".pi", "settings.json"),
  ]) {
    try {
      const text = readSettingsFile(settingsPath);
      if (text === undefined) continue;
      const extensions = parseExtensionNames(text);
      for (const name of extensions) {
        if (name.includes("pi-omplike-advisor") || name.includes("jp-quality-gate")) {
          found.push(`${settingsPath}: ${name}`);
        }
      }
    } catch {
      // 読めない設定は競合未検出として扱う（doctor は診断のみ）。
    }
  }
  return found.length > 0 ? `detected: ${found.join(", ")}` : "none detected (best-effort scan)";
}

import { readFileSync as readFileSetting } from "node:fs";
import { join as joinPath } from "node:path";

function readSettingsFile(path: string): string | undefined {
  try {
    return readFileSetting(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseExtensionNames(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { extensions?: unknown; packages?: unknown };
    const names: string[] = [];
    for (const key of ["extensions", "packages"] as const) {
      const value = parsed[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (typeof item === "string") names.push(item);
        else if (item !== null && typeof item === "object" && typeof (item as { source?: unknown }).source === "string") {
          names.push((item as { source: string }).source);
        }
      }
    }
    return names;
  } catch {
    return [];
  }
}
