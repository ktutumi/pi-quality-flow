/**
 * FormatterBackend（stateless-api adapter）の単体試験（Issue #5）。
 *
 * 外部境界は mock registry で制御し、解決・出力検査・envelope・中断・失敗分類を
 * 検証する。実モデルへの送信は行わない（適合試験は #14、docs/compat/formatter-backend.md）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FORMATTER_CAPABILITIES_UNVERIFIED,
  StatelessApiBackend,
  resolveFormatterModel,
  validateCompletion,
  type FormatterModelRegistry,
} from "../../src/formatter/backend.ts";
import { createEnvelope, type Envelope } from "../../src/formatter/envelope.ts";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";

const MODEL: Model<Api> = {
  id: "gemini-2.5-flash",
  name: "Gemini 2.5 Flash",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

/** envelope の内側に本文を置いた正常な完了 message。 */
function makeMessage(
  overrides: Partial<AssistantMessage> = {},
  envelope: Envelope = createEnvelope(),
  body = "修正後の本文",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: `${envelope.begin}${body}${envelope.end}` }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** raw 出力の本文部分だけを差し替える（envelope は既定のまま）。 */
function withRawText(message: AssistantMessage, raw: string): AssistantMessage {
  return { ...message, content: [{ type: "text", text: raw }] };
}

function failureOf(result: { ok: boolean; code?: string }): { ok: boolean; code?: string } {
  return { ok: result.ok, code: result.ok ? undefined : result.code };
}

interface RegistryCalls {
  find: number;
  hasAuth: number;
  complete: number;
}

function makeRegistry(options: {
  found?: boolean;
  auth?: boolean;
  complete?: (context: Context, signal?: AbortSignal) => Promise<AssistantMessage>;
  calls?: RegistryCalls;
}): FormatterModelRegistry {
  const calls = options.calls ?? { find: 0, hasAuth: 0, complete: 0 };
  return {
    find(provider, modelId) {
      calls.find += 1;
      if (options.found === false) return undefined;
      assert.equal(provider, MODEL.provider);
      assert.equal(modelId, MODEL.id);
      return MODEL;
    },
    hasConfiguredAuth(_model) {
      calls.hasAuth += 1;
      return options.auth ?? true;
    },
    async complete(model, context, opts) {
      calls.complete += 1;
      assert.equal(model, MODEL);
      return options.complete
        ? options.complete(context, opts?.signal)
        : makeMessage();
    },
  };
}

/** request 固有の marker を systemPrompt から取り出す（end-to-end 試験用）。 */
function markersFromPrompt(systemPrompt: string | undefined): { begin: string; end: string } {
  assert.ok(systemPrompt);
  const begin = systemPrompt.match(/<<FMT:beg:[0-9a-f]{32}>>/)?.[0];
  const end = systemPrompt.match(/<<FMT:end:[0-9a-f]{32}>>/)?.[0];
  assert.ok(begin && end, "framing 指示に marker が含まれること");
  return { begin, end };
}

test("未検証の capability は既定ですべて false で isReady() は false", () => {
  const backend = new StatelessApiBackend(makeRegistry({}), { provider: "google", modelId: MODEL.id });
  assert.deepEqual(backend.capabilities, FORMATTER_CAPABILITIES_UNVERIFIED);
  assert.equal(backend.isReady(), false);
});

test("capability を注入すると isReady() は true（検証済み記録の反映）", () => {
  const backend = new StatelessApiBackend(
    makeRegistry({}),
    { provider: "google", modelId: MODEL.id },
    { ...FORMATTER_CAPABILITIES_UNVERIFIED, freshConversation: true },
  );
  assert.equal(backend.isReady(), false);
  const all = Object.fromEntries(
    Object.keys(FORMATTER_CAPABILITIES_UNVERIFIED).map((key) => [key, true]),
  );
  const ready = new StatelessApiBackend(
    makeRegistry({}),
    { provider: "google", modelId: MODEL.id },
    all,
  );
  assert.equal(ready.isReady(), true);
});

test("設定の provider/modelId でモデルを解決する", () => {
  const calls: RegistryCalls = { find: 0, hasAuth: 0, complete: 0 };
  const resolution = resolveFormatterModel(
    makeRegistry({ calls }),
    { provider: "google", modelId: MODEL.id },
  );
  assert.ok(resolution.ok);
  assert.equal(resolution.model, MODEL);
  assert.equal(calls.find, 1);
  assert.equal(calls.hasAuth, 1);
});

test("未設定の model は model-unresolved（fallback しない）", () => {
  const resolution = resolveFormatterModel(makeRegistry({}), {});
  assert.deepEqual(resolution, { ok: false, code: "model-unresolved" });
});

test("registry に無い model は model-unresolved（fallback しない）", () => {
  const resolution = resolveFormatterModel(
    makeRegistry({ found: false }),
    { provider: "google", modelId: MODEL.id },
  );
  assert.deepEqual(resolution, { ok: false, code: "model-unresolved" });
});

test("認証未設定の model は auth-unavailable（fallback しない）", () => {
  const resolution = resolveFormatterModel(
    makeRegistry({ auth: false }),
    { provider: "google", modelId: MODEL.id },
  );
  assert.deepEqual(resolution, { ok: false, code: "auth-unavailable" });
});

test("rewrite は fresh context（承認 prompt + framing 指示、本文1通、tools 空）を送る", async () => {
  let observed: Context | undefined;
  const backend = new StatelessApiBackend(
    makeRegistry({
      complete: async (context) => {
        observed = context;
        const { begin, end } = markersFromPrompt(context.systemPrompt);
        return makeMessage({
          content: [{ type: "text", text: `${begin}修正後の本文${end}` }],
        });
      },
    }),
    { provider: "google", modelId: MODEL.id },
  );
  const result = await backend.rewrite({
    systemPrompt: "テスト指示",
    text: "本文",
    maxOutputBytes: 262_144,
  });
  assert.ok(result.ok);
  assert.equal(result.text, "修正後の本文");
  assert.ok(observed);
  assert.match(observed.systemPrompt ?? "", /^テスト指示/, "承認 prompt を先頭に保つ");
  assert.match(observed.systemPrompt ?? "", /<<FMT:beg:[0-9a-f]{32}>>/, "framing 指示を付加");
  assert.equal(observed.messages.length, 1);
  assert.equal(observed.tools?.length, 0);
  assert.deepEqual(observed.messages[0].content, [{ type: "text", text: "本文" }]);
});

test("rewrite は request ごとに異なる marker を使う", async () => {
  const seen: string[] = [];
  const backend = new StatelessApiBackend(
    makeRegistry({
      complete: async (context) => {
        seen.push(context.systemPrompt ?? "");
        return makeMessage();
      },
    }),
    { provider: "google", modelId: MODEL.id },
  );
  await backend.rewrite({ systemPrompt: "p", text: "t", maxOutputBytes: 262_144 });
  await backend.rewrite({ systemPrompt: "p", text: "t", maxOutputBytes: 262_144 });
  assert.notEqual(seen[0], seen[1]);
});

test("rewrite は 1回だけ complete を呼ぶ（再試行しない）", async () => {
  const calls: RegistryCalls = { find: 0, hasAuth: 0, complete: 0 };
  const backend = new StatelessApiBackend(
    makeRegistry({ calls }),
    { provider: "google", modelId: MODEL.id },
  );
  await backend.rewrite({ systemPrompt: "p", text: "t", maxOutputBytes: 262_144 });
  assert.equal(calls.complete, 1);
});

test("complete が throw しても request-failed として返す（再試行しない）", async () => {
  const calls: RegistryCalls = { find: 0, hasAuth: 0, complete: 0 };
  const backend = new StatelessApiBackend(
    makeRegistry({
      calls,
      complete: async () => {
        throw new Error("boom");
      },
    }),
    { provider: "google", modelId: MODEL.id },
  );
  const result = await backend.rewrite({ systemPrompt: "p", text: "t", maxOutputBytes: 262_144 });
  assert.deepEqual(failureOf(result), { ok: false, code: "request-failed" });
  assert.equal(calls.complete, 1);
});

test("abort 済み signal では request を発行しない", async () => {
  const calls: RegistryCalls = { find: 0, hasAuth: 0, complete: 0 };
  const backend = new StatelessApiBackend(
    makeRegistry({ calls }),
    { provider: "google", modelId: MODEL.id },
  );
  const controller = new AbortController();
  controller.abort();
  const result = await backend.rewrite({
    systemPrompt: "p",
    text: "t",
    maxOutputBytes: 262_144,
    signal: controller.signal,
  });
  assert.deepEqual(failureOf(result), { ok: false, code: "aborted" });
  assert.equal(calls.complete, 0);
});

test("complete 中の abort は aborted として返す", async () => {
  const controller = new AbortController();
  const backend = new StatelessApiBackend(
    makeRegistry({
      complete: async () => {
        controller.abort();
        throw new Error("Aborted");
      },
    }),
    { provider: "google", modelId: MODEL.id },
  );
  const result = await backend.rewrite({
    systemPrompt: "p",
    text: "t",
    maxOutputBytes: 262_144,
    signal: controller.signal,
  });
  assert.deepEqual(failureOf(result), { ok: false, code: "aborted" });
});

test("rewrite: 前置き付き出力は envelope-missing で拒否する（end-to-end）", async () => {
  let observed: Context | undefined;
  const backend = new StatelessApiBackend(
    makeRegistry({
      complete: async (context) => {
        observed = context;
        return makeMessage({
          content: [{ type: "text", text: "前置きです。修正後の本文" }],
        });
      },
    }),
    { provider: "google", modelId: MODEL.id },
  );
  const result = await backend.rewrite({ systemPrompt: "p", text: "t", maxOutputBytes: 262_144 });
  assert.deepEqual(failureOf(result), { ok: false, code: "envelope-missing" });
  markersFromPrompt(observed?.systemPrompt);
});

test("rewrite: marker 契約に従う出力から本文だけを返す（end-to-end）", async () => {
  let observed: Context | undefined;
  const backend = new StatelessApiBackend(
    makeRegistry({
      complete: async (context) => {
        observed = context;
        const { begin, end } = markersFromPrompt(context.systemPrompt);
        return makeMessage({
          content: [{ type: "text", text: `${begin}修正後の本文${end}` }],
        });
      },
    }),
    { provider: "google", modelId: MODEL.id },
  );
  const result = await backend.rewrite({ systemPrompt: "p", text: "t", maxOutputBytes: 262_144 });
  assert.ok(result.ok);
  assert.equal(result.text, "修正後の本文");
  markersFromPrompt(observed?.systemPrompt);
});

test("validateCompletion: 正常 stop の envelope 内側の text を返す", () => {
  const env = createEnvelope();
  const result = validateCompletion(makeMessage({}, env), 262_144, "google/gemini-2.5-flash", env);
  assert.ok(result.ok);
  assert.equal(result.text, "修正後の本文");
  assert.equal(result.model, "google/gemini-2.5-flash");
  assert.equal(result.usage.known, true);
  assert.equal(result.usage.outputTokens, 20);
});

test("validateCompletion: length / toolUse / error / aborted を失敗に変換する", () => {
  const env = createEnvelope();
  for (const [stopReason, code] of [
    ["length", "stop-reason-length"],
    ["toolUse", "stop-reason-toolUse"],
    ["error", "stop-reason-error"],
    ["aborted", "aborted"],
  ] as const) {
    const result = validateCompletion(makeMessage({ stopReason }, env), 262_144, "m", env);
    assert.deepEqual(failureOf(result), { ok: false, code });
  }
});

test("validateCompletion: 未知の stopReason を失敗に変換する", () => {
  const env = createEnvelope();
  const result = validateCompletion(
    makeMessage({ stopReason: "deferred" as AssistantMessage["stopReason"] }, env),
    262_144,
    "m",
    env,
  );
  assert.deepEqual(failureOf(result), { ok: false, code: "stop-reason-unknown" });
});

test("validateCompletion: stop でも toolCall block が混在すれば失敗", () => {
  const env = createEnvelope();
  const result = validateCompletion(
    makeMessage({
      content: [
        { type: "text", text: `${env.begin}本文${env.end}` },
        { type: "toolCall", id: "t1", name: "x", arguments: {} },
      ],
    }, env),
    262_144,
    "m",
    env,
  );
  assert.deepEqual(failureOf(result), { ok: false, code: "stop-reason-toolUse" });
});

test("validateCompletion: 空出力・複数 text block を失敗にする", () => {
  const env = createEnvelope();
  const empty = validateCompletion(makeMessage({ content: [] }, env), 262_144, "m", env);
  assert.deepEqual(failureOf(empty), { ok: false, code: "no-text-output" });
  const multi = validateCompletion(
    makeMessage({
      content: [
        { type: "text", text: `${env.begin}a${env.end}` },
        { type: "text", text: `${env.begin}b${env.end}` },
      ],
    }, env),
    262_144,
    "m",
    env,
  );
  assert.deepEqual(failureOf(multi), { ok: false, code: "multi-text-blocks" });
});

test("validateCompletion: thinking があっても text だけを取り出す", () => {
  const env = createEnvelope();
  const result = validateCompletion(
    makeMessage({
      content: [
        { type: "thinking", thinking: "考え", thinkingSignature: "" },
        { type: "text", text: `${env.begin}本文${env.end}` },
      ],
    }, env),
    262_144,
    "m",
    env,
  );
  assert.ok(result.ok);
  assert.equal(result.text, "本文");
});

test("validateCompletion: 前置き・後置き・囲いなし出力を拒否する", () => {
  const env = createEnvelope();
  const preamble = validateCompletion(
    withRawText(makeMessage({}, env), `前置き${env.begin}本文${env.end}`),
    262_144,
    "m",
    env,
  );
  assert.deepEqual(failureOf(preamble), { ok: false, code: "envelope-missing" });
  const trailing = validateCompletion(
    withRawText(makeMessage({}, env), `${env.begin}本文${env.end}後置き`),
    262_144,
    "m",
    env,
  );
  assert.deepEqual(failureOf(trailing), { ok: false, code: "envelope-missing" });
  const bare = validateCompletion(
    withRawText(makeMessage({}, env), "修正後の本文"),
    262_144,
    "m",
    env,
  );
  assert.deepEqual(failureOf(bare), { ok: false, code: "envelope-missing" });
});

test("validateCompletion: 本文内の marker 複製と別 nonce marker を拒否する", () => {
  const env = createEnvelope();
  const duplicate = validateCompletion(
    withRawText(makeMessage({}, env), `${env.begin}本文${env.begin}続き${env.end}`),
    262_144,
    "m",
    env,
  );
  assert.deepEqual(failureOf(duplicate), { ok: false, code: "envelope-duplicate" });
  const other = createEnvelope();
  const unknown = validateCompletion(
    withRawText(makeMessage({}, env), `${env.begin}本文${other.begin}混入${env.end}`),
    262_144,
    "m",
    env,
  );
  assert.deepEqual(failureOf(unknown), { ok: false, code: "envelope-unknown-marker" });
});

test.todo("frame 内側のレビュー文は #8 の pipeline invariant で拒否する（#5 は transport 層に限定、ADR 0003）");

test("validateCompletion: 上限超過の raw 出力（marker 込み）は切り詰めず失敗にする", () => {
  const env = createEnvelope();
  const longBody = "あ".repeat(200);
  const result = validateCompletion(makeMessage({}, env, longBody), 50, "m", env);
  assert.deepEqual(failureOf(result), { ok: false, code: "output-too-large" });
});

test("validateCompletion: 利用不明・部分報告の usage をゼロにしない", () => {
  const env = createEnvelope();
  const noUsage = makeMessage({}, env);
  delete (noUsage as { usage?: unknown }).usage;
  const r1 = validateCompletion(noUsage, 262_144, "m", env);
  assert.ok(r1.ok);
  assert.equal(r1.usage.known, false);
  assert.equal(r1.usage.outputTokens, undefined);

  const partial = makeMessage({}, env);
  (partial.usage as { input?: number }).input = undefined;
  const r2 = validateCompletion(partial, 262_144, "m", env);
  assert.ok(r2.ok);
  assert.equal(r2.usage.known, false);
  assert.equal(r2.usage.outputTokens, undefined);
});
