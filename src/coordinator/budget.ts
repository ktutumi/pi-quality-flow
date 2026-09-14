/**
 * StageBudget — candidate / japanese 処理の全体予算管理（Issue #7、設計書 第32.1章）。
 *
 * candidate 90秒・日本語処理10秒の全体予算を個別 stage 上限より優先する。
 * 各 stage の許可時間は個別上限・candidate 残り・japanese 残りの最小値とし、
 * 期限後は新 stage を開始しない（undefined を返す）。
 *
 * 時刻は注入可能にし、テストで決定論的に検証できるようにする。
 */

export interface StageBudgetOptions {
  candidateDeadlineMs: number;
  japaneseDeadlineMs: number;
  /** 基準時刻（ms）。省略時は Date.now()。 */
  now?: number;
}

export type BudgetExpiry = "candidate-deadline" | "japanese-deadline";

/**
 * 予算の残り時間を計算する（副作用のない純粋関数群）。
 * 時刻は呼び出し側から渡す（nowMs）。内部状態は japanese 開始時刻のみ。
 */
export class StageBudget {
  private readonly candidateStartMs: number;
  private japaneseStartMs: number | undefined;
  private readonly candidateDeadlineMs: number;
  private readonly japaneseDeadlineMs: number;

  constructor(options: StageBudgetOptions) {
    const base = options.now ?? Date.now();
    this.candidateStartMs = base;
    this.candidateDeadlineMs = options.candidateDeadlineMs;
    this.japaneseDeadlineMs = options.japaneseDeadlineMs;
  }

  /** japanese 処理の開始（編集可能範囲の解析開始）を記録する。 */
  markJapaneseStart(nowMs: number): void {
    if (this.japaneseStartMs === undefined) {
      this.japaneseStartMs = nowMs;
    }
  }

  get japaneseStarted(): boolean {
    return this.japaneseStartMs !== undefined;
  }

  /**
   * stage の許可時間（ms）。個別上限・candidate 残り・japanese 残りの最小値。
   * いずれかの予算が尽きていれば undefined（新 stage を開始しない）。
   */
  stageTimeoutMs(stageLimitMs: number, nowMs: number): number | undefined {
    const expiry = this.expiry(nowMs);
    if (expiry !== undefined) return undefined;
    const candidateRemaining = this.candidateStartMs + this.candidateDeadlineMs - nowMs;
    const limits = [stageLimitMs, candidateRemaining];
    if (this.japaneseStartMs !== undefined) {
      limits.push(this.japaneseStartMs + this.japaneseDeadlineMs - nowMs);
    }
    return Math.max(0, Math.min(...limits));
  }

  /** 予算が尽きていれば切れた予算の種別を返す（両方切れたら candidate を優先）。 */
  expired(nowMs: number): BudgetExpiry | undefined {
    const expiry = this.expiry(nowMs);
    if (expiry === "japanese" && this.candidateRemaining(nowMs) <= 0) {
      return "candidate-deadline";
    }
    return expiry === undefined ? undefined : expiry === "japanese" ? "japanese-deadline" : "candidate-deadline";
  }

  private expiry(nowMs: number): "candidate" | "japanese" | undefined {
    if (this.candidateRemaining(nowMs) <= 0) return "candidate";
    if (
      this.japaneseStartMs !== undefined &&
      this.japaneseStartMs + this.japaneseDeadlineMs - nowMs <= 0
    ) {
      return "japanese";
    }
    return undefined;
  }

  private candidateRemaining(nowMs: number): number {
    return this.candidateStartMs + this.candidateDeadlineMs - nowMs;
  }
}

export interface StageController {
  /** stage 実行に渡す signal（deadline・外部 abort の合成）。 */
  signal: AbortSignal;
  /** timer と listener を解放する（stage 終了時に必ず呼ぶ）。 */
  dispose(): void;
}

/**
 * stage 用の AbortController を作る。
 * deadline 到達・外部 signal の abort のいずれでも abort する。
 * dispose 後はどちらでも abort しない（stage 間で signal を再利用しない）。
 */
export function createStageController(options: {
  budget: StageBudget;
  /** deadline と合成する外部 signal（ctx.signal 等）。 */
  external?: AbortSignal;
  /** deadline の監視間隔（ms、既定 10）。テストで短くする。 */
  tickMs?: number;
  /** deadline 到達で abort したときに呼ぶ（切れた予算の種別を渡す）。 */
  onExpiry?: (expiry: BudgetExpiry) => void;
  /** 外部 signal の abort で abort したときに呼ぶ（user cancel）。 */
  onCancel?: () => void;
}): StageController {
  const controller = new AbortController();
  // 登録前に既に abort 済みの外部 signal は即時反映する（Escape 後の
  // controller 生成で gate / backend を開始させない）。
  if (options.external?.aborted) {
    controller.abort();
    options.onCancel?.();
    return {
      signal: controller.signal,
      dispose() {},
    };
  }
  const tickMs = options.tickMs ?? 10;
  // callback は controller の abort につき 1 回だけ呼ぶ（timer が期限後に
  // 再び発火しても onExpiry を繰り返さない）。
  let notified = false;
  const timer = setInterval(() => {
    if (notified) return;
    const expiry = options.budget.expired(Date.now());
    if (expiry !== undefined) {
      notified = true;
      options.onExpiry?.(expiry);
      controller.abort();
    }
  }, tickMs);
  timer.unref?.();
  const onExternalAbort = () => {
    if (notified) return;
    notified = true;
    options.onCancel?.();
    controller.abort();
  };
  options.external?.addEventListener("abort", onExternalAbort, { once: true });

  return {
    signal: controller.signal,
    dispose() {
      clearInterval(timer);
      options.external?.removeEventListener("abort", onExternalAbort);
    },
  };
}
