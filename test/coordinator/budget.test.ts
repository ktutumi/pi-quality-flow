/**
 * StageBudget の単体試験（Issue #7、設計書 第32.1章）。
 *
 * candidate 90秒・日本語処理10秒の全体予算を個別 stage 上限より優先し、
 * 残り時間内だけ実行する。時刻は注入して決定論的に検証する。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { StageBudget, createStageController } from "../../src/coordinator/budget.ts";

test("stage の許可時間は個別上限・candidate 残り・japanese 残りの最小値", () => {
  const budget = new StageBudget({ candidateDeadlineMs: 90_000, japaneseDeadlineMs: 10_000, now: 0 });
  budget.markJapaneseStart(0);
  assert.equal(budget.stageTimeoutMs(30_000, 0), 10_000, "gate 30s < candidate 90s だが japanese 10s が最小");
  budget.markJapaneseStart(1_000);
  assert.equal(budget.stageTimeoutMs(30_000, 1_000), 9_000, "japanese 残りが最小");
  assert.equal(budget.stageTimeoutMs(60_000, 1_000), 9_000);
  assert.equal(budget.stageTimeoutMs(5_000, 1_000), 5_000, "個別上限が最小のときはそれを使う");
});

test("candidate 残りが最小のときはそれを使う", () => {
  const budget = new StageBudget({ candidateDeadlineMs: 90_000, japaneseDeadlineMs: 10_000, now: 0 });
  budget.markJapaneseStart(80_000);
  // candidate 残り 10s、japanese 残り 10s、個別上限 30s → 同点は最小値 10s。
  assert.equal(budget.stageTimeoutMs(30_000, 80_000), 10_000);
  const budget2 = new StageBudget({ candidateDeadlineMs: 90_000, japaneseDeadlineMs: 10_000, now: 0 });
  budget2.markJapaneseStart(84_000);
  // candidate 残り 1s < japanese 残り 6s → candidate が最小。
  assert.equal(budget2.stageTimeoutMs(30_000, 89_000), 1_000);
});

test("期限切れの stage には時間を与えない（undefined）", () => {
  const budget = new StageBudget({ candidateDeadlineMs: 90_000, japaneseDeadlineMs: 10_000, now: 0 });
  budget.markJapaneseStart(0);
  assert.equal(budget.stageTimeoutMs(30_000, 10_000), undefined, "japanese 期限ちょうど");
  assert.equal(budget.stageTimeoutMs(30_000, 90_000), undefined, "candidate 期限ちょうど");
});

test("expired は切れた予算を区別して返す", () => {
  const budget = new StageBudget({ candidateDeadlineMs: 90_000, japaneseDeadlineMs: 10_000, now: 0 });
  budget.markJapaneseStart(0);
  assert.equal(budget.expired(5_000), undefined);
  assert.equal(budget.expired(10_000), "japanese-deadline");
  const budget2 = new StageBudget({ candidateDeadlineMs: 90_000, japaneseDeadlineMs: 10_000, now: 0 });
  assert.equal(budget2.expired(90_000), "candidate-deadline");
});

test("japanese 開始前は expired にならない（japanese 予算は未消費）", () => {
  const budget = new StageBudget({ candidateDeadlineMs: 90_000, japaneseDeadlineMs: 10_000, now: 0 });
  assert.equal(budget.expired(89_999), undefined);
});

test("createStageController: deadline で signal が abort する", async () => {
  const budget = new StageBudget({ candidateDeadlineMs: 50, japaneseDeadlineMs: 10_000, now: Date.now() });
  const controller = createStageController({ budget });
  const aborted = new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await aborted;
  assert.equal(controller.signal.aborted, true);
  controller.dispose();
});

test("createStageController: 外部 signal の abort も伝播する", () => {
  const budget = new StageBudget({ candidateDeadlineMs: 90_000, japaneseDeadlineMs: 10_000, now: Date.now() });
  const external = new AbortController();
  const controller = createStageController({ budget, external: external.signal });
  external.abort();
  assert.equal(controller.signal.aborted, true);
  controller.dispose();
});

test("createStageController: dispose で timer と listener を解放する", async () => {
  const budget = new StageBudget({ candidateDeadlineMs: 20, japaneseDeadlineMs: 10_000, now: Date.now() });
  const external = new AbortController();
  const controller = createStageController({ budget, external: external.signal });
  controller.dispose();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(controller.signal.aborted, false, "dispose 後は deadline でも abort しない");
  external.abort();
  assert.equal(controller.signal.aborted, false, "dispose 後は外部 abort も伝播しない");
});

test("createStageController: 登録前に abort 済みの外部 signal は即時 abort", () => {
  const budget = new StageBudget({ candidateDeadlineMs: 90_000, japaneseDeadlineMs: 10_000, now: Date.now() });
  const external = new AbortController();
  external.abort();
  const controller = createStageController({ budget, external: external.signal });
  assert.equal(controller.signal.aborted, true, "Escape 後の stage 生成では gate / backend を開始しない");
  controller.dispose();
});
