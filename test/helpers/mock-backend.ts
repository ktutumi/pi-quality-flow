/**
 * 契約試験用の mock Formatter backend（Issue #8）。
 *
 * - pipeline（src/japanese/pipeline.ts）と同じ FormatterBackendLike 契約
 * - rewrite は受信した request を観測用に記録し、script に従って返す
 * - 既定の script は request 内の編集可能部分だけを修正する helper で作る
 *
 * テスト専用であり、配布される拡張からは読み込まれない。
 */
import type { FormatterRequest, FormatterResult, FormatterUsage } from "../../src/formatter/backend.ts";
import type { FormatterBackendLike } from "../../src/japanese/pipeline.ts";

/** 受信した request の観測記録。 */
export interface MockBackendState {
  requests: Array<{ systemPrompt: string; text: string; maxOutputBytes: number }>;
}

export type MockRewrite = (
  request: FormatterRequest,
  state: MockBackendState,
) => FormatterResult | Promise<FormatterResult>;

export function createMockBackend(options: {
  ready?: boolean;
  rewrite?: MockRewrite;
  state?: MockBackendState;
}): FormatterBackendLike & { state: MockBackendState } {
  const state: MockBackendState =
    options.state ?? { requests: [] };
  return {
    state,
    isReady: () => options.ready ?? true,
    async rewrite(request: FormatterRequest): Promise<FormatterResult> {
      state.requests.push({
        systemPrompt: request.systemPrompt,
        text: request.text,
        maxOutputBytes: request.maxOutputBytes,
      });
      if (options.rewrite === undefined) {
        return { ok: false, code: "request-failed", detail: "mock backend has no script" };
      }
      return await options.rewrite(request, state);
    },
  };
}

/** テキスト中の a と b を入れ替える（token / chunk の順序変更 fixture 用）。 */
export function swapInText(text: string, a: string, b: string): string {
  return text.replace(a, "\u0000").replace(b, a).replace("\u0000", b);
}

/**
 * request 本文（sentinel + 編集可能 segment）の中で、segment 内の
 * from → to 置換を適用する。sentinel token 内でないことを検査する。
 */
export function correctInRequest(requestText: string, from: string, to: string): string {
  const index = requestText.indexOf(from);
  if (index < 0) {
    throw new Error(`fixture text not found in request: ${from}`);
  }
  return requestText.slice(0, index) + to + requestText.slice(index + from.length);
}

/** 正常な Formatter 応答を作る。known=false の場合は利用量を報告しない（ゼロ化しない）。 */
export function formatterOk(text: string, usage: Partial<FormatterUsage> = {}): FormatterResult {
  if (usage.known === false) {
    return { ok: true, text, model: "pi-qf-mock/mock-1", usage: { known: false } };
  }
  return {
    ok: true,
    text,
    model: "pi-qf-mock/mock-1",
    usage: {
      known: true,
      inputTokens: usage.inputTokens ?? 10,
      outputTokens: usage.outputTokens ?? 20,
      totalTokens: usage.totalTokens,
      costTotal: usage.costTotal,
    },
  };
}

/** backend の障害応答を作る。 */
export function formatterFailure(code: Extract<FormatterResult, { ok: false }>["code"]): FormatterResult {
  return { ok: false, code };
}
