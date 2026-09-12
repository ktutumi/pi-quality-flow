/**
 * 契約試験用の決定論的 mock provider。
 *
 * - `pi.registerProvider` の streamSimple で、scripted JSON に従って AssistantMessage を stream する
 * - 各 request の context.messages を捕捉し、検証に使う（次ターン Executor context の証跡）
 *
 * script の供給源:
 * - SDK harness: `createMockProviderExtension({ script: () => script })`
 * - CLI 試験: 環境変数 `PI_QF_MOCK_SCRIPT`（script JSON ファイルのパス）
 *
 * script 形式:
 * {
 *   "responses": [
 *     { "text": "...", "thinking": "...(省略可)", "toolCall": {...}(省略可),
 *       "stopReason": "stop"|"length"|"aborted", "chunkCount": 4, "chunkDelayMs": 25 }
 *   ]
 * }
 *
 * このファイルはテスト専用であり、配布される拡張から読み込まれない。
 */
import {
  appendFileSync,
  readFileSync,
} from "node:fs";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const MOCK_PROVIDER = "pi-qf-mock";
export const MOCK_MODEL_ID = "mock-1";

export interface MockToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface MockResponse {
  text?: string;
  thinking?: string;
  toolCall?: MockToolCall;
  /** 既定 stop。length / aborted / error も指定できる。 */
  stopReason?: "stop" | "length" | "aborted" | "error";
  /** 分割数（既定4）。streaming delta を作る。 */
  chunkCount?: number;
  /** 各 chunk の待ち時間 ms（既定 25）。 */
  chunkDelayMs?: number;
}

export interface MockScript {
  responses: MockResponse[];
}

/** 各 request の観測記録（次ターン context の証跡）。 */
export interface MockRequest {
  systemPrompt?: string;
  messages: Context["messages"];
  toolCount: number;
}

export interface MockState {
  requests: MockRequest[];
  responsesConsumed: number;
}

/** CLI 試験用の捕捉ファイル（JSONL）。 */
const CAPTURE_ENV = "PI_QF_MOCK_CAPTURE";
const SCRIPT_ENV = "PI_QF_MOCK_SCRIPT";

function loadScriptFromEnv(): MockScript | undefined {
  const path = process.env[SCRIPT_ENV];
  if (!path) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as MockScript;
}

function appendCapture(request: MockRequest): void {
  const path = process.env[CAPTURE_ENV];
  if (!path) return;
  appendFileSync(path, `${JSON.stringify(request)}\n`, "utf8");
}

function createMockStream(
  script: () => MockScript | undefined,
  state: MockState,
  model: Model<Api>,
  context: Context,
  options?: { signal?: AbortSignal },
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      const scriptData = script();
      const response = scriptData?.responses[state.responsesConsumed];
      state.responsesConsumed += 1;

      state.requests.push({
        systemPrompt: context.systemPrompt,
        messages: context.messages,
        toolCount: context.tools?.length ?? 0,
      });
      appendCapture(state.requests[state.requests.length - 1]);

      if (!response) {
        throw new Error("Mock script exhausted: no response for request");
      }

      stream.push({ type: "start", partial: output });

      const chunkCount = response.chunkCount ?? 4;
      const chunkDelayMs = response.chunkDelayMs ?? 25;

      if (response.thinking) {
        output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
        stream.push({
          type: "thinking_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
        const thinkingChunks = Math.max(1, Math.ceil(response.thinking.length / chunkCount));
        for (let i = 0; i < thinkingChunks; i++) {
          await sleep(chunkDelayMs, options?.signal);
          const delta = response.thinking.slice(i * chunkCount, (i + 1) * chunkCount);
          (output.content[output.content.length - 1] as { thinking: string }).thinking += delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: output.content.length - 1,
            delta,
            partial: output,
          });
        }
        stream.push({
          type: "thinking_end",
          contentIndex: output.content.length - 1,
          content: response.thinking,
          partial: output,
        });
      }

      if (response.text !== undefined) {
        output.content.push({ type: "text", text: "" });
        stream.push({
          type: "text_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
        const chunkSize = Math.max(1, Math.ceil(response.text.length / chunkCount));
        for (let i = 0; i < chunkSize; i++) {
          await sleep(chunkDelayMs, options?.signal);
          const delta = response.text.slice(i * chunkCount, (i + 1) * chunkCount);
          (output.content[output.content.length - 1] as { text: string }).text += delta;
          stream.push({
            type: "text_delta",
            contentIndex: output.content.length - 1,
            delta,
            partial: output,
          });
        }
        stream.push({
          type: "text_end",
          contentIndex: output.content.length - 1,
          content: response.text,
          partial: output,
        });
      }

      if (response.toolCall) {
        output.content.push({ ...response.toolCall, type: "toolCall" });
        stream.push({
          type: "toolcall_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: output.content.length - 1,
          toolCall: { ...response.toolCall, type: "toolCall" },
          partial: output,
        });
      }

      const reason = response.stopReason ?? (response.toolCall ? "toolUse" : "stop");
      if (reason === "aborted" || reason === "error") {
        throw new Error(`Mock requested ${reason} stop`);
      }
      output.stopReason = reason as "stop" | "length" | "toolUse";
      output.usage.output = 20;
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

/** CLI 試験用: env の script で動く拡張。 */
export const mockProviderExtension: ExtensionFactory = createMockProviderExtension({});

export function createMockProviderExtension(options: {
  script?: () => MockScript | undefined;
  /** harness が所有する観測 state。省略時は内部で生成する（CLI 試験用）。 */
  state?: MockState;
  model?: Partial<Model<Api>>;
}): ExtensionFactory {
  const state: MockState = options.state ?? { requests: [], responsesConsumed: 0 };

  return (pi: ExtensionAPI) => {
    const script = options.script ?? (() => loadScriptFromEnv());
    const model: Model<Api> = {
      id: MOCK_MODEL_ID,
      name: "Mock 1",
      api: "pi-qf-mock-api",
      provider: MOCK_PROVIDER,
      baseUrl: "http://localhost:0/mock",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
      ...options.model,
    };

    pi.registerProvider(MOCK_PROVIDER, {
      name: "Pi Quality Flow Mock",
      baseUrl: model.baseUrl,
      apiKey: "mock-key",
      api: model.api,
      models: [
        {
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: model.input,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        },
      ],
      streamSimple: (m, context, opts) => createMockStream(script, state, m, context, opts),
    });

    pi.on("session_start", async (_event, ctx) => {
      const found = ctx.modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
      if (found) {
        await pi.setModel(found);
      }
    });

    // SDK harness は options.state で直接観測する。CLI 試験は捕捉ファイルを使う。
  };
}
