/**
 * GateScore の比較（設計書 第16.1章）。
 *
 * errors を先に、同数なら warnings を比較する lexicographic order。
 * 比較は副作用のない純粋関数に集約し、採用判断（decideAdoption、Issue #8）
 * から再利用する。
 */

export interface GateScore {
  errors: number;
  warnings: number;
}

/** a が b より良い（小さい）場合に負を返す lexicographic 比較。 */
export function compareScores(a: GateScore, b: GateScore): number {
  if (a.errors !== b.errors) return a.errors - b.errors;
  return a.warnings - b.warnings;
}

/** post score が pre より悪いか（第17.1章 順位6）。 */
export function isScoreRegression(pre: GateScore, post: GateScore): boolean {
  return compareScores(post, pre) > 0;
}
