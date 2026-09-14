/**
 * 統合試験: 設定と command による実行範囲・送信権限の制御（Issue #4）。
 *
 * 公開入口（message_end / /quality command）から mode 表の全組合せ、
 * trigger 評価、送信不許可時のローカル検証のみ、configRevision の進行を確認する。
 * モデル要求と追加 Executor ターンは常に 0（Formatter backend は未適合）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, lastAssistantMessage, APPROVED_FORMATTER_CONFIG } from "../helpers/harness.ts";
import { GATE_BIN, assertGateBinaryPinned } from "../helpers/gate-bin.ts";
import { sha256Utf8 } from "../../src/pi/adapter.ts";
import type { QualityFlowConfigStore } from "../../src/config/store.ts";

const JP_TEXT = "これは简体字のテスト。";
const EN_TEXT = "This is a plain answer.";

test("gate binary が固定版 digest と一致する", async () => {
  await assertGateBinaryPinned();
});

test("mode 表: japanese.enabled=false は CLI 0回・モデル0回", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
    globalConfig: { japanese: { enabled: false } },
  });
  try {
    await harness.session.prompt("test");
    assert.equal(harness.checkEntries().length, 0, "CLI は実行されない");
    assert.equal(harness.mockState.requests.length, 1, "モデル要求は Executor の1回のみ");
    assert.equal(lastAssistantMessage(harness.session)?.text, JP_TEXT, "原文のまま");
  } finally {
    await harness.cleanup();
  }
});

test("mode 表: gate.enabled=false + mode off は CLI 0回", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
    globalConfig: { japanese: { gate: { enabled: false }, mode: "off" } },
  });
  try {
    await harness.session.prompt("test");
    assert.equal(harness.checkEntries().length, 0, "CLI は実行されない");
  } finally {
    await harness.cleanup();
  }
});

test("mode 表: gate.enabled=false + mode gate/always は自動処理を停止し通知する", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
    globalConfig: { japanese: { gate: { enabled: false }, mode: "always" } },
  });
  try {
    await harness.session.prompt("test");
    // 不正組合せは layer ごと捨てず「自動修正を無効化し通知」で扱う（mode 表）。
    assert.equal(harness.checkEntries().length, 0, "gate 無効のため CLI も実行されない");
    const problems = harness.typedEntries("pi-quality-flow:config-problem");
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.scope, "merged");
    assert.equal(problems[0]?.code, "invalid-combination");
  } finally {
    await harness.cleanup();
  }
});

test("mode 表: mode off（validation-only）は pre gate 1回で置換しない", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
    globalConfig: { japanese: { mode: "off" } },
  });
  try {
    await harness.session.prompt("test");
    const check = harness.checkEntries();
    assert.equal(check.length, 1, "pre gate のみ");
    assert.equal(check[0]?.mode, "off", "entry に mode を記録");
    assert.equal(harness.mockState.requests.length, 1, "モデル要求は 0（Executor の分のみ）");
  } finally {
    await harness.cleanup();
  }
});

test("mode 表: mode gate/always は trigger を評価し、未適合 backend ではローカル検証のみ", async () => {
  for (const mode of ["gate", "always"] as const) {
    const harness = await createHarness({
      responses: [{ text: JP_TEXT }],
      gateExecutable: GATE_BIN,
      globalConfig: { japanese: { mode } },
    });
    try {
      await harness.session.prompt("test");
      const check = harness.checkEntries();
      assert.equal(check.length, 1, mode);
      assert.equal(check[0]?.mode, mode);
      assert.equal(check[0]?.triggered, true, "診断があるため trigger 成立");
      assert.equal(check[0]?.formatterReason, "egress-denied", "送信不許可のため Formatter は開始しない");
      assert.equal(harness.mockState.requests.length, 1, "モデル要求は 0（送信不許可）");
    } finally {
      await harness.cleanup();
    }
  }
});

test("trigger errors: warnings のみでは trigger 不成立", async () => {
  // 繁体字は simplified_chinese_form（error）が出ず、warning のみのため
  // errors trigger の不成立例になる。
  const harness = await createHarness({
    responses: [{ text: "繁體中文文字" }],
    gateExecutable: GATE_BIN,
    globalConfig: { japanese: { mode: "gate", gate: { trigger: "errors" } } },
  });
  try {
    await harness.session.prompt("test");
    const check = harness.checkEntries();
    assert.equal(check.length, 1);
    assert.equal(check[0]?.status, "pass", "warning のみのため status は pass（error 0件）");
    assert.equal(check[0]?.triggered, false, "errors trigger では warning のみでは不成立");
    assert.equal(check[0]?.formatterReason, "gate-not-triggered");
  } finally {
    await harness.cleanup();
  }
});

test("trigger any: warnings のみでも trigger 成立", async () => {
  const harness = await createHarness({
    responses: [{ text: "繁體中文文字" }],
    gateExecutable: GATE_BIN,
    globalConfig: { japanese: { mode: "gate", gate: { trigger: "any" } } },
  });
  try {
    await harness.session.prompt("test");
    const check = harness.checkEntries();
    assert.equal(check[0]?.triggered, true);
    assert.equal(check[0]?.formatterReason, "egress-denied");
  } finally {
    await harness.cleanup();
  }
});

test("english のみは japanese 設定に従い skip を記録する", async () => {
  const harness = await createHarness({
    responses: [{ text: EN_TEXT }],
    gateExecutable: GATE_BIN,
    globalConfig: { japanese: { mode: "gate" } },
  });
  try {
    await harness.session.prompt("test");
    const check = harness.checkEntries();
    assert.equal(check[0]?.status, "skipped");
    assert.equal(check[0]?.reason, "no-editable-japanese");
  } finally {
    await harness.cleanup();
  }
});

test("trusted project の japanese.enabled=false で CLI 0回（project layer が効く）", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
    projectTrusted: true,
    projectConfig: { japanese: { enabled: false } },
  });
  try {
    await harness.session.prompt("test");
    assert.equal(harness.checkEntries().length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("untrusted では project 設定を読まない（CLI が動く）", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
    projectTrusted: false,
    projectConfig: { japanese: { enabled: false } },
  });
  try {
    await harness.session.prompt("test");
    assert.equal(harness.checkEntries().length, 1, "project layer は読まれないため既定で検証される");
  } finally {
    await harness.cleanup();
  }
});

test("project の security は剥がされ通知される（global security は保持）", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
    projectTrusted: true,
    globalConfig: { security: { cloudEgress: "allow" } },
    projectConfig: { security: { cloudEgress: "deny" } },
  });
  try {
    await harness.session.prompt("test");
    const problems = harness.typedEntries("pi-quality-flow:config-problem");
    const stripped = problems.find((p) => p.code === "project-stripped");
    assert.ok(stripped, "剥がし通知が記録される");
    // 通知も出る（notify entry）。
    const notifies = harness.typedEntries("pi-quality-flow:notify");
    assert.ok(
      notifies.some((n) => String(n.message).includes("project-stripped") || String(n.message).includes("security")),
      "設定問題の通知が UI に出る",
    );
  } finally {
    await harness.cleanup();
  }
});

test("/quality off で CLI 0回・configRevision が進む", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }, { text: JP_TEXT }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("first");
    const before = harness.checkEntries().length;
    assert.equal(before, 1);

    await harness.session.prompt("/quality off");
    const configEntries = harness.typedEntries("pi-quality-flow:config");
    const off = configEntries[configEntries.length - 1];
    assert.equal(off?.label, "enabled=false");
    assert.ok((off?.revision as number) > 0, "revision が進んでいる");

    await harness.session.prompt("second");
    assert.equal(harness.checkEntries().length, before, "OFF 後は CLI 0回");
    assert.equal(harness.mockState.requests.length, 2, "Executor の応答のみ");
  } finally {
    await harness.cleanup();
  }
});

test("/quality on で再度有効化される", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("/quality off");
    await harness.session.prompt("/quality on");
    await harness.session.prompt("test");
    assert.equal(harness.checkEntries().length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("/quality japanese mode gate への切替が configRevision に反映される", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("/quality japanese mode gate");
    const entries = harness.typedEntries("pi-quality-flow:config");
    assert.ok(entries.some((e) => e.label === "japanese.mode=gate"));
    await harness.session.prompt("test");
    const check = harness.checkEntries();
    assert.equal(check[0]?.mode, "gate");
  } finally {
    await harness.cleanup();
  }
});

test("/quality japanese mode always は既定どおり（設定変更なしでも受け付ける）", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("/quality japanese mode always");
    const entries = harness.typedEntries("pi-quality-flow:config");
    assert.ok(entries.some((e) => e.label === "japanese.mode=always"));
  } finally {
    await harness.cleanup();
  }
});

test("/quality status はモデル解決・権限・backend・CLI 適合を分けて表示する", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("/quality status");
    const notifies = harness.typedEntries("pi-quality-flow:notify");
    const message = notifies.map((n) => String(n.message)).join("\n");
    assert.match(message, /configRevision=/);
    assert.match(message, /model \(formatter\):/, "モデル解決の行");
    assert.match(message, /security: cloudEgress=deny/, "権限の行");
    assert.match(message, /backend=stateless-api \(compat: unverified/, "backend 適合の行（未確認を ready と表示しない）");
    assert.match(message, /gate CLI: executable configured/, "CLI 適合の行");
    assert.doesNotMatch(message, /\bready\b/, "未確認を ready と表示しない");
  } finally {
    await harness.cleanup();
  }
});

test("/quality doctor はモデル呼び出し 0 回で CLI digest を検証する", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("test");
    const requestsBefore = harness.mockState.requests.length;
    await harness.session.prompt("/quality doctor");
    assert.equal(harness.mockState.requests.length, requestsBefore, "モデル呼び出しは 0 回");
    const notifies = harness.typedEntries("pi-quality-flow:notify");
    const message = notifies.map((n) => String(n.message)).join("\n");
    assert.match(message, /doctor \(model calls: 0\)/);
    assert.match(message, /digest verified/, "固定版 digest の検証結果");
    assert.match(message, /backend: stateless-api — compat unverified/, "backend 適合は記録に基づく表示（not ready）");
    assert.match(message, /\(not ready\)/, "実送信試験未了を ready と表示しない");
  } finally {
    await harness.cleanup();
  }
});

test("/quality advisor は初回リリース対象外を通知する（起動 command は登録しない）", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("/quality advisor on");
    const notifies = harness.typedEntries("pi-quality-flow:notify");
    assert.ok(notifies.some((n) => String(n.message).includes("out of scope")));
    assert.equal(harness.mockState.requests.length, 0, "Executor も起動しない");
  } finally {
    await harness.cleanup();
  }
});

test("/quality debug on|off を受け付ける", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("/quality debug on");
    const entries = harness.typedEntries("pi-quality-flow:config");
    assert.ok(entries.some((e) => e.label === "debug=on"));
    await harness.session.prompt("/quality debug off");
    const entries2 = harness.typedEntries("pi-quality-flow:config");
    assert.ok(entries2.some((e) => e.label === "debug=off"));
  } finally {
    await harness.cleanup();
  }
});

test("/quality japanese off は japanese.enabled を切る（extension 自体は on のまま）", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    gateExecutable: GATE_BIN,
  });
  try {
    await harness.session.prompt("/quality japanese off");
    await harness.session.prompt("test");
    assert.equal(harness.checkEntries().length, 0, "japanese off は CLI 0回");
    const entries = harness.typedEntries("pi-quality-flow:config");
    const off = entries.find((e) => e.label === "japanese.enabled=off");
    assert.ok(off, "変更が記録される");
  } finally {
    await harness.cleanup();
  }
});

test("gate 実行可能が未設定の場合は CLI を実行しない", async () => {
  const harness = await createHarness({
    responses: [{ text: JP_TEXT }],
    // gateExecutable 未設定かつ既定 command は相対名 → 実行しない。
  });
  try {
    await harness.session.prompt("test");
    assert.equal(harness.checkEntries().length, 0, "CLI 未設定では gate を実行しない");
    assert.equal(harness.mockState.requests.length, 1);
  } finally {
    await harness.cleanup();
  }
});

const ORIGINAL_FIX = "これは简体字のテストです。";
const ADOPTED_FIX = "これは簡体字のテストです。";

test("japanese.maxSourceBytes を公開入口で適用する（低上限は gate / finalizer を skip）", async () => {
  // ORIGINAL_FIX は 39 bytes。上限 20 では全候補 skip、上限 39（境界値）では処理する。
  let lowCalls = 0;
  let boundaryCalls = 0;
  const low = await createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    globalConfig: {
      ...APPROVED_FORMATTER_CONFIG,
      japanese: {
        ...APPROVED_FORMATTER_CONFIG.japanese,
        maxSourceBytes: 20,
      },
    },
    finalize: () => {
      lowCalls++;
      return ADOPTED_FIX;
    },
  });
  try {
    await low.session.prompt("test");
    assert.equal(low.checkEntries().length, 0, "上限超過は gate に渡さない");
    assert.equal(lowCalls, 0, "上限超過は finalizer も起動しない");
    const candidates = low.candidateEntries();
    assert.equal(candidates.length, 0, "claim 前に skip（candidate 記録なし）");
    assert.equal(lastAssistantMessage(low.session)?.text, ORIGINAL_FIX, "原文のまま");
  } finally {
    await low.cleanup();
  }

  const boundary = await createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    globalConfig: {
      ...APPROVED_FORMATTER_CONFIG,
      japanese: {
        ...APPROVED_FORMATTER_CONFIG.japanese,
        maxSourceBytes: 39,
      },
    },
    finalize: () => {
      boundaryCalls++;
      return ADOPTED_FIX;
    },
  });
  try {
    await boundary.session.prompt("test");
    assert.equal(boundary.checkEntries().length, 1, "境界値ちょうどは gate に渡る");
    assert.equal(boundaryCalls, 1, "境界値ちょうどは finalizer も起動する");
    assert.equal(lastAssistantMessage(boundary.session)?.text, ADOPTED_FIX, "採用される");
  } finally {
    await boundary.cleanup();
  }
});

test("置換後の /quality japanese check は採用本文を対象にする", async () => {
  const harness = await createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    finalize: ({ originalText }) => (originalText === ORIGINAL_FIX ? ADOPTED_FIX : undefined),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(lastAssistantMessage(harness.session)?.text, ADOPTED_FIX, "置換される");
    const autoChecks = harness.checkEntries().filter((e) => e.source === "auto");
    assert.deepEqual(autoChecks[0]?.score, { errors: 1, warnings: 0 }, "pre gate は原文を対象");

    await harness.session.prompt("/quality japanese check");
    const manual = harness.checkEntries().filter((e) => e.source === "manual");
    assert.equal(manual.length, 1);
    assert.deepEqual(manual[0]?.score, { errors: 0, warnings: 0 }, "手動 check は採用本文（diagnostics 0）を対象にする");
  } finally {
    await harness.cleanup();
  }
});

test("OFF は採用処理も停止する（OFF 前に始まった修正は後から適用されない）", async () => {
  let store: QualityFlowConfigStore | undefined;
  let started = 0;
  const harness = await createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    finalize: async ({ originalText }) => {
      started++;
      // 処理中に OFF にする（in-flight の無効化）。
      store?.setEnabled(false, "test:off-during-processing");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalText === ORIGINAL_FIX ? ADOPTED_FIX : undefined;
    },
    configStoreHook: (s) => (store = s),
  });
  try {
    await harness.session.prompt("test");
    assert.equal(started, 1, "finalizer は呼ばれたが");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL_FIX, "OFF 中に始まった処理の結果は適用されない");
    const candidates = harness.candidateEntries();
    const latest = candidates[candidates.length - 1];
    assert.ok(latest);
    assert.notEqual(latest?.phase, "formatted", "formatted として記録されない");
  } finally {
    await harness.cleanup();
  }
});

test("OFF 状態で開始する turn は finalizer を呼ばない（invocation 停止）", async () => {
  let started = 0;
  let store: QualityFlowConfigStore | undefined;
  const harness = await createHarness({
    responses: [{ text: ORIGINAL_FIX }],
    gateExecutable: GATE_BIN,
    finalize: () => {
      started++;
      return ADOPTED_FIX;
    },
    configStoreHook: (s) => (store = s),
  });
  try {
    store?.setEnabled(false, "test:off-before-turn");
    await harness.session.prompt("test");
    assert.equal(started, 0, "OFF の turn では finalizer が呼ばれない");
    assert.equal(lastAssistantMessage(harness.session)?.text, ORIGINAL_FIX);
  } finally {
    await harness.cleanup();
  }
});

test("steer が finalize 待機中に届いたら置換しない（pending-continuation）", async () => {
  // advisory の回帰試験: finalize の await 中に steer を投入し、
  // 採用直前の hasPendingMessages 再検査で pending-continuation になることを
  // 公開入口（extension wiring）で確認する。
  let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
  const harnessPromise = createHarness({
    responses: [
      { text: ORIGINAL_FIX },
      { text: "steer 後の回答です。" },
    ],
    gateExecutable: GATE_BIN,
    finalize: async ({ originalText }) => {
      // 再入防止: steer 後の応答には steer しない。
      if (originalText !== ORIGINAL_FIX) return undefined;
      // finalize 実行中に steer を queue する（abort signal は発火しない）。
      await harness?.session.steer("別の質問をします");
      return ADOPTED_FIX;
    },
  });
  harness = await harnessPromise;
  try {
    await harness.session.prompt("test");
    const assistantMessages = harness.session.messages
      .filter((m) => m.role === "assistant")
      .map((m) => {
        const a = m as unknown as { content: Array<{ type: string; text?: string }> };
        return a.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      });
    assert.equal(assistantMessages.length, 2, "steer により2つの応答");
    assert.equal(
      assistantMessages[0],
      ORIGINAL_FIX,
      "steer 到着後の遅延結果は適用されない（原文のまま）",
    );
    assert.equal(assistantMessages[1], "steer 後の回答です。", "steer への応答は通常処理");
    const candidates = harness.candidateEntries();
    const target = candidates.find((c) => c.inputHash === sha256Utf8(ORIGINAL_FIX));
    assert.ok(target, "対象 candidate の記録がある");
    assert.equal(target.phase, "skipped", "pending-continuation で skip 記録");
    assert.equal(target.reason, "pending-continuation");
    // steer による追加 Executor ターンが発生している（steer 1回分の request）。
    assert.equal(harness.mockState.requests.length, 2);
  } finally {
    await harness.cleanup();
  }
});
