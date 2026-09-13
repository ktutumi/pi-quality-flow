/**
 * 正規化済み設定オブジェクトの layer merge（defaults → global → project）。
 *
 * 各 layer は validateQualityFlowConfig() で完全に正規化されるため、
 * merge は既知 section 単位で override が存在すれば置き換える。
 * project の security は loader 側で剥がすためここでは扱わない。
 */

import type { QualityFlowConfig } from "./schema.ts";

/** override の section（存在するもの）で base を置き換えた完全な設定を返す。 */
export function deepMergeConfig(
  base: QualityFlowConfig,
  override: QualityFlowConfig | undefined,
): QualityFlowConfig {
  if (!override) return base;
  return {
    ...base,
    enabled: override.enabled,
    finalization: override.finalization,
    security: override.security,
    advisor: override.advisor,
    japanese: override.japanese,
    ui: override.ui,
    debug: override.debug,
  };
}
