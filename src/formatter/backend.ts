/**
 * FormatterBackend — 隔離した stateless-api backend（設計書 第19章、Issue #5）。
 *
 * Pi 0.85.1 の `ModelRegistry.complete()` を使う単発要求 adapter。
 * - 送信するのは承認済み prompt（systemPrompt）と保護処理済み本文だけ。
 *   Main transcript、system prompt、thinking、tool result、workspace は含めない
 *   （`Context` を毎回新規に構築するため履歴隔離は構造的に保証する）。
 * - tools は空配列で要求し、native tools / MCP / delegation を実行権限の段階で
 *   除外する。`tools: []` の自己申告だけで適合とはしない（適合記録が必要）。
 * - 要求は1回のみ。semantic retry、agent loop、application/adapter 管理下の
 *   通信再試行、自動 model/provider fallback は行わない。
 * - 正常 stop / length / toolUse / error / aborted / 空出力 / 巨大出力を区別し、
 *   部分出力・複数 text block を成功扱いしない。
 * - cancel / timeout は AbortSignal で request/stream に伝播する。
 *
 * provider 内部の再試行・remote 計算・課金の停止は観測できない
 * （観測限界は docs/compat/formatter-backend.md に記録する）。
 */
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
} from "@earendil-works/pi-ai";

/** backend が申告する capability（設計書 §19.2）。 */
export interface FormatterBackendCapabilities {
  freshConversation: boolean;
  freshInstructions: boolean;
  nativeToolsDisabled: boolean;
  mcpDisabled: boolean;
  workspaceAccessDisabled: boolean;
  cancellationVerified: boolean;
  completionReasonAvailable: boolean;
}

/** Formatter 利用量の記録（本文とは別記録。不明値をゼロにしない）。 */
export interface FormatterUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costTotal?: number;
  /** provider が利用量を報告したか。false の場合、上記は不明（0 ではない）。 */
  known: boolean;
}

export type FormatterFailureCode =
  | "model-unresolved"
  | "auth-unavailable"
  | "aborted"
  | "request-failed"
  | "stop-reason-length"
  | "stop-reason-toolUse"
  | "stop-reason-error"
  | "stop-reason-unknown"
  | "no-text-output"
  | "multi-text-blocks"
  | "output-too-large";

export type FormatterResult =
  | { ok: true; text: string; usage: FormatterUsage; model: string }
  | { ok: false; code: FormatterFailureCode; detail?: string };

export interface FormatterRequest {
  /** 承認済み prompt（固定 profile の指示のみ。会話履歴を含まない）。 */
  systemPrompt: string;
  /** 保護処理済みの今回の本文（Formatter への唯一の user 入力）。 */
  text: string;
  /** キャンセル / timeout。request と stream に伝播する。 */
  signal?: AbortSignal;
  /** 出力上限（UTF-8 bytes）。超過は失敗（切り詰めない）。 */
  maxOutputBytes: number;
}

/**
 * capability は申告ではなく検証済みの適合記録から採用する。
 * 未検証の capability は false のままにし、1つでも false があれば
 * 自動 Formatter は有効化しない（設計書 §19.2、docs/compat/formatter-backend.md）。
 * この値は packaged の適合記録だけから来る。ユーザー設定では上書きできない。
 */
export const FORMATTER_CAPABILITIES_UNVERIFIED: FormatterBackendCapabilities = {
  freshConversation: false,
  freshInstructions: false,
  nativeToolsDisabled: false,
  mcpDisabled: false,
  workspaceAccessDisabled: false,
  cancellationVerified: false,
  completionReasonAvailable: false,
};

/** ModelRegistry のうち backend が使う部分（実クラスと構造的に互換）。 */
export interface FormatterModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  hasConfiguredAuth(model: Model<Api>): boolean;
  complete(
    model: Model<Api>,
    context: Context,
    options?: { signal?: AbortSignal },
  ): Promise<AssistantMessage>;
}

export type ModelResolution =
  | { ok: true; model: Model<Api>; endpoint?: string }
  | { ok: false; code: "model-unresolved" | "auth-unavailable" };

/**
 * 設定の provider/modelId でモデルを解決する。
 * 見つからない・認証未設定でも別 model / 別 provider へ fallback しない。
 */
export function resolveFormatterModel(
  registry: FormatterModelRegistry,
  model: { provider?: string; modelId?: string },
): ModelResolution {
  if (model.provider === undefined || model.modelId === undefined) {
    return { ok: false, code: "model-unresolved" };
  }
  const found = registry.find(model.provider, model.modelId);
  if (!found) return { ok: false, code: "model-unresolved" };
  if (!registry.hasConfiguredAuth(found)) return { ok: false, code: "auth-unavailable" };
  return { ok: true, model: found, endpoint: found.baseUrl };
}

/**
 * 隔離した stateless-api backend（設計書 §19.2 の FormatterBackend 実装）。
 *
 * capability は既定で FORMATTER_CAPABILITIES_UNVERIFIED（すべて false）。
 * 実際の値は packaged の適合記録（docs/compat/formatter-backend.md）から
 * 注入する。実送信試験が完了していない構成では isReady() が false となり、
 * 自動 Formatter は有効化されない。
 */
export class StatelessApiBackend {
  readonly capabilities: FormatterBackendCapabilities;
  private readonly registry: FormatterModelRegistry;
  private readonly configModel: { provider?: string; modelId?: string };

  constructor(
    registry: FormatterModelRegistry,
    configModel: { provider?: string; modelId?: string },
    capabilities?: Partial<FormatterBackendCapabilities>,
  ) {
    this.registry = registry;
    this.configModel = configModel;
    this.capabilities = { ...FORMATTER_CAPABILITIES_UNVERIFIED, ...capabilities };
  }

  /** すべての必須 capability が検証済みか（false が1つでもあれば自動有効化しない）。 */
  isReady(): boolean {
    return Object.values(this.capabilities).every((value) => value === true);
  }

  /** 単発要求。成功・失敗・中断のいずれでも再要求しない。 */
  async rewrite(request: FormatterRequest): Promise<FormatterResult> {
    const resolved = resolveFormatterModel(this.registry, this.configModel);
    if (!resolved.ok) return { ok: false, code: resolved.code };
    if (request.signal?.aborted) {
      // 要求開始前に既に中断されている場合は request を発行しない。
      return { ok: false, code: "aborted" };
    }

    const context: Context = {
      systemPrompt: request.systemPrompt,
      messages: [
        { role: "user", content: [{ type: "text", text: request.text }], timestamp: Date.now() },
      ],
      tools: [],
    };
    let message: AssistantMessage;
    try {
      message = await this.registry.complete(resolved.model, context, {
        signal: request.signal,
      });
    } catch (error) {
      // 再試行しない。abort は signal と区別せず aborted として扱う。
      if (request.signal?.aborted) return { ok: false, code: "aborted" };
      return {
        ok: false,
        code: "request-failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return validateCompletion(message, request.maxOutputBytes, `${resolved.model.provider}/${resolved.model.id}`);
  }
}

/**
 * 完了 message の検査（副作用のない純粋関数）。
 * 正常 stop、非空 text、toolCall なし、完全な出力、サイズ上限を確認する。
 * length / toolUse / error / aborted、空出力、複数 text block、
 * 上限超過（切り詰め）はいずれも失敗とする。
 */
export function validateCompletion(
  message: AssistantMessage,
  maxOutputBytes: number,
  modelLabel: string,
): FormatterResult {
  const usage = summarizeUsage(message.usage);
  switch (message.stopReason) {
    case "stop":
      break;
    case "length":
      return { ok: false, code: "stop-reason-length" };
    case "toolUse":
      return { ok: false, code: "stop-reason-toolUse" };
    case "error":
      return { ok: false, code: "stop-reason-error", detail: message.errorMessage };
    case "aborted":
      return { ok: false, code: "aborted" };
    default:
      return { ok: false, code: "stop-reason-unknown", detail: String(message.stopReason) };
  }

  const textBlocks = message.content.filter(
    (block): block is Extract<typeof block, { type: "text" }> =>
      block.type === "text" && block.text.length > 0,
  );
  // stop でも toolCall block が混在する provider 出力を拒否する（AC: toolCall なし）。
  if (message.content.some((block) => block.type === "toolCall")) {
    return { ok: false, code: "stop-reason-toolUse" };
  }
  if (textBlocks.length === 0) return { ok: false, code: "no-text-output" };
  if (textBlocks.length > 1) return { ok: false, code: "multi-text-blocks" };
  const text = textBlocks[0].text;
  if (Buffer.byteLength(text, "utf8") > maxOutputBytes) {
    return { ok: false, code: "output-too-large" };
  }
  return { ok: true, text, usage, model: modelLabel };
}

function summarizeUsage(usage: AssistantMessage["usage"]): FormatterUsage {
  if (!usage) return { known: false };
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    costTotal: usage.cost?.total,
    known: true,
  };
}
