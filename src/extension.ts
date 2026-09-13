/**
 * pi-quality-flow Extension (Phase 0A)。
 *
 * 現在の範囲:
 * - terminal candidate の識別（正常 stop / 非空 text block 1つ / toolCall なし / 8 KiB 以内）
 * - candidateId と inputHash / outputHash の分離、single-flight claim
 * - `message_end` 返却 `{ message }` による本文 A → B の直接置換
 * - queued continuation が観測できる場合は置換を開始しない
 *
 * Phase 0A では日本語 Pipeline は未実装。既定の default export は fail-closed
 * （finalize を持たないため置換しない、candidate の観測のみ）。置換シームは
 * `createQualityFlowExtension({ finalize })` に限り、契約試験の harness だけが
 * mock finalizer を注入する（test/helpers/）。
 *
 * 設計: docs/pi-quality-flow-design-v0.2.md 第6・11・43.0章。
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CandidateLedger, type CandidateRecord } from "./coordinator/candidates.ts";
import {
  isEligibleTerminalCandidate,
  replaceSingleTextBlock,
  sha256Utf8,
} from "./pi/adapter.ts";
import { checkJapanese, type GateCheck } from "./japanese/service.ts";

/** Phase 0A の置換シーム。採用本文を返す。undefined は原文維持。 */
export type Finalizer = (input: {
  candidateId: string;
  originalText: string;
}) => string | undefined | Promise<string | undefined>;

export interface QualityFlowOptions {
  /** 省略時は fail-closed: どの candidate も置換しない。 */
  finalize?: Finalizer;
  /**
   * 固定版 jp-quality-gate の検証済み executable。
   * 省略時は日本語検証（自動 validation-only gate / 手動 check）を行わない。
   * 設定面の解決は Issue #4。
   */
  gateExecutable?: string;
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

/** message_end 処理の中核。Phase 0B 以降の非同期 stage 化は Issue #7。 */
export async function finalizeAssistantMessage(input: {
  message: AssistantMessage;
  pendingMessages: boolean;
  ledger: CandidateLedger;
  finalize?: Finalizer;
}): Promise<FinalizeResult> {
  const { message, pendingMessages, ledger, finalize } = input;
  const eligibility = isEligibleTerminalCandidate(message);
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

  if (!finalize) {
    // fail-closed: 観測のみ。candidate は識別・記録するが置換はしない。
    ledger.commit(record, "unchanged", "finalizer-not-configured", inputHash);
    return {
      outcome: "unchanged",
      reason: "finalizer-not-configured",
      candidateId: record.candidateId,
    };
  }

  const adopted = await finalize({
    candidateId: record.candidateId,
    originalText: eligibility.text,
  });
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

  const outputHash = sha256Utf8(adopted);
  ledger.commit(record, "formatted", "test-finalizer-adopted", outputHash);
  return {
    outcome: "formatted",
    reason: "test-finalizer-adopted",
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
  const { finalize, gateExecutable } = options;
  /** 日本語処理全体の初期上限（設計書 第32.1章）。設定面は Issue #4。 */
  const japaneseDeadlineMs = 10_000;

  /** check 結果を session entry に記録する（LLM context には participation しない）。 */
  const recordCheck = (
    pi: ExtensionAPI,
    source: "auto" | "manual",
    text: string | undefined,
    check:
      | { ok: true; check: GateCheck }
      | { ok: false; code: string },
  ): void => {
    if (!check.ok) {
      pi.appendEntry("pi-quality-flow:check", {
        source,
        scope: "editable-prose",
        status: "skipped",
        failureCode: check.code,
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

  return (pi: ExtensionAPI) => {
    const ledger = new CandidateLedger();
    /** 現在の final response（正常 stop の本文）。手動 check の対象。 */
    let lastFinalText: string | undefined;

    pi.on("session_start", (event, ctx) => {
      ledger.beginSession(ctx.sessionManager.getSessionId());
      // session switch / new / fork で旧 final response を破棄する（Issue #7 の先取り）。
      lastFinalText = undefined;
      // session_start の全 reason（startup / new / resume / fork / reload）を
      // 契約観測のため entry に残す。Phase 0A の観測対象。
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

      const result = await finalizeAssistantMessage({
        message,
        pendingMessages: ctx.hasPendingMessages(),
        ledger,
        finalize,
      });

      if (result.candidateId) {
        const record = ledger.find(result.candidateId);
        if (record) appendCandidateEntry(pi, record);
      }

      // 自動 validation-only gate（Issue #3）。
      // 置換があれば採用本文、なければ原文を検査する。本文は置換しない。
      if (gateExecutable) {
        const eligibility = isEligibleTerminalCandidate(message);
        const finalText = result.replacement?.text ?? (eligibility.ok ? eligibility.text : undefined);
        if (finalText !== undefined) {
          const check = await checkJapanese({
            text: finalText,
            executable: gateExecutable,
            signal: ctx.signal,
            timeoutMs: japaneseDeadlineMs,
          });
          recordCheck(pi, "auto", finalText, check);
        }
      }

      // 正常 stop の本文だけを手動 check の対象として追跡する。
      if (message.stopReason === "stop") {
        const texts = (message.content ?? [])
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text);
        const joined = texts.join("");
        if (joined.length > 0) lastFinalText = joined;
      }

      if (result.outcome !== "formatted" || !result.replacement) return undefined;
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

    // /quality japanese check: 現在の final response を read-only で検証する。
    // Advisor / Formatter / Executor を起動せず、過去の保存 message を変更しない。
    pi.registerCommand("quality", {
      description: "pi-quality-flow status / japanese check",
      handler: async (args, ctx) => {
        if (args.trim() !== "japanese check") {
          ctx.ui.notify("usage: /quality japanese check", "info");
          return;
        }
        if (!gateExecutable) {
          ctx.ui.notify("japanese gate is not configured", "warning");
          return;
        }
        // 現在の final response（正常 stop の本文）のみを対象にする。
        // 非アクティブ branch の履歴は参照しない。
        const lastText = lastFinalText;
        if (lastText === undefined) {
          ctx.ui.notify("no final response to check", "warning");
          return;
        }
        const check = await checkJapanese({
          text: lastText,
          executable: gateExecutable,
          signal: ctx.signal,
          timeoutMs: japaneseDeadlineMs,
        });
        recordCheck(pi, "manual", lastText, check);
        if (check.ok) {
          ctx.ui.notify(summarizeCheck(check.check), "info");
        } else {
          ctx.ui.notify(`japanese check failed: ${check.code}`, "error");
        }
      },
    });
  };
}
