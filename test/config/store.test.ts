/**
 * 単体試験: 実行中の設定状態と configRevision（Issue #4）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { QualityFlowConfigStore } from "../../src/config/store.ts";

test("初期 snapshot は defaults・revision 0", () => {
  const store = new QualityFlowConfigStore();
  assert.equal(store.current.revision, 0);
  assert.equal(store.current.config.enabled, true);
  assert.equal(store.current.config.japanese.mode, "always");
});

test("reload と各変更で revision が進む", () => {
  const store = new QualityFlowConfigStore();
  const reloaded = store.reload(structuredClone(store.current.config), "session_start:startup");
  assert.equal(reloaded.revision, 1);

  const off = store.setEnabled(false, "command:/quality off");
  assert.equal(off.ok, true);
  if (!off.ok) return;
  assert.equal(off.snapshot.revision, 2);
  assert.equal(off.snapshot.config.enabled, false);
  assert.equal(off.snapshot.lastChangeReason, "command:/quality off");

  const mode = store.setJapaneseMode("gate", "command:/quality japanese mode gate");
  assert.equal(mode.ok, true);
  if (!mode.ok) return;
  assert.equal(mode.snapshot.revision, 3);
  assert.equal(mode.snapshot.config.japanese.mode, "gate");
  assert.equal(mode.snapshot.config.enabled, false, "他の変更を壊さない");

  const debug = store.setDebug(true, "command:/quality debug on");
  assert.equal(debug.ok, true);
  if (!debug.ok) return;
  assert.equal(debug.snapshot.config.debug, true);
  assert.equal(debug.snapshot.revision, 4);
});

test("isCurrent は旧 revision を拒否する（in-flight 無効化の鍵）", () => {
  const store = new QualityFlowConfigStore();
  const revision0 = store.current.revision;
  store.setEnabled(false, "off");
  assert.equal(store.isCurrent(revision0), false);
  assert.equal(store.isCurrent(store.current.revision), true);
});

test("gate 無効で mode gate/always への変更は拒否し last-known-good を維持する", () => {
  const store = new QualityFlowConfigStore();
  // gate を無効化した設定を再読み込みする。
  const config = structuredClone(store.current.config);
  config.japanese.gate.enabled = false;
  config.japanese.mode = "off"; // 単独では正当な組合せ
  store.reload(config, "test");

  const rejected = store.setJapaneseMode("always", "test-command");
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.match(rejected.reason, /mode must be off/);
  assert.equal(store.current.revision, 1, "拒否時は revision が進まない");
  assert.equal(store.current.config.japanese.mode, "off", "last-known-good 維持");
});

test("japanese on/off の変更で japanese.enabled だけが変わる", () => {
  const store = new QualityFlowConfigStore();
  const change = store.setJapaneseEnabled(false, "command:/quality japanese off");
  assert.equal(change.ok, true);
  if (!change.ok) return;
  assert.equal(change.snapshot.config.japanese.enabled, false);
  assert.equal(change.snapshot.config.enabled, true);
  assert.equal(change.snapshot.config.japanese.mode, "always");
});
