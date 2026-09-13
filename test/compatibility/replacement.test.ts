/**
 * 契約試験: 採用本文の5面一致（Pi 0.85.1 + mock provider）。
 *
 * P01: message_end 返却 `{ message }` による本文 A → B の直接置換が
 *      1) TUI 最終表示（実バイナリ PTY）
 *      2) RPC final 面（message_end.message）
 *      3) turn_end.message
 *      4) 保存セッション（保存と resume）
 *      5) 次ターン Executor context
 *      の全てで一致することを確認する。
 *
 * 対象: docs/pi-quality-flow-design-v0.2.md 第6.1・23.2章、Issue #2。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assistantText, createHarness, createMockModel, lastAssistantMessage, APPROVED_FORMATTER_CONFIG } from "../helpers/harness.ts";
import { GATE_BIN } from "../helpers/gate-bin.ts";
import { sha256Utf8 } from "../../src/pi/adapter.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const ORIGINAL = "この実装方案では、APIの返却値を直接利用します。\n注意として、タイムアウト設定は必須です。";
const ADOPTED = "この実装方針では、APIの返却値を直接利用します。\n注意として、タイムアウト設定は必須です。";

test("P01/P02: RPC final / turn_end / 次ターン context / metadata 保持が一致する", async () => {
  const harness = await createHarness({
    responses: [
      {
        text: ORIGINAL,
        thinking: "技術的な回答を組み立てる。",
        chunkCount: 6,
        chunkDelayMs: 15,
      },
      { text: "二回目の回答です。", chunkCount: 2, chunkDelayMs: 10 },
    ],
    finalize: ({ originalText }) => (originalText === ORIGINAL ? ADOPTED : undefined),
  });

  try {
    await harness.session.prompt("この設計を説明してください");

    // --- streaming は暫定版（A を流す） ---
    type TextDeltaEvent = {
      type: "message_update";
      assistantMessageEvent: { type: "text_delta"; delta: string };
    };
    const deltas = harness
      .events()
      .filter(
        (e): e is TextDeltaEvent =>
          e.type === "message_update" &&
          (e as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
            "text_delta",
      )
      .map((e) => e.assistantMessageEvent.delta)
      .join("");
    assert.equal(deltas, ORIGINAL, "streaming delta は修正前の本文を流す");

    // --- 面2: message_end.message（RPC final 面）は採用本文 ---
    const messageEnd = harness.events().find(
      (e) =>
        e.type === "message_end" &&
        (e as { message?: { role?: string } }).message?.role === "assistant",
    ) as { message: { content: Array<{ type: string; text?: string }> } } | undefined;
    assert.ok(messageEnd, "message_end が発火する");
    assert.equal(assistantText(messageEnd.message), ADOPTED);

    // --- 面3: turn_end.message も採用本文 ---
    const turnEnd = harness.events().find((e) => e.type === "turn_end") as
      | { message: { content: Array<{ type: string; text?: string }> } }
      | undefined;
    assert.ok(turnEnd, "turn_end が発火する");
    assert.equal(assistantText(turnEnd.message), ADOPTED);

    // --- metadata 保持: usage・thinking・stopReason ---
    const assistant = messageEnd.message as unknown as {
      usage: { input: number; output: number; totalTokens: number };
      stopReason: string;
      provider: string;
      model: string;
      content: Array<{ type: string; text?: string; thinking?: string }>;
    };
    assert.equal(assistant.stopReason, "stop");
    assert.equal(assistant.provider, "pi-qf-mock");
    assert.equal(assistant.model, "mock-1");
    assert.equal(assistant.usage.input, 10);
    assert.equal(assistant.usage.output, 20);
    assert.ok(assistant.content.some((b) => b.type === "thinking" && b.thinking === "技術的な回答を組み立てる。"));

    // --- 面5: 次ターン Executor context は採用本文 ---
    await harness.session.prompt("続けて要約してください");
    const secondRequest = harness.mockState.requests[1];
    assert.ok(secondRequest, "2回目の request が発生する");
    const contextText = assistantText({
      content: secondRequest.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.content as Array<{ type: string; text?: string }>),
    });
    assert.ok(contextText.includes(ADOPTED), "次ターン context に採用本文が含まれる");
    assert.ok(!contextText.includes("実装方案"), "次ターン context に原文が残らない");

    // --- candidate provenance: inputHash(A) → outputHash(B)、同一 candidateId ---
    const candidates = harness.candidateEntries();
    assert.equal(candidates.length, 2, "2つの回答候補が記録される");
    assert.equal(candidates[0].inputHash, sha256Utf8(ORIGINAL));
    assert.equal(candidates[0].outputHash, sha256Utf8(ADOPTED));
    assert.equal(candidates[0].phase, "formatted");
  } finally {
    await harness.cleanup();
  }
});

test("P01: 保存セッションに採用本文が残り、resume 後の context も一致する", async () => {
  const harness = await createHarness({
    responses: [{ text: ORIGINAL, chunkCount: 3, chunkDelayMs: 10 }],
    finalize: ({ originalText }) => (originalText === ORIGINAL ? ADOPTED : undefined),
    persistent: true,
  });

  try {
    await harness.session.prompt("確認してください");
    assert.ok(harness.sessionFile, "session file が作られる");
    const sessionFile = harness.sessionFile;

    // --- 面4: 保存セッション（直接読み取り） ---
    const raw = await readFile(sessionFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const assistantEntries = lines
      .map((l) => JSON.parse(l) as { type: string; message?: { role?: string; content?: Array<{ type: string; text?: string }> } })
      .filter((e) => e.type === "message" && e.message?.role === "assistant");
    assert.equal(assistantEntries.length, 1);
    assert.equal(assistantText(assistantEntries[0].message!), ADOPTED, "保存セッションは採用本文");
    assert.ok(!assistantText(assistantEntries[0].message!).includes("実装方案"));

    // --- 面4b: resume（実 SDK の resume 経路。元 session file が存在する間に行う） ---
    const resumed = await createHarness({
      responses: [{ text: "resume 後の応答です。", chunkCount: 2, chunkDelayMs: 10 }],
      finalize: () => undefined,
      resumeSessionFile: sessionFile,
      sessionStartReason: "resume",
    });
    try {
      assert.equal(resumed.session.messages.filter((m) => m.role === "assistant").length, 1, "resume で前 session の message が復元される");
      const restored = resumed.session.messages.filter((m) => m.role === "assistant")[0] as { content?: Array<{ type: string; text?: string }> };
      assert.equal(assistantText(restored), ADOPTED, "resume 後も採用本文");

      await resumed.session.prompt("続きをお願いします");
      // resume 後の最初の request context には復元済みの採用本文が含まれる。
      const restoredContext = assistantText({
        content: resumed.mockState.requests[0].messages
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.content as Array<{ type: string; text?: string }>),
      });
      assert.equal(restoredContext, ADOPTED, "resume 後の Executor context は採用本文");
    } finally {
      await resumed.cleanup();
    }
  } finally {
    // session file の読み取りと resume が済んでから dir ごと削除する。
    await harness.cleanup();
  }
});

test("P01: 実バイナリ TUI 最終表示が採用本文（PTY）", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const work = await mkdtemp(join(tmpdir(), "pi-qf-tui-"));
  await mkdir(join(work, "project"), { recursive: true });
  await mkdir(join(work, "agent"), { recursive: true });
  // 採用シームは承認済み構成だけを対象にする（egress allow + allowlist + model）。
  await writeFile(
    join(work, "agent", "quality-flow.json"),
    JSON.stringify(APPROVED_FORMATTER_CONFIG),
  );
  await writeFile(
    join(work, "mock-script.json"),
    JSON.stringify({ responses: [{ text: ORIGINAL, chunkCount: 4, chunkDelayMs: 25 }] }),
  );
  await writeFile(join(work, "rewrite.json"), JSON.stringify({ adoptedText: ADOPTED }));

  const piBin = process.env.PI_BIN ?? "pi";
  const cmd = `${piBin} --no-extensions -e ${join(ROOT, "test", "helpers", "mock-provider-extension.ts")} -e ${join(ROOT, "test", "helpers", "finalizer-extension.ts")} '説明してください'`;

  // script(1) で pty を確保し、pi の TUI を実行する。初期 prompt は自動送信される。
  const child = spawn("script", ["-qec", cmd, "/dev/null"], {
    cwd: join(work, "project"),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(work, "agent"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_QF_MOCK_SCRIPT: join(work, "mock-script.json"),
      PI_QF_REWRITE_FILE: join(work, "rewrite.json"),
      // 採用シームは pre gate が使える構成だけを対象にする（固定版 binary）。
      PI_QF_GATE_BIN: GATE_BIN,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d.toString("utf8")));
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (d) => stderrChunks.push(d));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  try {
    // TUI は行単位で描画するため、1行目の断片で検出する。
    const adoptedFirstLine = ADOPTED.split("\n")[0];
    // 採用本文が TUI に描画されるのを待ち、その後 Ctrl+D で終了する。
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !stripAnsi(output).includes(adoptedFirstLine)) {
      await sleep(200);
    }
    child.stdin.write("\x04");
    await Promise.race([closed, sleep(10_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed;

    const stripped = stripAnsi(output);
    assert.ok(
      stripped.includes(adoptedFirstLine),
      `TUI に採用本文が描画される: stderr=${Buffer.concat(stderrChunks).toString().slice(0, 300)}`,
    );
    assert.ok(
      stripped.lastIndexOf("方案") < stripped.indexOf(adoptedFirstLine),
      "原文は置換前の暫定描画にのみ現れ、最終表示は採用本文",
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(work, { recursive: true, force: true });
  }
});

/** ANSI escape 系列を素な走査で除去する（制御文字 regex を避ける）。 */
function stripAnsi(text: string): string {
  const ESC = String.fromCharCode(27);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== ESC) {
      out += c;
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next === "[") {
      // CSI: ESC [ パラメータ… 最終バイト（英字）まで捨てる。
      i += 2;
      while (i < text.length && !isLetter(text.charCodeAt(i))) i++;
      i++; // 最終バイト
      continue;
    }
    if (next === "]") {
      // OSC: BEL (0x07) まで捨てる。
      i += 2;
      while (i < text.length && text.charCodeAt(i) !== 7) i++;
      i++;
      continue;
    }
    if (next === "(" || next === ")") {
      i += 3; // ESC ( B などの2文字系列
      continue;
    }
    i += 2; // その他の2文字 ESC 系列
  }
  return out;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("headless: session.messages も採用本文で一貫する", async () => {
  const harness = await createHarness({
    responses: [{ text: ORIGINAL, chunkCount: 3, chunkDelayMs: 10 }],
    finalize: ({ originalText }) => (originalText === ORIGINAL ? ADOPTED : undefined),
  });
  try {
    await harness.session.prompt("確認してください");
    const last = lastAssistantMessage(harness.session);
    assert.ok(last);
    assert.equal(last.text, ADOPTED);
    assert.equal(last.stopReason, "stop");
  } finally {
    await harness.cleanup();
  }
});

// createMockModel は lifecycle.test.ts の runtime factory と共有する契約 fixture。
void createMockModel;
