/**
 * 単体試験: 設定 schema version 2（Issue #4）。
 *
 * - 設計書 §27.1 の正規例を既知 key として受け付ける
 * - 未知 key / 未対応値 / 安全性保護の緩和を拒否する
 * - advisor.enabled=true / maxPasses≠1 / 保護 false / 原文 8 KiB 超を拒否する
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  MAX_SOURCE_BYTES_LIMIT,
  validateQualityFlowConfig,
} from "../../src/config/schema.ts";

test("空オブジェクトは defaults で正規化される", () => {
  const result = validateQualityFlowConfig({});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.config, DEFAULT_CONFIG);
});

test("設計書 §27.1 の正規例を受け付ける（advisor.enabled は false に置換）", () => {
  const canonical = {
    schemaVersion: 2,
    enabled: true,
    finalization: { deadlineMs: 90000 },
    security: {
      cloudEgress: "deny",
      allowedModels: { advisor: [], formatter: [] },
      allowProjectModelOverride: false,
      allowProjectExecutableOverride: false,
      allowProjectPromptOverride: false,
    },
    advisor: {
      enabled: false,
      mode: "live",
      model: { provider: "pi-example", modelId: "example-1", thinkingLevel: "medium" },
      blockOn: ["concern", "blocker"],
      terminalNitBehavior: "record",
      finalBarrierTimeoutMs: 60000,
      maxTechnicalCorrectionRounds: 2,
      maxSameFindingResends: 1,
      maxReviewCallsPerRun: 8,
      totalReviewBudgetMs: 120000,
      dropLanguageAdvice: true,
      failurePolicy: "fail-open",
      onBudgetExhausted: "record-unresolved",
      watchdogFile: "WATCHDOG.md",
    },
    japanese: {
      enabled: true,
      deadlineMs: 10000,
      maxSourceBytes: 8192,
      mode: "always",
      profile: "tech-minimal",
      model: { provider: "pi-example", modelId: "flash-1", thinkingLevel: "low" },
      gate: {
        enabled: true,
        command: "jp-quality-gate",
        args: [],
        timeoutMs: 30000,
        trigger: "any",
        failurePolicy: "original",
        maxInputBytes: 131072,
        maxStdoutBytes: 262144,
        maxStderrBytes: 16384,
      },
      formatter: {
        backend: "stateless-api",
        timeoutMs: 60000,
        maxPasses: 1,
        maxInputBytes: 131072,
        maxOutputBytes: 262144,
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
  const result = validateQualityFlowConfig(canonical);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  if (!result.ok) return;
  assert.equal(result.config.japanese.model?.modelId, "flash-1");
  assert.equal(result.config.japanese.gate.maxInputBytes, 131072);
  assert.equal(result.config.advisor.watchdogFile, "WATCHDOG.md");
});

test("未知 key を拒否する", () => {
  const result = validateQualityFlowConfig({ unknownTopKey: 1 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues[0]?.code, "unknown-key");
  assert.equal(result.issues[0]?.path, "unknownTopKey");

  const nested = validateQualityFlowConfig({ japanese: { typo: true } });
  assert.equal(nested.ok, false);
  if (nested.ok) return;
  assert.equal(nested.issues[0]?.path, "japanese.typo");
});

test("advisor.enabled=true を拒否する（初回リリース対象外）", () => {
  const result = validateQualityFlowConfig({ advisor: { enabled: true } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.issues[0]?.path, "advisor.enabled");
  assert.equal(result.issues[0]?.code, "rejected");
});

test("maxPasses≠1 を拒否する", () => {
  for (const value of [0, 2, 1.5]) {
    const result = validateQualityFlowConfig({ japanese: { formatter: { maxPasses: value } } });
    assert.equal(result.ok, false, `maxPasses=${value}`);
    if (result.ok) continue;
    assert.ok(result.issues.some((i) => i.path === "japanese.formatter.maxPasses" && i.code === "rejected"));
  }
});

test("保護設定の false（緩和）を拒否する", () => {
  for (const key of ["protectCode", "protectUrls", "protectPaths", "protectNumbers", "protectQuotedText"] as const) {
    const result = validateQualityFlowConfig({ japanese: { formatter: { [key]: false } } });
    assert.equal(result.ok, false, key);
    if (result.ok) continue;
    assert.ok(result.issues.some((i) => i.path === `japanese.formatter.${key}` && i.code === "rejected"));
  }
});

test("安全性保護の緩和（adoption の false）を拒否する", () => {
  for (const key of ["rejectStructuralRegression", "rejectQualityRegression", "rejectNewErrors"] as const) {
    const result = validateQualityFlowConfig({ japanese: { adoption: { [key]: false } } });
    assert.equal(result.ok, false, key);
    if (result.ok) continue;
    assert.ok(result.issues.some((i) => i.path === `japanese.adoption.${key}` && i.code === "rejected"));
  }
});

test("原文上限: 8192 は受理、8193 は拒否", () => {
  assert.equal(MAX_SOURCE_BYTES_LIMIT, 8192);
  const ok = validateQualityFlowConfig({ japanese: { maxSourceBytes: 8192 } });
  assert.equal(ok.ok, true);
  const ng = validateQualityFlowConfig({ japanese: { maxSourceBytes: 8193 } });
  assert.equal(ng.ok, false);
  if (ng.ok) return;
  assert.ok(ng.issues.some((i) => i.path === "japanese.maxSourceBytes" && i.code === "rejected"));
});

test("gate 無効 + mode 非off の組合せは schema では受理し loader で通知する", () => {
  // mode 表どおり「自動修正を無効化し通知」で扱う（layer は捨てない）。
  for (const mode of ["gate", "always"] as const) {
    const result = validateQualityFlowConfig({ japanese: { gate: { enabled: false }, mode } });
    assert.equal(result.ok, true, mode);
  }
});

test("mode / trigger / cloudEgress / thinkingLevel / profile / backend の未対応値を拒否する", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ japanese: { mode: "auto" } }, "japanese.mode"],
    [{ japanese: { gate: { trigger: "all" } } }, "japanese.gate.trigger"],
    [{ security: { cloudEgress: "maybe" } }, "security.cloudEgress"],
    [{ japanese: { model: { thinkingLevel: "ultra" } } }, "japanese.model.thinkingLevel"],
    [{ japanese: { profile: "stylistic" } }, "japanese.profile"],
    [{ japanese: { formatter: { backend: "agentic-loop" } } }, "japanese.formatter.backend"],
    [{ japanese: { gate: { failurePolicy: "fail-open" } } }, "japanese.gate.failurePolicy"],
  ];
  for (const [raw, path] of cases) {
    const result = validateQualityFlowConfig(raw);
    assert.equal(result.ok, false, path);
    if (result.ok) continue;
    assert.ok(result.issues.some((i) => i.path === path), `${path}: ${JSON.stringify(result.issues)}`);
  }
});

test("許可助詞 pattern 以外の拒否 rule リスト（forbidNewRules）と acceptImprovement 切替は受け付ける", () => {
  const result = validateQualityFlowConfig({
    japanese: { adoption: { forbidNewRules: ["simplified_chinese_form"], acceptImprovement: false } },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.config.japanese.adoption.forbidNewRules, ["simplified_chinese_form"]);
  assert.equal(result.config.japanese.adoption.acceptImprovement, false);
});

test("advisor の列挙値は §27.1 の値のみ受け付ける", () => {
  const bad = validateQualityFlowConfig({ advisor: { mode: "shadow", blockOn: ["nit"] } });
  assert.equal(bad.ok, false);
  const good = validateQualityFlowConfig({ advisor: { blockOn: ["concern", "blocker"] } });
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.deepEqual(good.config.advisor.blockOn, ["concern", "blocker"]);
});

test("非オブジェクト / 型不一致を拒否する", () => {
  assert.equal(validateQualityFlowConfig(null).ok, false);
  assert.equal(validateQualityFlowConfig("x").ok, false);
  assert.equal(validateQualityFlowConfig([]).ok, false);
  const bool = validateQualityFlowConfig({ enabled: "yes" });
  assert.equal(bool.ok, false);
  if (bool.ok) return;
  assert.ok(bool.issues.some((i) => i.path === "enabled"));
});
