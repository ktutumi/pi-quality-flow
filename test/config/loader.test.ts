/**
 * 単体試験: 設定の読み込みと解決（Issue #4）。
 *
 * - defaults → global → trusted project の解決順
 * - trust 不明 / 未信頼では project layer を読まない（global のみ）
 * - 不正 layer は last-known-good を維持し問題を記録する
 * - security は global-only、project の model / executable は global 許可がないと剥がす
 * - project の behavior override は global の他の設定を壊さない（overlay merge）
 * - 旧 key（rejectRegression / failOpen）は移行プレビュー付きで layer 不採用
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadQualityFlowConfig } from "../../src/config/loader.ts";
import { DEFAULT_CONFIG } from "../../src/config/schema.ts";

async function makeEnv(): Promise<{ agentDir: string; cwd: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-qf-config-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return {
    agentDir,
    cwd,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const writeGlobal = async (agentDir: string, value: unknown): Promise<void> => {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "quality-flow.json"), JSON.stringify(value, null, 2), "utf8");
};

const writeProject = async (cwd: string, value: unknown): Promise<void> => {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "quality-flow.json"), JSON.stringify(value, null, 2), "utf8");
};

test("ファイルなしは defaults になる", async () => {
  const env = await makeEnv();
  try {
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.equal(result.problems.length, 0);
  } finally {
    await env.cleanup();
  }
});

test("global → trusted project の overlay 解決（他の global 値を壊さない）", async () => {
  const env = await makeEnv();
  try {
    await writeGlobal(env.agentDir, {
      security: {
        cloudEgress: "allow",
        allowedModels: { advisor: [], formatter: ["pi-gemini/gemini-flash-1"] },
        allowProjectExecutableOverride: true,
      },
      japanese: { deadlineMs: 5000 },
    });
    await writeProject(env.cwd, { japanese: { mode: "gate" } });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.equal(result.problems.length, 0, JSON.stringify(result.problems));
    assert.equal(result.config.security.cloudEgress, "allow", "global security が保持される");
    assert.deepEqual(
      result.config.security.allowedModels.formatter,
      ["pi-gemini/gemini-flash-1"],
      "global allowlist が保持される",
    );
    assert.equal(result.config.japanese.deadlineMs, 5000, "global の他の japanese 設定が保持される");
    assert.equal(result.config.japanese.mode, "gate", "project の behavior override が効く");
    assert.equal(result.config.japanese.gate.enabled, true, "project が触らない既定は保持される");
  } finally {
    await env.cleanup();
  }
});

test("未信頼では project layer を読まない（global のみ）", async () => {
  const env = await makeEnv();
  try {
    await writeProject(env.cwd, { japanese: { enabled: false } });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: false });
    assert.equal(result.config.japanese.enabled, true, "project 設定は読まれない");
    assert.equal(result.sources.projectPath, undefined);
  } finally {
    await env.cleanup();
  }
});

test("trust ありでも trust 不明を模倣した undefined は global のみ", async () => {
  const env = await makeEnv();
  try {
    const result = loadQualityFlowConfig({
      agentDir: env.agentDir,
      cwd: env.cwd,
      // trust が確認できない場合は global のみ（undefined は false 扱い）。
      projectTrusted: undefined as unknown as boolean,
    });
    assert.equal(result.sources.projectPath, undefined);
  } finally {
    await env.cleanup();
  }
});

test("不正な global layer は last-known-good（defaults）を維持し問題を記録する", async () => {
  const env = await makeEnv();
  try {
    await writeGlobal(env.agentDir, { unknownKey: true });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0]?.scope, "global");
    assert.equal(result.problems[0]?.code, "schema-invalid");
  } finally {
    await env.cleanup();
  }
});

test("JSON 崩れの global layer は defaults を維持する", async () => {
  const env = await makeEnv();
  try {
    await mkdir(env.agentDir, { recursive: true });
    await writeFile(join(env.agentDir, "quality-flow.json"), "{ not json", "utf8");
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.equal(result.problems[0]?.code, "invalid-json");
  } finally {
    await env.cleanup();
  }
});

test("不正な project layer は落とされ、global は維持される", async () => {
  const env = await makeEnv();
  try {
    await writeGlobal(env.agentDir, { japanese: { deadlineMs: 7000 } });
    await writeProject(env.cwd, { japanese: { maxSourceBytes: 99999 } });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.equal(result.config.japanese.deadlineMs, 7000);
    assert.equal(result.config.japanese.maxSourceBytes, 8192, "project の不正上限は適用されない");
    assert.equal(result.problems[0]?.scope, "project");
    assert.equal(result.problems[0]?.code, "schema-invalid");
  } finally {
    await env.cleanup();
  }
});

test("project の security は剥がされる（global-only）", async () => {
  const env = await makeEnv();
  try {
    await writeGlobal(env.agentDir, { security: { cloudEgress: "allow" } });
    await writeProject(env.cwd, { security: { cloudEgress: "deny" } });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.equal(result.config.security.cloudEgress, "allow", "project の security は採用されない");
    const stripped = result.problems.find((p) => p.code === "project-stripped");
    assert.ok(stripped, "剥がし通知が記録される");
    assert.ok(stripped.issues.some((i) => i.path === "security"));
  } finally {
    await env.cleanup();
  }
});

test("project の model / executable は global 許可がないと剥がされる", async () => {
  const env = await makeEnv();
  try {
    await writeProject(env.cwd, {
      japanese: {
        model: { provider: "pi-gemini", modelId: "gemini-flash-1" },
        gate: { command: "/usr/local/bin/jp-quality-gate" },
      },
    });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.equal(result.config.japanese.model, undefined);
    assert.equal(result.config.japanese.gate.command, "jp-quality-gate", "既定のまま");
    const stripped = result.problems.find((p) => p.code === "project-stripped");
    assert.ok(stripped);
    assert.ok(stripped.issues.some((i) => i.path === "japanese.model"));
    assert.ok(stripped.issues.some((i) => i.path === "japanese.gate.command"));
  } finally {
    await env.cleanup();
  }
});

test("global 許可 + allowlist 登録がある場合のみ project の model を受け付ける", async () => {
  const env = await makeEnv();
  try {
    await writeGlobal(env.agentDir, {
      security: {
        allowProjectModelOverride: true,
        allowedModels: { advisor: [], formatter: ["pi-gemini/gemini-flash-1"] },
      },
    });
    await writeProject(env.cwd, {
      japanese: { model: { provider: "pi-gemini", modelId: "gemini-flash-1" } },
    });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.equal(result.problems.some((p) => p.code === "project-stripped"), false, JSON.stringify(result.problems));
    assert.equal(result.config.japanese.model?.modelId, "gemini-flash-1");
  } finally {
    await env.cleanup();
  }
});

test("global 許可があっても allowlist 外の project model は剥がされる", async () => {
  const env = await makeEnv();
  try {
    await writeGlobal(env.agentDir, {
      security: {
        allowProjectModelOverride: true,
        allowedModels: { advisor: [], formatter: ["pi-gemini/gemini-flash-1"] },
      },
    });
    await writeProject(env.cwd, {
      japanese: { model: { provider: "pi-other", modelId: "other-1" } },
    });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.equal(result.config.japanese.model, undefined, "allowlist 外の model は採用されない");
    const stripped = result.problems.find((p) => p.code === "project-stripped");
    assert.ok(stripped);
    assert.ok(stripped.issues.some((i) => i.path === "japanese.model"));
  } finally {
    await env.cleanup();
  }
});

test("旧 rejectRegression / failOpen は移行プレビュー付きで layer 不採用になる", async () => {
  const env = await makeEnv();
  try {
    await writeGlobal(env.agentDir, {
      japanese: {
        gate: { failOpen: true },
        adoption: { rejectRegression: false },
      },
    });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    assert.deepEqual(result.config, DEFAULT_CONFIG, "旧設定は適用されない");
    const legacy = result.problems.find((p) => p.code === "legacy-config");
    assert.ok(legacy);
    const failOpen = legacy.legacy.find((l) => l.key === "failOpen");
    assert.equal(failOpen?.migration, 'japanese.gate.failurePolicy="original"', "failOpen=true の移行先を提示");
    const rejectRegression = legacy.legacy.find((l) => l.key === "rejectRegression");
    assert.equal(rejectRegression?.migration, undefined, "旧 false の意味は推定しない");
  } finally {
    await env.cleanup();
  }
});

test("layer 単独では正当でも merge で不正になる場合 project layer を落とす", async () => {
  const env = await makeEnv();
  try {
    await writeGlobal(env.agentDir, { japanese: { gate: { enabled: false } } });
    await writeProject(env.cwd, { japanese: { mode: "always" } });
    const result = loadQualityFlowConfig({ agentDir: env.agentDir, cwd: env.cwd, projectTrusted: true });
    // global 単独: gate off + mode always(default) は不正だが、global 単独検証では
    // mode が defaults の always になるため schema-invalid になる。
    // → global も落ち、defaults（gate on, mode always）が last-known-good。
    assert.equal(result.config.japanese.mode, "always");
    assert.equal(result.config.japanese.gate.enabled, true);
    assert.ok(result.problems.length >= 1);
  } finally {
    await env.cleanup();
  }
});
