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

test("ledger: 上限付きで保持され、turn_end 対応済みの記録から破棄される", () => {
  const ledger = new CandidateLedger(2);
  ledger.beginSession("session-1");
  const m1 = { role: "assistant", content: [], timestamp: 1 };
  const m2 = { role: "assistant", content: [], timestamp: 2 };
  const m3 = { role: "assistant", content: [], timestamp: 3 };
  const c1 = ledger.claim({ message: m1, inputHash: "h1", claimedAtMs: 0 });
  const c2 = ledger.claim({ message: m2, inputHash: "h2", claimedAtMs: 1 });
  assert.ok(c1.ok && c2.ok);
  assert.equal(ledger.size, 2, "上限ちょうどは保持される");

  // c1 を turn_end 対応済みにする。
  assert.ok(ledger.resolveByMessage(m1));
  const c3 = ledger.claim({ message: m3, inputHash: "h3", claimedAtMs: 2 });
  assert.ok(c3.ok);
  assert.equal(ledger.size, 2, "上限を超えたら対応済みの古い記録から破棄");
  assert.ok(!ledger.find(c1.ok ? c1.record.candidateId : ""), "対応済みの c1 は破棄");
  assert.ok(ledger.find(c2.ok ? c2.record.candidateId : ""), "未対応の c2 は保持");
});

test("ledger: 上限 1 でも現在の claim は保持される", () => {
  const ledger = new CandidateLedger(1);
  ledger.beginSession("session-1");
  const claim = ledger.claim({ message: { role: "assistant", content: [], timestamp: 1 }, inputHash: "h", claimedAtMs: 0 });
  assert.ok(claim.ok);
  if (claim.ok) {
    assert.equal(ledger.size, 1);
    assert.equal(ledger.isCurrent(claim.record), true, "現在の claim は evict されない");
  }
});

test("ledger: session 切替で対応付け済み set も初期化される", () => {
  const ledger = new CandidateLedger(2);
  ledger.beginSession("session-1");
  const m1 = { role: "assistant", content: [], timestamp: 1 };
  const m2 = { role: "assistant", content: [], timestamp: 2 };
  const m3 = { role: "assistant", content: [], timestamp: 3 };
  const c1 = ledger.claim({ message: m1, inputHash: "h1", claimedAtMs: 0 });
  const c2 = ledger.claim({ message: m2, inputHash: "h2", claimedAtMs: 1 });
  assert.ok(c1.ok && c2.ok);
  assert.ok(ledger.resolveByMessage(m1), "c1 を対応済みにする");

  ledger.beginSession("session-2");
  const c3 = ledger.claim({ message: m3, inputHash: "h3", claimedAtMs: 2 });
  assert.ok(c3.ok);
  // session 切替で candidates が空なので、mappedIds の残留が eviction を
  // 誤って誘導しない（新 session の記録は残る）。
  assert.equal(ledger.size, 1);
  assert.ok(ledger.find(c3.ok ? c3.record.candidateId : ""));
});

test("ledger: 未対応が上限を超えても保持し、対応付けで破棄する（limit=1）", () => {
  const ledger = new CandidateLedger(1);
  ledger.beginSession("session-1");
  const m1 = { role: "assistant", content: [], timestamp: 1 };
  const m2 = { role: "assistant", content: [], timestamp: 2 };
  const c1 = ledger.claim({ message: m1, inputHash: "h1", claimedAtMs: 0 });
  const c2 = ledger.claim({ message: m2, inputHash: "h2", claimedAtMs: 1 });
  assert.ok(c1.ok && c2.ok);
  // 両方未対応のため、terminal event の関連付けに必要な記録は保持する。
  assert.equal(ledger.size, 2, "未対応の記録は上限を超えても保持（第33.3章）");
  assert.ok(ledger.find(c1.ok ? c1.record.candidateId : ""));
  assert.ok(ledger.find(c2.ok ? c2.record.candidateId : ""));

  // turn_end 対応付け: その記録は返り、対応付け完了後に破棄される。
  const mapped = ledger.resolveByMessage(m1);
  assert.ok(mapped, "対応付け対象の記録は返る");
  assert.equal(mapped.candidateId, c1.ok ? c1.record.candidateId : "");
  assert.equal(ledger.size, 1, "対応付け完了後に対象記録を破棄");
  assert.ok(!ledger.find(c1.ok ? c1.record.candidateId : ""), "対応済みは破棄");
  assert.ok(ledger.find(c2.ok ? c2.record.candidateId : ""), "未対応は保持");
});
