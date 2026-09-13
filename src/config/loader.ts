/**
 * 設定の読み込みと解決（設計書 第27章、Issue #4）。
 *
 * 解決順: packaged defaults → global（agentDir/quality-flow.json）→
 * trusted project（cwd/.pi/quality-flow.json）。trust 不明 / 未信頼では
 * project layer を読まない。
 *
 * 制約:
 * - security は global-only。project の security は剥がして通知する
 * - project の model / gate executable / args は global の allowProject* 許可が
 *   ない限り剥がす（承認範囲の拡張を許さない）
 * - layer は raw JSON の overlay merge のうえ検証する。単独で正当な layer でも
 *   merge 結果が不正な場合は project layer を落として再解決する
 * - 不正 layer は last-known-good（より外側の layer）を維持し、問題を記録する
 * - 旧 key（rejectRegression / failOpen）は移行プレビュー付きで layer 不採用
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateQualityFlowConfig,
  type ConfigIssue,
  type QualityFlowConfig,
} from "./schema.ts";
import { detectLegacyKeys, type LegacyFinding } from "./legacy.ts";

export type ConfigLayerScope = "global" | "project";

export interface ConfigLayerProblem {
  scope: ConfigLayerScope | "merged";
  path: string;
  code:
    | "invalid-json"
    | "schema-invalid"
    | "legacy-config"
    | "project-stripped"
    | "invalid-combination"
    | "read-failed";
  issues: ConfigIssue[];
  legacy: LegacyFinding[];
}

export interface ConfigSourceInfo {
  /** 解決に使われた（あるいは試みた）layer の path。 */
  globalPath?: string;
  projectPath?: string;
  projectTrusted: boolean;
}

export interface ResolvedConfig {
  config: QualityFlowConfig;
  sources: ConfigSourceInfo;
  problems: ConfigLayerProblem[];
}

export interface LoadQualityFlowConfigInput {
  /** global 設定ディレクトリ（通常は getAgentDir()）。 */
  agentDir: string;
  /** project ルート（通常は ctx.cwd）。project 設定はここ/.pi/ から読む。 */
  cwd: string;
  /** project trust。false / 不明では project layer を読まない。 */
  projectTrusted: boolean;
}

interface LayerState {
  scope: ConfigLayerScope;
  path: string;
  /** overlay merge に使う raw 値。layer が不採用なら undefined。 */
  raw?: unknown;
}

export function loadQualityFlowConfig(input: LoadQualityFlowConfigInput): ResolvedConfig {
  const problems: ConfigLayerProblem[] = [];
  const sources: ConfigSourceInfo = { projectTrusted: input.projectTrusted };

  // ---- global layer -------------------------------------------------------
  const globalPath = join(input.agentDir, "quality-flow.json");
  sources.globalPath = globalPath;
  const global: LayerState = { scope: "global", path: globalPath };
  const globalRead = readLayer(globalPath, "global");
  if (!globalRead.ok) {
    if (globalRead.problem) problems.push(globalRead.problem);
  } else {
    const legacy = detectLegacyKeys(globalRead.value);
    if (legacy.length > 0) {
      problems.push({ scope: "global", path: globalPath, code: "legacy-config", issues: [], legacy });
    } else {
      const validated = validateQualityFlowConfig(globalRead.value);
      if (validated.ok) global.raw = globalRead.value;
      else {
        problems.push({
          scope: "global", path: globalPath, code: "schema-invalid",
          issues: validated.issues, legacy: [],
        });
      }
    }
  }

  // ---- trusted project layer ----------------------------------------------
  const project: LayerState = { scope: "project", path: "(not read)" };
  if (input.projectTrusted) {
    project.path = join(input.cwd, ".pi", "quality-flow.json");
    sources.projectPath = project.path;
    const read = readLayer(project.path, "project");
    if (!read.ok) {
      if (read.problem) problems.push(read.problem);
    } else {
      // 剥がし判断には global の許可 flag を使う（global 不採用時は defaults）。
      const baseForStrips = global.raw !== undefined
        ? validateQualityFlowConfig(global.raw)
        : validateQualityFlowConfig({});
      if (!baseForStrips.ok) {
        // 単独検証済みのため到達しない。fail-closed で剥がし判定を defaults に倒す。
      }
      const strips = {
        stripSecurity: true,
        allowModelOverride: baseForStrips.ok ? baseForStrips.config.security.allowProjectModelOverride : false,
        allowExecutableOverride: baseForStrips.ok ? baseForStrips.config.security.allowProjectExecutableOverride : false,
        // §27.2: 許可 flag があっても model は global allowlist 内のみ。
        formatterAllowlist: baseForStrips.ok
          ? baseForStrips.config.security.allowedModels.formatter
          : [],
      };
      const stripped = stripProjectExtensions(read.value, strips);
      if (stripped.stripped.length > 0) {
        problems.push({
          scope: "project", path: project.path, code: "project-stripped",
          issues: stripped.stripped, legacy: [],
        });
      }
      const legacy = detectLegacyKeys(stripped.value);
      if (legacy.length > 0) {
        problems.push({ scope: "project", path: project.path, code: "legacy-config", issues: [], legacy });
      } else {
        const validated = validateQualityFlowConfig(stripped.value);
        if (validated.ok) {
          project.raw = stripped.value;
          if (stripped.stripped.length > 0) {
            // 剥がしは layer 全体を無効にしない（正当部分は採用する）。
          }
        } else {
          problems.push({
            scope: "project", path: project.path, code: "schema-invalid",
            issues: validated.issues, legacy: [],
          });
        }
      }
    }
  }

  // ---- merge と検証（layer 単独では正当でも merge で不正になり得る） -------
  const survivors = [global, project].filter((l) => l.raw !== undefined);
  let mergedRaw: unknown = {};
  for (const layer of survivors) mergedRaw = mergeRaw(mergedRaw, layer.raw);

  const mergedValidated = validateQualityFlowConfig(mergedRaw);
  if (mergedValidated.ok) {
    // 不正組合せ（gate 無効 + mode 非off）は layer を捨てず、通知だけ出して
    // 自動修正を無効化する（mode 表: gate.enabled=false + gate/always）。
    if (!mergedValidated.config.japanese.gate.enabled && mergedValidated.config.japanese.mode !== "off") {
      problems.push({
        scope: "merged",
        path: "japanese.mode",
        code: "invalid-combination",
        issues: [],
        legacy: [],
      });
    }
    return { config: mergedValidated.config, sources, problems };
  }

  // cross-layer の不正。より内側の layer（project）を落として再解決する。
  if (project.raw !== undefined) {
    problems.push({
      scope: "project", path: project.path, code: "schema-invalid",
      issues: mergedValidated.issues, legacy: [],
    });
    const globalOnly = validateQualityFlowConfig(global.raw ?? {});
    if (globalOnly.ok) return { config: globalOnly.config, sources, problems };
  }
  // ここには到達しない（単独検証済みの layer の merge が返り値を壊さない）。
  const fallback = validateQualityFlowConfig({});
  if (!fallback.ok) throw new Error("packaged defaults failed validation");
  return { config: fallback.config, sources, problems };
}

type ReadLayerResult =
  | { ok: true; value: unknown }
  | { ok: false; problem?: ConfigLayerProblem };

function readLayer(path: string, scope: ConfigLayerScope): ReadLayerResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false };
    return { ok: false, problem: { scope, path, code: "read-failed", issues: [], legacy: [] } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: { scope, path, code: "invalid-json", issues: [], legacy: [] } };
  }
  return { ok: true, value: parsed };
}

/** JSON overlay merge の結果（設定候補の raw 値）。 */
type RawOverlay = Record<string, unknown> | unknown;

/** JSON overlay merge: オブジェクトは再帰的に merge、他は上書き、配列は置換。 */
function mergeRaw(base: RawOverlay, overlay: RawOverlay): RawOverlay {
  if (
    base !== null && typeof base === "object" && !Array.isArray(base) &&
    overlay !== null && typeof overlay === "object" && !Array.isArray(overlay)
  ) {
    const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
      merged[key] = key in merged ? mergeRaw(merged[key] as RawOverlay, value as RawOverlay) : value;
    }
    return merged;
  }
  return overlay;
}

interface ProjectStrips {
  stripSecurity: boolean;
  allowModelOverride: boolean;
  allowExecutableOverride: boolean;
  /** global の formatter allowlist。project model はここに含まれる場合のみ許可。 */
  formatterAllowlist: string[];
}

/**
 * project layer から global が許可していない拡張 key を剥がす。
 * security は常に剥がす（global-only、設計書 第27.2章）。
 */
function stripProjectExtensions(
  raw: unknown,
  strips: ProjectStrips,
): { value: unknown; stripped: ConfigIssue[] } {
  const strippedIssues: ConfigIssue[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: raw, stripped: strippedIssues };
  }
  const copy = structuredClone(raw) as Record<string, unknown>;

  if (strips.stripSecurity && copy["security"] !== undefined) {
    strippedIssues.push({ path: "security", code: "rejected", message: "security section removed" });
    delete copy["security"];
  }

  const japanese = copy["japanese"];
  if (japanese !== null && typeof japanese === "object" && !Array.isArray(japanese)) {
    const jpCopy = japanese as Record<string, unknown>;
    if (jpCopy["model"] !== undefined) {
      // §27.2: allowProjectModelOverride に加えて、project model は global
      // allowlist 内の provider/modelId でなければならない（承認範囲の拡張禁止）。
      const model = jpCopy["model"];
      const allowed =
        strips.allowModelOverride &&
        model !== null && typeof model === "object" && !Array.isArray(model) &&
        typeof (model as Record<string, unknown>)["provider"] === "string" &&
        typeof (model as Record<string, unknown>)["modelId"] === "string" &&
        strips.formatterAllowlist.includes(
          `${(model as Record<string, unknown>)["provider"]}/${(model as Record<string, unknown>)["modelId"]}`,
        );
      if (!allowed) {
        strippedIssues.push({
          path: "japanese.model",
          code: "rejected",
          message: strips.allowModelOverride
            ? "japanese.model removed (not in global formatter allowlist)"
            : "japanese.model removed (allowProjectModelOverride not granted)",
        });
        delete jpCopy["model"];
      }
    }
    const gate = jpCopy["gate"];
    if (gate !== null && typeof gate === "object" && !Array.isArray(gate)) {
      const gateCopy = gate as Record<string, unknown>;
      if (gateCopy["command"] !== undefined && !strips.allowExecutableOverride) {
        strippedIssues.push({ path: "japanese.gate.command", code: "rejected", message: "japanese.gate.command removed" });
        delete gateCopy["command"];
      }
      if (gateCopy["args"] !== undefined && !strips.allowExecutableOverride) {
        strippedIssues.push({ path: "japanese.gate.args", code: "rejected", message: "japanese.gate.args removed" });
        delete gateCopy["args"];
      }
    }
  }

  return { value: copy, stripped: strippedIssues };
}
