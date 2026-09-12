/**
 * 契約試験: 回答候補の同一性（Pi 0.85.1 + mock provider）。
 *
 * P03: candidateId は本文 hash に依存せず、message_end / turn_end が同じ
 * candidate を参照すること、A → B 置換後も同一 candidate であることを確認する。
 *
 * 対象: docs/pi-quality-flow-design-v0.2.md 第8.2・10.3章、Issue #2。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CandidateLedger } from "../../src/coordinator/candidates.ts";
import { sha256Utf8 } from "../../src/pi/adapter.ts";
import { createHarness } from "../helpers/harness.ts";

const ORIGINAL = "この実装方案では、APIの返却値を直接利用します。";
const ADOPTED = "この実装方針では、APIの返却値を直接利用します。";

test("ledger: 同一 message オブジェクトの重複 claim は already-claimed", () => {
  const ledger = new CandidateLedger();
  ledger.beginSession("session-1");

  const message = { role: "assistant", content: [], timestamp: 1 };
  const first = ledger.claim({ message, inputHash: "hash-a", claimedAtMs: 0 });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.record.candidateId, "qf-candidate:session-1#1:run0:turn0:seq0");
  }

  const second = ledger.claim({ message, inputHash: "hash-a", claimedAtMs: 1 });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "already-claimed");
    if (first.ok) {
      assert.equal(second.candidateId, first.record.candidateId, "already-claimed は元の candidateId を返す");
    }
  }
});

test("ledger: 別 message は別 candidate（sequence が進む）", () => {
  const ledger = new CandidateLedger();
  ledger.beginSession("session-1");

  const a = ledger.claim({ message: { role: "assistant", content: [], timestamp: 1 }, inputHash: "h", claimedAtMs: 0 });
  const b = ledger.claim({ message: { role: "assistant", content: [], timestamp: 2 }, inputHash: "h", claimedAtMs: 0 });
  assert.equal(a.ok && b.ok, true);
  if (a.ok && b.ok) {
    assert.notEqual(a.record.candidateId, b.record.candidateId, "同じ本文でも別 candidate");
    assert.equal(a.record.inputHash, b.record.inputHash, "同じ本文でも candidateId は hash に依存しない");
  }
});

test("ledger: session 切替で旧 candidate は無効化される", () => {
  const ledger = new CandidateLedger();
  ledger.beginSession("session-1");
  const claim = ledger.claim({ message: { role: "assistant", content: [], timestamp: 1 }, inputHash: "h", claimedAtMs: 0 });
  assert.equal(claim.ok, true);
  if (claim.ok) {
    assert.equal(ledger.isCurrent(claim.record), true);
  }

  ledger.beginSession("session-2");
  if (claim.ok) {
    assert.equal(ledger.isCurrent(claim.record), false, "旧 session の candidate は stale");
    assert.equal(ledger.size, 0);
  }
});

test("P03: A → B 置換後も同一 candidate（message_end と turn_end の対応）", async () => {
  const harness = await createHarness({
    responses: [
      { text: ORIGINAL, chunkCount: 3, chunkDelayMs: 10 },
      { text: "二回目です。", chunkCount: 2, chunkDelayMs: 10 },
    ],
    finalize: ({ originalText }) => (originalText === ORIGINAL ? ADOPTED : undefined),
  });

  try {
    await harness.session.prompt("1つ目");
    await harness.session.prompt("2つ目");

    const candidates = harness.candidateEntries();
    assert.equal(candidates.length, 2, "2 candidate");

    const first = candidates[0];
    assert.equal(first.inputHash, sha256Utf8(ORIGINAL), "inputHash は原文 A");
    assert.equal(first.outputHash, sha256Utf8(ADOPTED), "outputHash は採用本文 B");
    assert.equal(first.phase, "formatted", "A → B でも同一 candidate レコード");

    const mappings = harness.turnMappingEntries();
    assert.equal(mappings.length, 2, "各 turn_end が candidate に対応付けられる");

    // session.subscribe に流れる turn_end は内部 agent event（turnIndex を持たない）。
    // 各 prompt は新しい agent run（agent_start で turnIndex が 0 に戻る）なので、
    // 両候補とも turn 0 / run が異なる。
    assert.equal(mappings[0].turnIndex, 0);
    assert.equal(mappings[1].turnIndex, 0);

    // 同じ本文の別 candidate: 別 run（agent_start ごとに run 連番が進む）なので別 candidateId
    assert.notEqual(candidates[0].candidateId, candidates[1].candidateId);
    assert.match(String(candidates[0].candidateId), /run1/);
    assert.match(String(candidates[1].candidateId), /run2/);
  } finally {
    await harness.cleanup();
  }
});
