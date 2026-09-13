/**
 * 契約試験用: jp-quality-gate 実 binary の解決。
 *
 * JPQG_GATE_BIN 環境変数で上書きできる。既定は隣接リポジトリの
 * 固定版 binary（基準 commit dac0954）。digest が一致しない場合は
 * テストを失敗させる（固定版契約の維持）。
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { PINNED_GATE_SHA256, verifyExecutableDigest } from "../../src/jpqg/runner.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_GATE_BIN = join(REPO_ROOT, "..", "jp-quality-gate", "bin", "jp-quality-gate");

export const GATE_BIN = process.env.JPQG_GATE_BIN ?? DEFAULT_GATE_BIN;

export async function assertGateBinaryPinned(): Promise<void> {
  const result = await verifyExecutableDigest(GATE_BIN, PINNED_GATE_SHA256);
  assert.equal(
    result.ok,
    true,
    `jp-quality-gate binary digest mismatch (${result.ok ? "" : result.code}): ${GATE_BIN}`,
  );
}

// テストで断片化しがちな tmp 実行可能 file の作成を共通化する。
export async function writeExecutable(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

export async function createTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
