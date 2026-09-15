/**
 * 採用決定表（設計書 第17章、Issue #8）。
 *
 * 副作用のない decideAdoption() に採用判断を集約する。決定表は上から順に
 * 評価し、最初に一致した行で決定する（PASS の判定を前に移動しない）。
 *
 * rejectStructuralRegression / rejectQualityRegression / rejectNewErrors は
 * 設定 schema で false を拒否済みのため、ここでは緩和分岐を持たない
 * （acceptImprovement だけが切り替え可能）。
 *
 * 検証状態: 原文を採用本文にする場合の検証結果は pre、修正案を採用する場合
 * は post とする。不採用にした修正案の post PASS を原文の PASS として
 * 転用しない（第17.3章）。
 */
import type { AdoptionConfig } from "../config/schema.ts";
import type { GateCheck } from "./service.ts";
import { compareScores, isScoreRegression, type GateScore } from "../jpqg/score.ts";

/** 決定表の評価に必要な入力（すべての検査の結果を渡す）。 */
export interface AdoptionInputs {
  /** 第1行: cancelled / stale / deadline 到達。 */
  invalidated?: "cancelled" | "stale" | "deadline";
  /** 第2行: backend の完了検査不合格（stop / 空 / toolCall / サイズ超過等）。 */
  outputInvalid?: string;
  /** 第3行: 保護領域・構造・意味リスク検査不合格。 */
  invariantViolation?: string;
  /** 第4行: gate 不正・診断不完全・policy 不一致・対応付け不能。 */
  gateUnusable?: string;
  /** 完全な pre gate 結果（原文の検証）。 */
  pre?: GateCheck;
  /** 完全な post gate 結果（修正案の検証）。 */
  post?: GateCheck;
  config: AdoptionConfig;
}

export type AdoptionDecision =
  | { result: "abort"; reason: string }
  | { result: "original"; reason: string; verification: "pre" }
  | {
      result: "adopt";
      reason: string;
      verification: "post";
      /** 採用時も post FAIL が残るか（acceptImprovement による部分改善）。 */
      remainingIssues: boolean;
    };

export function decideAdoption(input: AdoptionInputs): AdoptionDecision {
  // 1: cancelled / stale / deadline 到達 — 採用せず、後続処理を開始しない。
  if (input.invalidated) {
    return { result: "abort", reason: input.invalidated };
  }
  // 2: 異常終了、length、空出力、toolCall、サイズ超過。
  if (input.outputInvalid) {
    return original(`incomplete-or-invalid-output:${input.outputInvalid}`);
  }
  // 3: 保護領域、構造、意味リスク検査に不合格。
  if (input.invariantViolation) {
    return original(`unsafe-rewrite:${input.invariantViolation}`);
  }
  // 4: gate 不正、診断不完全、比較 policy 不一致、対応付け不能。
  if (input.gateUnusable) {
    return original(`gate-unusable:${input.gateUnusable}`);
  }
  const { pre, post, config } = input;
  if (!pre || !post) {
    return original("gate-unusable:missing-check");
  }
  if (pre.incomplete !== undefined || post.incomplete !== undefined) {
    return original(`gate-unusable:gate-diagnostics-incomplete`);
  }
  // 比較 policy の一致（第12.3章・第16.2章: 同じ CLI version / rule set / policy / scope）。
  if (pre.binaryVersion !== post.binaryVersion) {
    return original(`gate-unusable:binary-version-mismatch`);
  }
  if (pre.scope !== post.scope) {
    return original(`gate-unusable:scope-mismatch`);
  }
  if (pre.policyDigest !== post.policyDigest) {
    return original(`gate-unusable:policy-mismatch`);
  }

  // 5: 新規 error、または forbidNewRules の新規診断（multiset 比較）。
  const newForbidden = findNewDiagnostics(pre.diagnostics, post.diagnostics, config);
  if (newForbidden) {
    return original(`new-forbidden-diagnostic:${newForbidden}`);
  }

  // 6: post score が pre より悪い（PASS でも拒否）。
  if (isScoreRegression(pre.score, post.score)) {
    return original("quality-regression");
  }

  // 7: post PASS、かつここまでの検査に合格。同点 PASS の局所改善も採用。
  if (post.status === "pass") {
    return adopt("post-pass");
  }

  // 8: post FAIL、score 改善、acceptImprovement=true。残存問題ありとして記録。
  if (
    post.status === "fail" &&
    compareScores(post.score, pre.score) < 0 &&
    config.acceptImprovement
  ) {
    return adopt("post-fail-improved", true);
  }

  // 9: その他。
  return original("no-acceptable-improvement");
}

function original(reason: string): AdoptionDecision {
  return { result: "original", reason, verification: "pre" };
}

function adopt(reason: string, remainingIssues = false): AdoptionDecision {
  return { result: "adopt", reason, verification: "post", remainingIssues };
}

export type DiagnosticIdentity = {
  ruleId: string;
  severity: "error" | "warning";
  segmentId: string;
  issueKey: string;
};

/**
 * 新規 error / forbidNewRules の新規診断を multiset で検出する（第16.2章）。
 * identity は ruleId / segmentId / 正規化 issueKey。raw offset は照合に使わない。
 * 返り値は最初に見つかった違反の表示（ruleId または error:ruleId）。
 */
export function findNewDiagnostics(
  pre: ReadonlyArray<DiagnosticIdentity>,
  post: ReadonlyArray<DiagnosticIdentity>,
  config: AdoptionConfig,
): string | undefined {
  // multiset 照合: pre 側の残数を消費し、消費できない post の出現を新規とする。
  // severity も identity に含めるため、同一箇所の severity 変化は
  // warning→error の悪化として新規診断に分類される。
  const preRemaining = new Map<string, number>();
  for (const diagnostic of pre) {
    const key = identityKey(diagnostic);
    preRemaining.set(key, (preRemaining.get(key) ?? 0) + 1);
  }
  for (const diagnostic of post) {
    const key = identityKey(diagnostic);
    const remaining = preRemaining.get(key) ?? 0;
    if (remaining > 0) {
      preRemaining.set(key, remaining - 1);
      continue;
    }
    if (diagnostic.severity === "error") return `error:${diagnostic.ruleId}`;
    if (config.forbidNewRules.includes(diagnostic.ruleId)) return `forbidden:${diagnostic.ruleId}`;
  }
  return undefined;
}

function identityKey(diagnostic: DiagnosticIdentity): string {
  return `${diagnostic.ruleId}\u0000${diagnostic.segmentId}\u0000${diagnostic.severity}\u0000${diagnostic.issueKey}`;
}

/** スコア比較の再輸出（pipeline から使う）。 */
export { compareScores, isScoreRegression, type GateScore };
