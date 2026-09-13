/**
 * 設定 schema version 2（設計書 第27章、Issue #4）。
 *
 * validator は設計書 §27.1 の schema 全体を既知 key として受け付ける
 * （advisor の詳細設定・japanese.model・gate の args/failurePolicy/サイズ上限・
 * formatter の backend/timeout/上限・ui・finalization を含む）。
 * 未知 key / 未対応値は拒否し、安全性保護の緩和は明示的に拒否する。
 *
 * 受け付けと有効化を分ける: advisor の詳細値は schema 上正当でも
 * `advisor.enabled=true` は初回リリースでは拒否する（未実装機能の有効化禁止）。
 *
 * validateQualityFlowConfig() は raw を既定値で補完した完全な
 * QualityFlowConfig を返す。解決順（defaults → global → project）の
 * merge は正規化済みオブジェクトに対して行う。
 */

export const SCHEMA_VERSION = 2;
/** 原文上限の受け付け上限。これを超える設定は拒否する（設計書 第19章）。 */
export const MAX_SOURCE_BYTES_LIMIT = 8192;

export type CloudEgress = "allow" | "deny";
export type JapaneseMode = "off" | "gate" | "always";
export type GateTrigger = "errors" | "any";

export interface ModelRef {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export interface RoleAllowlists {
  advisor: string[];
  formatter: string[];
}

export interface SecurityConfig {
  cloudEgress: CloudEgress;
  allowedModels: RoleAllowlists;
  allowProjectModelOverride: boolean;
  allowProjectExecutableOverride: boolean;
  allowProjectPromptOverride: boolean;
}

export interface FinalizationConfig {
  deadlineMs: number;
}

export interface GateConfig {
  enabled: boolean;
  command: string;
  args: string[];
  timeoutMs: number;
  trigger: GateTrigger;
  failurePolicy: "original";
  maxInputBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface FormatterConfig {
  backend: string;
  timeoutMs: number;
  maxPasses: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  protectCode: boolean;
  protectUrls: boolean;
  protectPaths: boolean;
  protectNumbers: boolean;
  protectQuotedText: boolean;
}

export interface AdoptionConfig {
  rejectStructuralRegression: boolean;
  rejectQualityRegression: boolean;
  rejectNewErrors: boolean;
  forbidNewRules: string[];
  acceptImprovement: boolean;
}

export interface AdvisorDetailConfig {
  /** validator は受けるが、enabled=true は初回リリースでは拒否（Issue #4）。 */
  enabled: boolean;
  mode?: string;
  model?: ModelRef;
  blockOn?: string[];
  terminalNitBehavior?: string;
  finalBarrierTimeoutMs?: number;
  maxTechnicalCorrectionRounds?: number;
  maxSameFindingResends?: number;
  maxReviewCallsPerRun?: number;
  totalReviewBudgetMs?: number;
  dropLanguageAdvice?: boolean;
  failurePolicy?: string;
  onBudgetExhausted?: string;
  watchdogFile?: string;
}

export interface JapaneseConfig {
  enabled: boolean;
  deadlineMs: number;
  maxSourceBytes: number;
  mode: JapaneseMode;
  profile: string;
  model?: ModelRef;
  gate: GateConfig;
  formatter: FormatterConfig;
  adoption: AdoptionConfig;
}

export interface UiConfig {
  notifyOnRewrite: boolean;
  notifyOnFailure: boolean;
  showStatus: boolean;
}

export interface QualityFlowConfig {
  schemaVersion: 2;
  enabled: boolean;
  finalization: FinalizationConfig;
  security: SecurityConfig;
  advisor: AdvisorDetailConfig;
  japanese: JapaneseConfig;
  ui: UiConfig;
  debug: boolean;
}

/** 正当な設定値の初期値（packaged defaults、設計書 §27.1 / 第51章）。 */
export const DEFAULT_CONFIG: QualityFlowConfig = {
  schemaVersion: 2,
  enabled: true,
  finalization: { deadlineMs: 90_000 },
  security: {
    cloudEgress: "deny",
    allowedModels: { advisor: [], formatter: [] },
    allowProjectModelOverride: false,
    allowProjectExecutableOverride: false,
    allowProjectPromptOverride: false,
  },
  advisor: { enabled: false },
  japanese: {
    enabled: true,
    deadlineMs: 10_000,
    maxSourceBytes: 8192,
    mode: "always",
    profile: "tech-minimal",
    gate: {
      enabled: true,
      command: "jp-quality-gate",
      args: [],
      timeoutMs: 30_000,
      trigger: "any",
      failurePolicy: "original",
      maxInputBytes: 131_072,
      maxStdoutBytes: 262_144,
      maxStderrBytes: 16_384,
    },
    formatter: {
      backend: "stateless-api",
      timeoutMs: 60_000,
      maxPasses: 1,
      maxInputBytes: 131_072,
      maxOutputBytes: 262_144,
      protectCode: true,
      protectUrls: true,
      protectPaths: true,
      protectNumbers: true,
      protectQuotedText: true,
    },
    adoption: {
      rejectStructuralRegression: true,
      rejectQualityRegression: true,
      rejectNewErrors: true,
      forbidNewRules: [],
      acceptImprovement: true,
    },
  },
  ui: { notifyOnRewrite: false, notifyOnFailure: true, showStatus: true },
  debug: false,
};

export interface ConfigIssue {
  path: string;
  code: "unknown-key" | "invalid-value" | "rejected";
  message: string;
}

export type ValidatedConfig =
  | { ok: true; config: QualityFlowConfig }
  | { ok: false; issues: ConfigIssue[] };

/** 設定可能な値は設計書 §27.1 の例に固定する（対応値の拡大は適合試験時に追加）。 */
const KNOWN_PROFILES = new Set(["tech-minimal"]);
const KNOWN_FORMATTER_BACKENDS = new Set(["stateless-api"]);
/** pi-ai の ThinkingLevel（対応値の拡大は pi-ai の型に従う）。 */
const KNOWN_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** advisor の詳細値は §27.1 の列挙値のみ受け付ける（制御の実装は Phase 2）。 */
const ADVISOR_ENUMS: Record<string, Set<string>> = {
  mode: new Set(["live"]),
  terminalNitBehavior: new Set(["record"]),
  failurePolicy: new Set(["fail-open"]),
  onBudgetExhausted: new Set(["record-unresolved"]),
};
const ADVISOR_BLOCKON_VALUES = new Set(["concern", "blocker"]);

export function validateQualityFlowConfig(raw: unknown): ValidatedConfig {
  const issues: ConfigIssue[] = [];
  const root = asObject(raw, "", issues);
  if (!root) return { ok: false, issues };

  checkUnknownKeys(root, new Set(Object.keys(DEFAULT_CONFIG)), "", issues);

  const config: QualityFlowConfig = structuredClone(DEFAULT_CONFIG);

  for (const [key, value] of Object.entries(root)) {
    switch (key) {
      case "schemaVersion": {
        if (value !== SCHEMA_VERSION) {
          issues.push(issue("", "invalid-value", `schemaVersion は ${SCHEMA_VERSION} のみ対応`));
        }
        break;
      }
      case "enabled":
      case "debug": {
        if (typeof value !== "boolean") {
          issues.push(issue(key, "invalid-value", "boolean であること"));
        } else {
          config[key] = value;
        }
        break;
      }
      case "finalization": {
        const obj = asObject(value, "finalization", issues);
        if (!obj) break;
        checkUnknownKeys(obj, new Set(["deadlineMs"]), "finalization", issues);
        const deadlineMs = readPositiveInt(obj, "deadlineMs", issues);
        if (deadlineMs !== undefined) config.finalization = { deadlineMs };
        break;
      }
      case "security": {
        const sec = readSecurity(value, issues);
        if (sec) config.security = sec;
        break;
      }
      case "advisor": {
        const adv = readAdvisor(value, issues);
        if (adv) config.advisor = adv;
        break;
      }
      case "japanese": {
        const jp = readJapanese(value, issues);
        if (jp) config.japanese = jp;
        break;
      }
      case "ui": {
        const ui = readUi(value, issues);
        if (ui) config.ui = ui;
        break;
      }
      default:
        break; // 未知 key は checkUnknownKeys で報告済み
    }
  }

  // 論理検査: gate 無効 + mode 非off は不正設定（設計書 第13章）。
  if (config.japanese.gate.enabled === false && config.japanese.mode !== "off") {
    issues.push(issue(
      "japanese.mode",
      "rejected",
      `gate.enabled=false のとき mode は off のみ（受け付けた値: ${config.japanese.mode}）`,
    ));
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config };
}

function readSecurity(value: unknown, issues: ConfigIssue[]): SecurityConfig | undefined {
  const obj = asObject(value, "security", issues);
  if (!obj) return undefined;
  checkUnknownKeys(
    obj,
    new Set([
      "cloudEgress", "allowedModels",
      "allowProjectModelOverride", "allowProjectExecutableOverride", "allowProjectPromptOverride",
    ]),
    "security",
    issues,
  );
  const sec: SecurityConfig = structuredClone(DEFAULT_CONFIG.security);
  const cloudEgress = obj["cloudEgress"];
  if (cloudEgress !== undefined) {
    if (cloudEgress !== "allow" && cloudEgress !== "deny") {
      issues.push(issue("security.cloudEgress", "invalid-value", "allow または deny"));
    } else {
      sec.cloudEgress = cloudEgress;
    }
  }
  const allowedModels = obj["allowedModels"];
  if (allowedModels !== undefined) {
    const allow = asObject(allowedModels, "security.allowedModels", issues);
    if (allow) {
      checkUnknownKeys(allow, new Set(["advisor", "formatter"]), "security.allowedModels", issues);
      for (const role of ["advisor", "formatter"] as const) {
        const list = allow[role];
        if (list === undefined) continue;
        if (isStringArray(list)) sec.allowedModels[role] = [...list];
        else issues.push(issue(`security.allowedModels.${role}`, "invalid-value", "string 配列であること"));
      }
    }
  }
  for (const key of [
    "allowProjectModelOverride", "allowProjectExecutableOverride", "allowProjectPromptOverride",
  ] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") {
      issues.push(issue(`security.${key}`, "invalid-value", "boolean であること"));
    } else {
      sec[key] = v;
    }
  }
  return sec;
}

function readAdvisor(value: unknown, issues: ConfigIssue[]): AdvisorDetailConfig | undefined {
  const obj = asObject(value, "advisor", issues);
  if (!obj) return undefined;
  checkUnknownKeys(obj, new Set(["enabled", "model", "finalBarrierTimeoutMs",
    "maxTechnicalCorrectionRounds", "maxSameFindingResends", "maxReviewCallsPerRun",
    "totalReviewBudgetMs", "dropLanguageAdvice", "mode", "blockOn", "terminalNitBehavior",
    "failurePolicy", "onBudgetExhausted", "watchdogFile"]), "advisor", issues);
  const advisor: AdvisorDetailConfig = structuredClone(DEFAULT_CONFIG.advisor);
  for (const key of Object.keys(ADVISOR_ENUMS)) {
    const v = obj[key];
    if (v === undefined) continue;
    const allowed = ADVISOR_ENUMS[key]!;
    if (typeof v !== "string" || !allowed.has(v)) {
      issues.push(issue(
        `advisor.${key}`,
        "invalid-value",
        `${[...allowed].join(" / ")} のみ（設計書 §27.1）`,
      ));
    } else {
      // SAFETY: key は AdvisorDetailConfig の実在 field に限定していない。
      // §27.1 の advisor 詳細（Phase 2 で実装）の間の値保持に使うための
      // インデックス書き込みで、field 名の整合は §27.1 の key 一覧と一致させている。
      (advisor as unknown as Record<string, unknown>)[key] = v;
    }
  }
  const blockOn = obj["blockOn"];
  if (blockOn !== undefined) {
    if (isStringArray(blockOn) && blockOn.every((v) => ADVISOR_BLOCKON_VALUES.has(v))) {
      advisor.blockOn = [...blockOn];
    } else {
      issues.push(issue(
        "advisor.blockOn",
        "invalid-value",
        `${[...ADVISOR_BLOCKON_VALUES].join(" / ")} の string 配列であること`,
      ));
    }
  }
  const watchdogFile = obj["watchdogFile"];
  if (watchdogFile !== undefined) {
    if (typeof watchdogFile !== "string" || watchdogFile === "") {
      issues.push(issue("advisor.watchdogFile", "invalid-value", "非空の string であること"));
    } else {
      advisor.watchdogFile = watchdogFile;
    }
  }
  for (const key of [
    "finalBarrierTimeoutMs", "maxTechnicalCorrectionRounds", "maxSameFindingResends",
    "maxReviewCallsPerRun", "totalReviewBudgetMs",
  ] as const) {
    const num = readPositiveInt(obj, key, issues);
    if (num !== undefined) {
      // SAFETY: 上の readPositiveInt の key は AdvisorDetailConfig の
      // 正当な field 名のみ（set リテラル）から来るため、インデックス書き込みは整合する。
      (advisor as unknown as Record<string, unknown>)[key] = num;
    }
  }
  const dropLanguageAdvice = obj["dropLanguageAdvice"];
  if (dropLanguageAdvice !== undefined) {
    if (typeof dropLanguageAdvice !== "boolean") {
      issues.push(issue("advisor.dropLanguageAdvice", "invalid-value", "boolean であること"));
    } else {
      advisor.dropLanguageAdvice = dropLanguageAdvice;
    }
  }
  const enabled = obj["enabled"];
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") {
      issues.push(issue("advisor.enabled", "invalid-value", "boolean であること"));
    } else if (enabled === true) {
      // 初回リリースは Advisor 未実装。有効化要求は拒否する（設計書 第27章）。
      issues.push(issue("advisor.enabled", "rejected", "General Advisor は初回リリースの対象外（Phase 2）"));
    } else {
      advisor.enabled = false;
    }
  }
  const model = obj["model"];
  if (model !== undefined) {
    const ref = readModelRef(model, "advisor.model", issues);
    if (ref) advisor.model = ref;
  }
  return advisor;
}

function readJapanese(value: unknown, issues: ConfigIssue[]): JapaneseConfig | undefined {
  const obj = asObject(value, "japanese", issues);
  if (!obj) return undefined;
  checkUnknownKeys(
    obj,
    new Set([
      "enabled", "deadlineMs", "maxSourceBytes", "mode", "profile", "model",
      "gate", "formatter", "adoption",
    ]),
    "japanese",
    issues,
  );
  const jp: JapaneseConfig = structuredClone(DEFAULT_CONFIG.japanese);

  const enabled = obj["enabled"];
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") issues.push(issue("japanese.enabled", "invalid-value", "boolean であること"));
    else jp.enabled = enabled;
  }
  const mode = obj["mode"];
  if (mode !== undefined) {
    if (mode !== "off" && mode !== "gate" && mode !== "always") {
      issues.push(issue("japanese.mode", "invalid-value", "off / gate / always のいずれか"));
    } else {
      jp.mode = mode;
    }
  }
  const profile = obj["profile"];
  if (profile !== undefined) {
    if (typeof profile !== "string" || !KNOWN_PROFILES.has(profile)) {
      issues.push(issue(
        "japanese.profile",
        "invalid-value",
        `${[...KNOWN_PROFILES].join(" / ")} のみ対応`,
      ));
    } else {
      jp.profile = profile;
    }
  }
  const deadlineMs = readPositiveInt(obj, "deadlineMs", issues);
  if (deadlineMs !== undefined) jp.deadlineMs = deadlineMs;
  const maxSourceBytes = readPositiveInt(obj, "maxSourceBytes", issues);
  if (maxSourceBytes !== undefined) {
    if (maxSourceBytes > MAX_SOURCE_BYTES_LIMIT) {
      issues.push(issue(
        "japanese.maxSourceBytes",
        "rejected",
        `${MAX_SOURCE_BYTES_LIMIT} bytes を超える上限は受け付けない`,
      ));
    } else {
      jp.maxSourceBytes = maxSourceBytes;
    }
  }
  const model = obj["model"];
  if (model !== undefined) {
    const ref = readModelRef(model, "japanese.model", issues);
    if (ref) jp.model = ref;
  }
  const gate = obj["gate"];
  if (gate !== undefined) {
    const g = readGate(gate, issues);
    if (g) jp.gate = g;
  }
  const formatter = obj["formatter"];
  if (formatter !== undefined) {
    const f = readFormatter(formatter, issues);
    if (f) jp.formatter = f;
  }
  const adoption = obj["adoption"];
  if (adoption !== undefined) {
    const a = readAdoption(adoption, issues);
    if (a) jp.adoption = a;
  }
  return jp;
}

function readGate(value: unknown, issues: ConfigIssue[]): GateConfig | undefined {
  const obj = asObject(value, "japanese.gate", issues);
  if (!obj) return undefined;
  checkUnknownKeys(
    obj,
    new Set([
      "enabled", "command", "args", "timeoutMs", "trigger", "failurePolicy",
      "maxInputBytes", "maxStdoutBytes", "maxStderrBytes",
    ]),
    "japanese.gate",
    issues,
  );
  const gate: GateConfig = structuredClone(DEFAULT_CONFIG.japanese.gate);
  const enabled = obj["enabled"];
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") issues.push(issue("japanese.gate.enabled", "invalid-value", "boolean であること"));
    else gate.enabled = enabled;
  }
  const command = obj["command"];
  if (command !== undefined) {
    if (typeof command !== "string" || command === "") {
      issues.push(issue("japanese.gate.command", "invalid-value", "非空の string であること"));
    } else {
      gate.command = command;
    }
  }
  const args = obj["args"];
  if (args !== undefined) {
    if (isStringArray(args)) gate.args = [...args];
    else issues.push(issue("japanese.gate.args", "invalid-value", "string 配列であること"));
  }
  const trigger = obj["trigger"];
  if (trigger !== undefined) {
    if (trigger !== "errors" && trigger !== "any") {
      issues.push(issue("japanese.gate.trigger", "invalid-value", "errors または any"));
    } else {
      gate.trigger = trigger;
    }
  }
  const failurePolicy = obj["failurePolicy"];
  if (failurePolicy !== undefined) {
    if (failurePolicy !== "original") {
      issues.push(issue(
        "japanese.gate.failurePolicy",
        "rejected",
        "original のみ（failOpen=true からの移行は設計書 第27.3章）",
      ));
    }
    // original は既定値どおり。
  }
  for (const key of ["timeoutMs", "maxInputBytes", "maxStdoutBytes", "maxStderrBytes"] as const) {
    const num = readPositiveInt(obj, key, issues);
    if (num !== undefined) gate[key] = num;
  }
  return gate;
}

function readFormatter(value: unknown, issues: ConfigIssue[]): FormatterConfig | undefined {
  const obj = asObject(value, "japanese.formatter", issues);
  if (!obj) return undefined;
  checkUnknownKeys(
    obj,
    new Set([
      "backend", "timeoutMs", "maxPasses", "maxInputBytes", "maxOutputBytes",
      "protectCode", "protectUrls", "protectPaths", "protectNumbers", "protectQuotedText",
    ]),
    "japanese.formatter",
    issues,
  );
  const fmt: FormatterConfig = structuredClone(DEFAULT_CONFIG.japanese.formatter);
  const backend = obj["backend"];
  if (backend !== undefined) {
    if (typeof backend !== "string" || !KNOWN_FORMATTER_BACKENDS.has(backend)) {
      issues.push(issue(
        "japanese.formatter.backend",
        "invalid-value",
        `${[...KNOWN_FORMATTER_BACKENDS].join(" / ")} のみ対応`,
      ));
    } else {
      fmt.backend = backend;
    }
  }
  const maxPasses = obj["maxPasses"];
  if (maxPasses !== undefined) {
    // 1 pass 以外は受け付けない（設計書 第18章・Issue #4）。
    if (maxPasses !== 1) {
      issues.push(issue("japanese.formatter.maxPasses", "rejected", "maxPasses は 1 のみ"));
    }
  }
  for (const key of ["timeoutMs", "maxInputBytes", "maxOutputBytes"] as const) {
    const num = readPositiveInt(obj, key, issues);
    if (num !== undefined) fmt[key] = num;
  }
  for (const key of [
    "protectCode", "protectUrls", "protectPaths", "protectNumbers", "protectQuotedText",
  ] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") {
      issues.push(issue(`japanese.formatter.${key}`, "invalid-value", "boolean であること"));
    } else if (v === false) {
      issues.push(issue(
        `japanese.formatter.${key}`,
        "rejected",
        "保護設定の無効化は拒否する（設計書 第27.2章）",
      ));
    }
    // true / 既定値のまま。
  }
  return fmt;
}

function readAdoption(value: unknown, issues: ConfigIssue[]): AdoptionConfig | undefined {
  const obj = asObject(value, "japanese.adoption", issues);
  if (!obj) return undefined;
  checkUnknownKeys(
    obj,
    new Set([
      "rejectStructuralRegression", "rejectQualityRegression", "rejectNewErrors",
      "forbidNewRules", "acceptImprovement",
    ]),
    "japanese.adoption",
    issues,
  );
  const adoption: AdoptionConfig = structuredClone(DEFAULT_CONFIG.japanese.adoption);
  for (const key of ["rejectStructuralRegression", "rejectQualityRegression", "rejectNewErrors"] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") {
      issues.push(issue(`japanese.adoption.${key}`, "invalid-value", "boolean であること"));
    } else if (v === false) {
      issues.push(issue(
        `japanese.adoption.${key}`,
        "rejected",
        "安全性保護の緩和は拒否する（設計書 第17.1章）",
      ));
    }
    // true のみ既定値どおり採用。
  }
  const forbidNewRules = obj["forbidNewRules"];
  if (forbidNewRules !== undefined) {
    if (isStringArray(forbidNewRules)) adoption.forbidNewRules = [...forbidNewRules];
    else issues.push(issue("japanese.adoption.forbidNewRules", "invalid-value", "string 配列であること"));
  }
  const acceptImprovement = obj["acceptImprovement"];
  if (acceptImprovement !== undefined) {
    if (typeof acceptImprovement !== "boolean") {
      issues.push(issue("japanese.adoption.acceptImprovement", "invalid-value", "boolean であること"));
    } else {
      adoption.acceptImprovement = acceptImprovement;
    }
  }
  return adoption;
}

function readUi(value: unknown, issues: ConfigIssue[]): UiConfig | undefined {
  const obj = asObject(value, "ui", issues);
  if (!obj) return undefined;
  checkUnknownKeys(obj, new Set(["notifyOnRewrite", "notifyOnFailure", "showStatus"]), "ui", issues);
  const ui: UiConfig = structuredClone(DEFAULT_CONFIG.ui);
  for (const key of ["notifyOnRewrite", "notifyOnFailure", "showStatus"] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") issues.push(issue(`ui.${key}`, "invalid-value", "boolean であること"));
    else ui[key] = v;
  }
  return ui;
}

function readModelRef(value: unknown, path: string, issues: ConfigIssue[]): ModelRef | undefined {
  const obj = asObject(value, path, issues);
  if (!obj) return undefined;
  checkUnknownKeys(obj, new Set(["provider", "modelId", "thinkingLevel"]), path, issues);
  const ref: ModelRef = {};
  for (const key of ["provider", "modelId"] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v === "") {
      issues.push(issue(`${path}.${key}`, "invalid-value", "非空の string であること"));
    } else {
      ref[key] = v;
    }
  }
  const thinkingLevel = obj["thinkingLevel"];
  if (thinkingLevel !== undefined) {
    if (typeof thinkingLevel !== "string" || !KNOWN_THINKING_LEVELS.has(thinkingLevel)) {
      issues.push(issue(
        `${path}.thinkingLevel`,
        "invalid-value",
        `${[...KNOWN_THINKING_LEVELS].join(" / ")} のいずれか`,
      ));
    } else {
      ref.thinkingLevel = thinkingLevel;
    }
  }
  return ref;
}

function readPositiveInt(
  obj: Record<string, unknown>,
  key: string,
  issues: ConfigIssue[],
): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    issues.push(issue(key, "invalid-value", "正の整数であること"));
    return undefined;
  }
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function asObject(value: unknown, path: string, issues: ConfigIssue[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(issue(path, "invalid-value", "オブジェクトであること"));
    return undefined;
  }
  return value as Record<string, unknown>;
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  path: string,
  issues: ConfigIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      issues.push(issue(path === "" ? key : `${path}.${key}`, "unknown-key", "未知の設定 key"));
    }
  }
}

function issue(path: string, code: ConfigIssue["code"], message: string): ConfigIssue {
  return { path: path === "" ? "(root)" : path, code, message };
}
