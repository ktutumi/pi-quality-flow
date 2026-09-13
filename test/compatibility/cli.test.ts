/**
 * 契約試験: 実 Pi 0.85.1 バイナリ（CLI）での5面一致。
 *
 * pi 実行形式で pi-quality-flow（finalize 注入版）と mock provider 拡張を読み込み、
 * 次の面を検証する:
 * - print mode（-p）: headless 出力が採用本文
 * - json mode（--mode json）: message_end.message / turn_end.message が採用本文
 * - rpc mode（--mode rpc）: RPC final event の message が採用本文
 * - 保存セッション（--session-dir）: session file が採用本文
 *
 * 環境変数で挙動を固定する。テスト専用ヘルパを -e で渡し、本番 default export は使わない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantText } from "../helpers/harness.ts";
import { GATE_BIN } from "../helpers/gate-bin.ts";
import { APPROVED_FORMATTER_CONFIG } from "../helpers/harness.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MOCK_EXT = join(ROOT, "test", "helpers", "mock-provider-extension.ts");
const FINALIZER_EXT = join(ROOT, "test", "helpers", "finalizer-extension.ts");
const PI_BIN = process.env.PI_BIN ?? "pi";

const ORIGINAL = "この実装方案では、APIの返却値を直接利用します。";
const ADOPTED = "この実装方針では、APIの返却値を直接利用します。";

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

async function runPi(
  dir: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 60_000,
): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, args, {
      cwd: join(dir, "project"),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(dir, "agent"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? -1,
      });
    });
  });
}

async function prepareDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-qf-cli-"));
  await mkdir(join(dir, "project"), { recursive: true });
  await mkdir(join(dir, "agent"), { recursive: true });
  // 採用シーム（finalizer-extension）は承認済み構成だけを対象にするため、
  // 固定版 binary と承認済み送信許可の設定を agent dir に書く。
  await writeFile(join(dir, "agent", "quality-flow.json"), JSON.stringify(APPROVED_FORMATTER_CONFIG), "utf8");
  return dir;
}

async function writeFixtures(dir: string): Promise<void> {
  await writeFile(
    join(dir, "mock-script.json"),
    JSON.stringify({
      responses: [
        { text: ORIGINAL, chunkCount: 3, chunkDelayMs: 10 },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "rewrite.json"),
    JSON.stringify({ adoptedText: ADOPTED }),
    "utf8",
  );
}

const COMMON_ENV = (dir: string): Record<string, string> => ({
  PI_QF_MOCK_SCRIPT: join(dir, "mock-script.json"),
  PI_QF_REWRITE_FILE: join(dir, "rewrite.json"),
  // 採用シームは pre gate が使える構成だけを対象にする（固定版 binary）。
  PI_QF_GATE_BIN: GATE_BIN,
});

const COMMON_ARGS = [
  "--no-extensions",
  "-e",
  MOCK_EXT,
  "-e",
  FINALIZER_EXT,
];

test("実行環境: pi バイナリは契約対象の 0.85.1", async () => {
  const dir = await prepareDir();
  try {
    const run = await runPi(dir, ["--version"], {}, 15_000);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /0\.85\.1/, `pi version は 0.85.1: ${run.stdout.slice(0, 100)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("print mode: headless 出力が採用本文", async () => {
  const dir = await prepareDir();
  try {
    await writeFixtures(dir);
    const run = await runPi(dir, [...COMMON_ARGS, "-p", "--no-session", "説明してください"], COMMON_ENV(dir));
    assert.equal(run.code, 0, `exit code: stderr=${run.stderr.slice(0, 500)}`);
    assert.ok(run.stdout.includes(ADOPTED), `stdout に採用本文: ${run.stdout}`);
    assert.ok(!run.stdout.includes(ORIGINAL), "stdout に原文が残らない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("json mode: message_end / turn_end が採用本文", async () => {
  const dir = await prepareDir();
  try {
    await writeFixtures(dir);
    const run = await runPi(dir, [...COMMON_ARGS, "--mode", "json", "--no-session", "説明してください"], COMMON_ENV(dir));
    assert.equal(run.code, 0, `exit code: stderr=${run.stderr.slice(0, 500)}`);

    const events = run.stdout
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } });

    const assistantEnd = events.find(
      (e) => e.type === "message_end" && e.message?.role === "assistant",
    );
    assert.ok(assistantEnd, "message_end(assistant) が存在する");
    assert.equal(assistantText(assistantEnd.message!), ADOPTED, "message_end.message は採用本文");

    const turnEnd = events.find((e) => e.type === "turn_end" && e.message?.role === "assistant");
    assert.ok(turnEnd, "turn_end が存在する");
    assert.equal(assistantText(turnEnd.message!), ADOPTED, "turn_end.message は採用本文");

    // usage・metadata 保持（json 面）
    const usage = (assistantEnd.message as unknown as { usage?: { input: number; output: number } }).usage;
    assert.ok(usage && usage.input === 10 && usage.output === 20, "usage が保持される");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rpc mode: RPC final event が採用本文", async () => {
  const dir = await prepareDir();
  try {
    await writeFixtures(dir);
    const child = spawn(
      PI_BIN,
      [...COMMON_ARGS, "--mode", "rpc", "--no-session"],
      {
        cwd: join(dir, "project"),
        env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", ...COMMON_ENV(dir) },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const lines: Array<Record<string, unknown>> = [];
    let buffer = "";
    let settled: () => void;
    const done = new Promise<void>((r) => (settled = r));
    child.stdout.on("data", (d) => {
      buffer += d.toString("utf8");
      let idx: number;
      // RPC フレーミングは LF のみ
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          lines.push(event);
          if (event.type === "turn_end" && (event.message as { role?: string })?.role === "assistant") {
            settled();
          }
        } catch {
          // 非JSON行は無視（プロトコル上は出ない）
        }
      }
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (d) => stderrChunks.push(d));
    // close 通知は spawn 直後に購読する（timeout で先に close しても待ち続けない）。
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    child.stdin.write(JSON.stringify({ id: "req-1", type: "prompt", message: "説明してください" }) + "\n");

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settled();
    }, 60_000);
    await done;
    clearTimeout(timer);
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    await closed;

    const assistantEnd = lines.find(
      (e) => e.type === "message_end" && (e.message as { role?: string })?.role === "assistant",
    ) as { message?: { content?: Array<{ type: string; text?: string }> } } | undefined;
    assert.ok(assistantEnd, `message_end(assistant) が存在する: stderr=${Buffer.concat(stderrChunks).toString().slice(0, 300)}`);
    assert.equal(assistantText(assistantEnd.message!), ADOPTED, "RPC の message_end.message は採用本文");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("保存セッション: session file が採用本文", async () => {
  const dir = await prepareDir();
  try {
    await writeFixtures(dir);
    const sessionDir = join(dir, "sessions");
    const run = await runPi(dir, [...COMMON_ARGS, "-p", "--session-dir", sessionDir, "説明してください"], COMMON_ENV(dir));
    assert.equal(run.code, 0, `exit code: stderr=${run.stderr.slice(0, 500)}`);

    const files = await readdir(sessionDir);
    const jsonl = files.filter((f) => f.endsWith(".jsonl"));
    assert.equal(jsonl.length, 1);

    const raw = await readFile(join(sessionDir, jsonl[0]), "utf8");
    const messages = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } })
      .filter((e) => e.type === "message" && e.message?.role === "assistant");
    assert.equal(messages.length, 1);
    assert.equal(assistantText(messages[0].message!), ADOPTED, "保存セッションは採用本文");
    assert.ok(!assistantText(messages[0].message!).includes(ORIGINAL), "原文は保存されない");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
