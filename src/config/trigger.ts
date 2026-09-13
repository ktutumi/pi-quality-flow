/**
 * gate trigger 判定（設計書 第13章）。
 *
 * `errors` は正規化 errors があるとき、`any` は errors または warnings が
 * あるときに Formatter を trigger する。CLI の exit code だけで決めない。
 */

import type { GateTrigger } from "./schema.ts";
import type { GateScore } from "../jpqg/score.ts";

export function shouldTriggerFormatter(score: GateScore, trigger: GateTrigger): boolean {
  if (trigger === "errors") return score.errors > 0;
  return score.errors > 0 || score.warnings > 0;
}
