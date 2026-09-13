/**
 * 改訂前設定の検出と移行プレビュー（設計書 第27.3章、Issue #4）。
 *
 * 旧 `rejectRegression` → `adoption.rejectQualityRegression`、
 * gate の `failOpen=true` → `gate.failurePolicy="original"` への明示的移行を
 * プレビューとして返す。旧 false の意味は推定しない（移行対象に含めない）。
 * 移行を適用して新 schema を書くかはユーザー判断であり、本実装は
 * 検出された layer を不採用にして last-known-good を維持する。
 */

export interface LegacyFinding {
  path: string;
  key: "rejectRegression" | "failOpen";
  /** 明示的移行先。旧 false は意味を推定しないため対象外。 */
  migration?: string;
}

export function detectLegacyKeys(raw: unknown, path = ""): LegacyFinding[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const findings: LegacyFinding[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const current = path === "" ? key : `${path}.${key}`;
    if (key === "rejectRegression") {
      findings.push({
        path: current,
        key: "rejectRegression",
        migration: value === true ? "japanese.adoption.rejectQualityRegression=true" : undefined,
      });
    } else if (key === "failOpen") {
      findings.push({
        path: current,
        key: "failOpen",
        migration: value === true ? 'japanese.gate.failurePolicy="original"' : undefined,
      });
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      findings.push(...detectLegacyKeys(value, current));
    }
  }
  return findings;
}
