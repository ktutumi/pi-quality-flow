/**
 * FormatterBackend（stateless-api adapter）の単体試験（Issue #5）。
 *
 * 外部境界は mock registry で制御し、解決・出力検査・中断・失敗分類を検証する。
 * 実モデルへの送信は行わない（適合試験は docs/compat/formatter-backend.md の手順）。
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

function makeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "修正後の本文" }],
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
    hasConfiguredAuth(model) {
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

test("rewrite は fresh context（systemPrompt + 本文1通、tools 空）を送る", async () => {
  let observed: Context | undefined;
  const backend = new StatelessApiBackend(
    makeRegistry({
      complete: async (context) => {
        observed = context;
        return makeMessage();
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
  assert.equal(observed.systemPrompt, "テスト指示");
  assert.equal(observed.messages.length, 1);
  assert.equal(observed.tools?.length, 0);
  assert.deepEqual(observed.messages[0].content, [{ type: "text", text: "本文" }]);
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
  assert.deepEqual(
    { ok: result.ok, code: result.ok ? undefined : result.code },
    { ok: false, code: "request-failed" },
  );
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
  assert.deepEqual(
    { ok: result.ok, code: result.ok ? undefined : result.code },
    { ok: false, code: "aborted" },
  );
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
  assert.deepEqual(
    { ok: result.ok, code: result.ok ? undefined : result.code },
    { ok: false, code: "aborted" },
  );
});

test("validateCompletion: 正常 stop の text を返す", () => {
  const result = validateCompletion(makeMessage(), 262_144, "google/gemini-2.5-flash");
  assert.ok(result.ok);
  assert.equal(result.text, "修正後の本文");
  assert.equal(result.model, "google/gemini-2.5-flash");
  assert.equal(result.usage.known, true);
  assert.equal(result.usage.outputTokens, 20);
});

test("validateCompletion: length / toolUse / error / aborted を失敗に変換する", () => {
  for (const [stopReason, code] of [
    ["length", "stop-reason-length"],
    ["toolUse", "stop-reason-toolUse"],
    ["error", "stop-reason-error"],
    ["aborted", "aborted"],
  ] as const) {
    const result = validateCompletion(makeMessage({ stopReason }), 262_144, "m");
    assert.deepEqual(
      { ok: result.ok, code: result.ok ? undefined : result.code },
      { ok: false, code },
    );
  }
});

test("validateCompletion: 未知の stopReason を失敗に変換する", () => {
  const result = validateCompletion(
    makeMessage({ stopReason: "deferred" as AssistantMessage["stopReason"] }),
    262_144,
    "m",
  );
  assert.deepEqual(
    { ok: result.ok, code: result.ok ? undefined : result.code },
    { ok: false, code: "stop-reason-unknown" },
  );
});

test("validateCompletion: stop でも toolCall block が混在すれば失敗", () => {
  const result = validateCompletion(
    makeMessage({
      content: [
        { type: "text", text: "本文" },
        { type: "toolCall", id: "t1", name: "x", arguments: {} },
      ],
    }),
    262_144,
    "m",
  );
  assert.deepEqual(
    { ok: result.ok, code: result.ok ? undefined : result.code },
    { ok: false, code: "stop-reason-toolUse" },
  );
});

test("validateCompletion: 空出力・複数 text block を失敗にする", () => {
  const empty = validateCompletion(makeMessage({ content: [] }), 262_144, "m");
  assert.deepEqual(
    { ok: empty.ok, code: empty.ok ? undefined : empty.code },
    { ok: false, code: "no-text-output" },
  );
  const multi = validateCompletion(
    makeMessage({
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    }),
    262_144,
    "m",
  );
  assert.deepEqual(
    { ok: multi.ok, code: multi.ok ? undefined : multi.code },
    { ok: false, code: "multi-text-blocks" },
  );
});

test("validateCompletion: 空でない thinking / toolCall があっても text だけを見る", () => {
  const result = validateCompletion(
    makeMessage({
      content: [
        { type: "thinking", thinking: "考え", thinkingSignature: "" },
        { type: "text", text: "本文" },
      ],
    }),
    262_144,
    "m",
  );
  assert.ok(result.ok);
  assert.equal(result.text, "本文");
});

test("validateCompletion: 上限超過の出力は切り詰めず失敗にする", () => {
  const result = validateCompletion(makeMessage({ content: [{ type: "text", text: "あ".repeat(100) }] }), 50, "m");
  assert.deepEqual(
    { ok: result.ok, code: result.ok ? undefined : result.code },
    { ok: false, code: "output-too-large" },
  );
});

test("validateCompletion: 利用不明の usage をゼロにしない", () => {
  const message = makeMessage();
  delete (message as { usage?: unknown }).usage;
  const result = validateCompletion(message, 262_144, "m");
  assert.ok(result.ok);
  assert.equal(result.usage.known, false);
  assert.equal(result.usage.outputTokens, undefined);
});

test("validateCompletion: token の部分報告も不明として扱う（ゼロにしない）", () => {
  const message = makeMessage();
  (message.usage as { input?: number }).input = undefined;
  const result = validateCompletion(message, 262_144, "m");
  assert.ok(result.ok);
  assert.equal(result.usage.known, false);
  assert.equal(result.usage.outputTokens, undefined);
});
