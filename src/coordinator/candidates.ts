/**
 * Coordinator candidate ledger (Phase 0A)。
 *
 * - candidateId は session epoch / run / turn / sequence から決める。本文 hash からは作らない
 * - 本文が A → B に置換されても同じ回答候補（同一 candidateId）
 * - 同じ本文でも新 turn / 新 snapshot なら別の回答候補
 * - 台帳は上限付き（既定 128、turn_end で対応付け済みの記録から破棄。Issue #7）
 * 設計: docs/pi-quality-flow-design-v0.2.md 第8章、第33.3章。
 */

/** 台帳の既定上限。turn_end 対応待ちの記録を優先して保持する。 */
export const DEFAULT_LEDGER_LIMIT = 128;

export type CandidatePhase =
  | "claimed"
  | "formatted"
  | "unchanged"
  | "skipped"
  | "failed";

export interface CandidateRecord {
  candidateId: string;
  sessionEpoch: string;
  runIndex: number;
  turnIndex: number;
  candidateSequence: number;
  /** Executor 原文（回答候補の原文）の SHA-256。 */
  inputHash: string;
  /** 採用本文の SHA-256。未置換なら undefined。 */
  outputHash?: string;
  phase: CandidatePhase;
  /** 採用判断の理由コード（Phase 0A は formatted / unchanged / skipped）。 */
  reason: string;
  claimedAtMs: number;
}

/** single-flight 重複検出に使う最小の message 形状（AssistantMessage が構造的に適合）。 */
export interface CandidateMessageRef {
  readonly role: string;
  readonly content: readonly unknown[];
  readonly timestamp: number;
}

/** 同一 candidate の二重処理を防ぐ single-flight 用の claim 結果。 */
export type Claim =
  | { ok: true; record: CandidateRecord }
  | { ok: false; reason: "already-claimed" | "stale-session"; candidateId?: string };

export class CandidateLedger {
  private readonly candidates = new Map<string, CandidateRecord>();
  /** 置換後も同一視できるよう、pre-replacement の message オブジェクトを candidate に束縛する。 */
  private readonly messageToId = new WeakMap<CandidateMessageRef, string>();
  /** turn_end 対応付けが完了した candidateId（破棄候補の優先順位用）。 */
  private readonly mappedIds = new Set<string>();
  private readonly limit: number;
  private epoch = "";
  private runIndex = 0;
  private turnIndex = 0;
  private candidateSequence = 0;
  /** session epoch の通し番号（同一 session id の再読み込みでも進む）。 */
  private epochGeneration = 0;

  constructor(limit: number = DEFAULT_LEDGER_LIMIT) {
    this.limit = Math.max(1, limit);
  }

  /** session_start / session 切替で呼ぶ。旧 session の candidate をすべて無効化する。 */
  beginSession(sessionId: string): void {
    this.epochGeneration += 1;
    this.epoch = `${sessionId || "no-session"}#${this.epochGeneration}`;
    this.candidates.clear();
    this.mappedIds.clear();
    this.runIndex = 0;
    this.turnIndex = 0;
    this.candidateSequence = 0;
  }

  /** agent_start で進める run 連番。 */
  beginRun(): void {
    this.runIndex += 1;
    this.turnIndex = 0;
    this.candidateSequence = 0;
  }

  /** turn_start で Pi の turnIndex を追跡する。 */
  observeTurnStart(turnIndex: number): void {
    this.turnIndex = turnIndex;
    this.candidateSequence = 0;
  }

  get currentEpoch(): string {
    return this.epoch;
  }

  /**
   * candidate を確定して single-flight claim を取る。
   *
   * 同じ message オブジェクトの2回目の呼び出し（重複 event・再入）は
   * already-claimed。Pi 0.85.1 は message_end の置換を in-place で行うため、
   * 重複 delivery でも同一オブジェクトが渡されることを契約とする。
   * 直前に session が切り替わっていた場合は stale-session。
   */
  claim(input: {
    /** 重複検出のための message オブジェクト（identity 束縛用）。 */
    message: CandidateMessageRef;
    inputHash: string;
    claimedAtMs: number;
  }): Claim {
    const bound = this.messageToId.get(input.message);
    if (bound) {
      return { ok: false, reason: "already-claimed", candidateId: bound };
    }
    const candidateId = CandidateLedger.makeId(
      this.epoch,
      this.runIndex,
      this.turnIndex,
      this.candidateSequence,
    );
    if (this.epoch === "") {
      return { ok: false, reason: "stale-session", candidateId };
    }

    const record: CandidateRecord = {
      candidateId,
      sessionEpoch: this.epoch,
      runIndex: this.runIndex,
      turnIndex: this.turnIndex,
      candidateSequence: this.candidateSequence,
      inputHash: input.inputHash,
      phase: "claimed",
      reason: "claimed",
      claimedAtMs: input.claimedAtMs,
    };
    this.candidates.set(candidateId, record);
    this.messageToId.set(input.message, candidateId);
    this.candidateSequence += 1;
    this.evict();
    return { ok: true, record };
  }

  /** message オブジェクトから candidate を引く（turn_end の対応付け用。claim しない）。 */
  resolveByMessage(message: CandidateMessageRef): CandidateRecord | undefined {
    const candidateId = this.messageToId.get(message);
    const record = candidateId ? this.candidates.get(candidateId) : undefined;
    if (!candidateId || !record) return undefined;
    this.mappedIds.add(candidateId);
    this.evict();
    return record;
  }

  /**
   * 上限超過時の eviction。turn_end 対応済みの記録だけを破棄する（第33.3章）。
   * 未対応の記録は terminal event の関連付けに必要なため、上限を一時的に
   * 超えても保持する（対応付けが完了した時点で破棄する）。
   */
  private evict(): void {
    for (const id of this.mappedIds) {
      if (this.candidates.size <= this.limit) break;
      if (!this.candidates.has(id)) continue;
      this.candidates.delete(id);
      this.mappedIds.delete(id);
    }
  }

  /** 置換実行前に session epoch が変わっていないか検査する。 */
  isCurrent(record: CandidateRecord): boolean {
    return record.sessionEpoch === this.epoch && this.candidates.get(record.candidateId) === record;
  }

  commit(record: CandidateRecord, phase: CandidatePhase, reason: string, outputHash?: string): void {
    record.phase = phase;
    record.reason = reason;
    if (outputHash !== undefined) record.outputHash = outputHash;
  }

  find(candidateId: string): CandidateRecord | undefined {
    return this.candidates.get(candidateId);
  }

  get size(): number {
    return this.candidates.size;
  }

  static makeId(
    epoch: string,
    runIndex: number,
    turnIndex: number,
    candidateSequence: number,
  ): string {
    return `qf-candidate:${epoch}:run${runIndex}:turn${turnIndex}:seq${candidateSequence}`;
  }
}
