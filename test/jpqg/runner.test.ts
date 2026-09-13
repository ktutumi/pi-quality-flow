/**
 * 契約試験: jp-quality-gate CLI runner（設計書 第15章）。
 *
 * 基準 commit dac09548710b82333581fc2a3457c6346b628074 の実 binary を
 * digest 固定で直接 spawn する。args / env / cwd を固定し、optional lint を
 * args と環境変数の両方から無効化する。
 *
 * 異常系（timeout / cancel / 上限超過 / signal）はテスト用の実行可能 file
 * （shebang 付き shell script）で再現する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runGate } from "../../src/jpqg/runner.ts";
import { join } from "node:path";
import {
  GATE_BIN,
  assertGateBinaryPinned,
  createTempDir,
  removeDir,
  writeExecutable,
} from "../helpers/gate-bin.ts";

test("実 binary の digest が基準 commit のものと一致する", async () => {
  await assertGateBinaryPinned();
});

test("PASS テキストを exit 0 で検証する", async () => {
  const result = await runGate({ executable: GATE_BIN, input: "これはテストです。" });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.report.status, "pass");
});

test("簡体字 error を exit 1 で検出する", async () => {
  const result = await runGate({ executable: GATE_BIN, input: "これは简体字のテスト。" });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.report.status, "fail");
  assert.deepEqual(result.report.score, { errors: 1, warnings: 0 });
  assert.equal(result.report.issues[0]?.rule, "simplified_chinese_form");
});

test("optional lint を args と env の両方から無効化する", async () => {
  // JPQG_TEXTLINT=1 を env に注入しても runner が strip するため textlint は有効化されない。
  const result = await runGate({
    executable: GATE_BIN,
    input: "これはテストです。",
    env: { JPQG_TEXTLINT: "1", JPQG_NATURAL_JAPANESE: "1" },
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.report.status, "pass");
});

test("Unihan 49件は完全、50件は打切りを検出する", async () => {
  // Unihan rule のみが50件上限。CJ chinese_segment は別カウントのため filter する。
  const unihanRules = new Set(["simplified_chinese_form", "chinese_han_without_japanese_source"]);
  const ok = await runGate({ executable: GATE_BIN, input: "简".repeat(49) });
  assert.ok(ok.ok);
  assert.equal(ok.report.issues.filter((i) => unihanRules.has(i.rule)).length, 49);

  const capped = await runGate({ executable: GATE_BIN, input: "简".repeat(50) });
  assert.ok(capped.ok);
  assert.equal(capped.report.issues.filter((i) => unihanRules.has(i.rule)).length, 50);
});

test("存在しない executable は spawn-failed", async () => {
  const result = await runGate({ executable: "/nonexistent/pi-qf-no-such-binary", input: "x" });
  assert.ok(!result.ok);
  assert.equal(result.code, "spawn-failed");
});

test("128 KiB 超の input は実行前に拒否する", async () => {
  const result = await runGate({ executable: GATE_BIN, input: "あ".repeat(70_000) });
  assert.ok(!result.ok);
  assert.equal(result.code, "input-limit-exceeded");
});

test("256 KiB 超の stdout は失敗にする", async () => {
  const dir = await createTempDir("pi-qf-runner-");
  try {
    const script = await writeExecutable(dir, "big-stdout.sh", "#!/bin/sh\ncat /dev/zero | head -c 300000 | tr '\\0' 'x'\n");
    const result = await runGate({ executable: script, input: "x" });
    assert.ok(!result.ok);
    assert.equal(result.code, "output-limit-exceeded");
  } finally {
    await removeDir(dir);
  }
});

test("timeout で実 process を停止する", async () => {
  const dir = await createTempDir("pi-qf-runner-");
  try {
    const marker = join(dir, "done");
    // SIGTERM を無視して 30 秒眠るスクリプト。SIGKILL でのみ死ぬ。
    const script = await writeExecutable(dir, "slow.sh", `#!/bin/sh\ntrap '' TERM\nsleep 30\ntouch "${marker}"\n`);
    const result = await runGate({ executable: script, input: "x", timeoutMs: 300 });
    assert.ok(!result.ok);
    assert.equal(result.code, "timeout");
    // 強制終了されたため marker は作られない（猶予後に kill された証拠）。
    await new Promise((r) => setTimeout(r, 300));
    const exists = await import("node:fs/promises").then((fs) => fs.stat(marker).then(() => true, () => false));
    assert.ok(!exists, "timeout 後も process が生存している");
  } finally {
    await removeDir(dir);
  }
});

test("cancel signal で実 process を停止する", async () => {
  const dir = await createTempDir("pi-qf-runner-");
  try {
    const script = await writeExecutable(dir, "slow.sh", "#!/bin/sh\ntrap '' TERM\nsleep 30\n");
    const controller = new AbortController();
    const pending = runGate({
      executable: script,
      input: "x",
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.ok(!result.ok);
    assert.equal(result.code, "cancelled");
  } finally {
    await removeDir(dir);
  }
});

test("signal 終了は失敗にする", async () => {
  const dir = await createTempDir("pi-qf-runner-");
  try {
    const script = await writeExecutable(dir, "selfkill.sh", "#!/bin/sh\nkill -TERM $$\n");
    const result = await runGate({ executable: script, input: "x" });
    assert.ok(!result.ok);
    assert.equal(result.code, "signal-terminated");
  } finally {
    await removeDir(dir);
  }
});

test("JSON 以外の余分な stdout は失敗にする", async () => {
  const dir = await createTempDir("pi-qf-runner-");
  try {
    const script = await writeExecutable(dir, "noisy.sh", '#!/bin/sh\necho noise\necho \'{"pass":true}\'\n');
    const result = await runGate({ executable: script, input: "x" });
    assert.ok(!result.ok);
    assert.equal(result.code, "invalid-json");
  } finally {
    await removeDir(dir);
  }
});

test("stdin を読まずに終了する process は失敗にする", async () => {
  const dir = await createTempDir("pi-qf-runner-");
  try {
    const script = await writeExecutable(dir, "noread.sh", "#!/bin/sh\nexit 2\n");
    const result = await runGate({ executable: script, input: "x" });
    assert.ok(!result.ok);
    assert.equal(result.code, "invalid-json");
  } finally {
    await removeDir(dir);
  }
});
