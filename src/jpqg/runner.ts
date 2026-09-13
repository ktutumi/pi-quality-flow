/**
 * jp-quality-gate CLI の実行（設計書 第15章）。
 *
 * - 検証済み executable を shell を介さず直接 spawn する
 * - args / env / cwd を固定し、optional lint（textlint / natural-japanese）を
 *   args と環境変数の両方から無効化する
 * - input 128 KiB / stdout 256 KiB / stderr 16 KiB / 30秒 の上限
 * - timeout / cancel では process group ごと停止する（子孫 process も含む）
 * - 不正 JSON / 余分な stdout / signal 終了 / 未知 exit はすべて失敗
 *
 * stderr 全文は通常ログに保存しない（設計書 第15.1章）。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { parseGateOutput, type ParsedGateReport } from "./schema.ts";

/** 基準 commit dac09548710b82333581fc2a3457c6346b628074 の実 binary digest。 */
export const PINNED_GATE_SHA256 =
  "fa3436f936962b990bb0bb6e1dd04a576f3b316ab72abad34a682deef4d1400f";

const INPUT_LIMIT_BYTES = 128 * 1024;
const STDOUT_LIMIT_BYTES = 256 * 1024;
const STDERR_LIMIT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
/** SIGTERM 後の強制終了までの猶予（設計書 第15.3章: 短く制限）。 */
const KILL_GRACE_MS = 500;

export interface RunGateOptions {
  executable: string;
  input: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 追加の環境変数。許可 list 外の key は無視され、JPQG_* は常に strip される。 */
  env?: Record<string, string>;
}

export type GateFailureCode =
  | "input-limit-exceeded"
  | "spawn-failed"
  | "stdin-write-failed"
  | "timeout"
  | "cancelled"
  | "output-limit-exceeded"
  | "stderr-limit-exceeded"
  | "signal-terminated"
  | "unknown-exit"
  | "invalid-json"
  | "cli-internal-error"
  | "schema-mismatch"
  | "exit-mismatch"
  | "unknown-version"
  | "digest-mismatch"
  | "read-failed";

export type GateRunResult =
  | { ok: true; report: ParsedGateReport }
  | { ok: false; code: GateFailureCode; message?: string };

/** optional lint を args と env の両方から無効化した固定実行条件。 */
const FIXED_ARGS = ["-textlint=false", "-natural-japanese=false"];

export async function runGate(options: RunGateOptions): Promise<GateRunResult> {
  if (options.signal?.aborted) {
    return { ok: false, code: "cancelled" };
  }
  const inputBytes = Buffer.byteLength(options.input, "utf8");
  if (inputBytes > INPUT_LIMIT_BYTES) {
    return { ok: false, code: "input-limit-exceeded", message: `${inputBytes} bytes` };
  }
  // digest 照合（readFile）と実行対象を同一の絶対パスに固定する。
  // 相対名は PATH 探索先が検証対象とずれ得るため拒否する。
  if (!isAbsolute(options.executable)) {
    return { ok: false, code: "spawn-failed", message: "executable must be an absolute path" };
  }

  const env = cleanGateEnv(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 暗黙の project config 読み込みを避けるため cwd を固定する（executable 隣接）。
  const cwd = dirname(options.executable);

  return await new Promise<GateRunResult>((resolve) => {
    // process group leader にして子孫ごと停止できるようにする。
    const child = spawn(options.executable, FIXED_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd,
      detached: true,
    });

    let settled = false;
    let killInitiated = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failure: { code: GateFailureCode; message?: string } | undefined;
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killTree = (): void => {
      killInitiated = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* 既に終了している */
      }
      killTimer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 既に終了している */
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const finish = (result: GateRunResult): void => {
      if (settled) return;
      settled = true;
      // kill 開始済みの場合は SIGKILL timer を解除しない。stdio を閉じた
      // TERM 耐性の子孫が leader 終了後に残留するのを防ぐ（timer は unref 済み）。
      if (!killInitiated && killTimer !== undefined) clearTimeout(killTimer);
      resolve(result);
    };

    const fail = (code: GateFailureCode, message?: string): void => {
      failure = { code, message };
      killTree();
    };

    const abortListener = (): void => {
      cancelled = true;
      killTree();
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (err) => {
      // spawn 失敗（ENOENT 等）。stdin write 失敗と区別しない必要はないが
      // error event はこの経路で届く。
      if (!settled) fail(options.signal?.aborted ? "cancelled" : "spawn-failed", err.message);
    });

    const accumulate = (
      target: "stdout" | "stderr",
      limit: number,
      code: GateFailureCode,
    ) => {
      return (chunk: Buffer): void => {
        if (failure || settled) return;
        const current = target === "stdout" ? stdout : stderr;
        if (current.length + chunk.length > limit) {
          fail(code);
          return;
        }
        if (target === "stdout") stdout = Buffer.concat([current, chunk]);
        else stderr = Buffer.concat([current, chunk]);
      };
    };

    child.stdout.on("data", accumulate("stdout", STDOUT_LIMIT_BYTES, "output-limit-exceeded"));
    child.stderr.on("data", accumulate("stderr", STDERR_LIMIT_BYTES, "stderr-limit-exceeded"));

    child.stdin.on("error", () => {
      // 書き込み先が既に閉じている場合も失敗扱い（切り詰めた入力で成功扱いしない）。
      if (!failure && !settled) fail("stdin-write-failed");
    });
    child.stdin.end(options.input, "utf8");

    child.on("close", (code, signalName) => {
      options.signal?.removeEventListener("abort", abortListener);
      clearTimeout(timer);
      if (settled) return;
      if (cancelled) return finish({ ok: false, code: "cancelled" });
      if (timedOut) return finish({ ok: false, code: "timeout" });
      if (failure) return finish({ ok: false, ...failure });
      if (signalName !== null) {
        return finish({ ok: false, code: "signal-terminated", message: signalName });
      }
      const parsed = parseGateOutput({ stdout: stdout.toString("utf8"), exitCode: code ?? -1 });
      if (!parsed.ok) {
        // stderr は機密性を考慮し全文を返さない。長すぎる場合は先頭のみ。
        const hint = stderr.length > 0 ? stderr.toString("utf8", 0, 200) : undefined;
        return finish({ ok: false, code: parsed.code, message: hint });
      }
      return finish({ ok: true, report: parsed.report });
    });
  });
}

/** JPQG_* を常に strip し、許可 list 外の環境変数を引き継がない。 */
const ENV_ALLOWLIST = new Set(["PATH", "LANG", "LC_ALL", "TZ"]);

function cleanGateEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (ENV_ALLOWLIST.has(key) && !key.startsWith("JPQG_")) env[key] = value;
    }
  }
  return env;
}

export type DigestCheckResult =
  | { ok: true }
  | { ok: false; code: "read-failed" | "digest-mismatch" };

/** executable の SHA-256 を検証する（検証済み binary の固定用）。 */
export async function verifyExecutableDigest(
  executable: string,
  expectedSha256: string,
): Promise<DigestCheckResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(executable);
  } catch {
    return { ok: false, code: "read-failed" };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256) {
    return { ok: false, code: "digest-mismatch" };
  }
  return { ok: true };
}
