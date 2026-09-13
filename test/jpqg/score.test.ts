/**
 * 単体試験: GateScore の lexicographic 比較（設計書 第16章）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compareScores, isScoreRegression, type GateScore } from "../../src/jpqg/score.ts";

test("errors を先に比較する", () => {
  assert.ok(compareScores({ errors: 0, warnings: 3 }, { errors: 1, warnings: 0 }) < 0);
  assert.ok(compareScores({ errors: 1, warnings: 0 }, { errors: 0, warnings: 3 }) > 0);
});

test("同数 error なら warnings を比較する", () => {
  assert.ok(compareScores({ errors: 0, warnings: 1 }, { errors: 0, warnings: 3 }) < 0);
  assert.ok(compareScores({ errors: 2, warnings: 5 }, { errors: 2, warnings: 5 }) === 0);
});

test("どちらも error 0 でも warning 増は regression（設計書 16.1 の例）", () => {
  assert.ok(isScoreRegression({ errors: 0, warnings: 0 }, { errors: 0, warnings: 5 }));
});

test("regression 判定の対称性", () => {
  // post が pre より悪い場合のみ regression。
  assert.ok(!isScoreRegression({ errors: 1, warnings: 0 }, { errors: 0, warnings: 3 }));
  assert.ok(!isScoreRegression({ errors: 0, warnings: 3 }, { errors: 0, warnings: 3 }));
  assert.ok(isScoreRegression({ errors: 1, warnings: 0 }, { errors: 2, warnings: 0 }));
  assert.ok(isScoreRegression({ errors: 0, warnings: 1 }, { errors: 0, warnings: 2 }));
});
