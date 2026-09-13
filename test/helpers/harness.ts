/**
 * 契約試験用の SDK harness。
 *
 * 実 Pi 0.85.1（@earendil-works/pi-coding-agent 0.85.1）の createAgentSession を使い、
 * mock provider 拡張と pi-quality-flow 拡張（finalize 注入）を
 * 公開イベント入口（extensionFactories / additionalExtensionPaths と同等の読み込み経路）で束ねる。
 *
 * 環境隔離:
 * - authPath / modelsPath / modelsStorePath / agentDir / cwd / session を一時ディレクトリに置き、
 *   ユーザーの ~/.pi や実 credentials に触れない
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createQualityFlowExtension, type Finalizer } from "../../src/extension.ts";
import type { QualityFlowConfigStore } from "../../src/config/store.ts";
import { GATE_BIN } from "./gate-bin.ts";
import {
  createMockProviderExtension,
  MOCK_PROVIDER,
  MOCK_MODEL_ID,
  type MockResponse,
  type MockScript,
  type MockState,
} from "./mock-provider.ts";

export interface HarnessOptions {
  /** mock provider が返す応答（順に消費）。 */
  responses: MockResponse[];
  /** pi-quality-flow へ注入する finalizer。未指定は fail-closed。 */
  finalize?: Finalizer;
  /** 固定版 jp-quality-gate の executable（日本語検証の契約試験用）。 */
  gateExecutable?: string;
  /** pi-quality-flow の global 設定ディレクトリ（テスト隔離用）。未指定は agentDir。 */
  configAgentDir?: string;
  /** project trust（設定解決試験用）。未指定は未信頼。 */
  projectTrusted?: boolean;
  /** pi-quality-flow の設定 store 観測 hook（設定変更の競合試験用）。 */
  configStoreHook?: (store: QualityFlowConfigStore) => void;
  /** global 設定ファイル（<agentDir>/quality-flow.json）に書く内容。 */
  globalConfig?: unknown;
  /** project 設定ファイル（<cwd>/.pi/quality-flow.json）に書く内容。 */
  projectConfig?: unknown;
  /** 永続 session（保存・resume 試験用）。未指定は in-memory。 */
  persistent?: boolean;
  /** 既存 session file を resume する（保存／resume 契約試験用）。persistent より優先。 */
  resumeSessionFile?: string;
  /** session_start 追加設定。 */
  thinkingLevel?: "off";
  /** createAgentSession に渡す session_start event の reason（実モードと同じ契約）。 */
  sessionStartReason?: "startup" | "new" | "resume" | "fork" | "reload";
  /** 各 event の観測フック（abort / steer のタイミング制御用）。 */
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
}

export interface Harness {
  session: AgentSession;
  dir: string;
  sessionFile: string | undefined;
  /** pi-quality-flow の candidate 記録（session entry から復元）。 */
  candidateEntries: () => Array<Record<string, unknown>>;
  turnMappingEntries: () => Array<Record<string, unknown>>;
  /** pi-quality-flow の check 記録（session entry から復元）。 */
  checkEntries: () => Array<Record<string, unknown>>;
  /** customType で絞った session entry（config / notify / config-problem など）。 */
  typedEntries: (customType: string) => Array<Record<string, unknown>>;
  /** mock provider が受けた request 群。 */
  mockState: MockState;
  events: () => Array<{ type: string; [key: string]: unknown }>;
  cleanup: () => Promise<void>;
}

export function createMockModel(): Model<Api> {
  return {
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
  };
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-qf-test-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
  });

  const script: MockScript = { responses: options.responses };
  const mockState: MockState = { requests: [], responsesConsumed: 0 };
  const mockExtension: InlineExtension = {
    name: "pi-qf-mock-provider",
    factory: createMockProviderExtension({ script: () => script, state: mockState }),
    hidden: true,
  };
  const qualityExtension: InlineExtension = {
    name: "pi-quality-flow",
    factory: createQualityFlowExtension({
      finalize: options.finalize,
      // 採用シーム（finalize）は pre gate が使える構成だけを対象にする。
      // 契約試験では固定版 binary を既定で渡す。
      gateExecutable: options.gateExecutable ?? (options.finalize !== undefined ? GATE_BIN : undefined),
      configAgentDir: options.configAgentDir ?? agentDir,
      configStoreHook: options.configStoreHook,
    }),
    hidden: true,
  };

  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: false },
      retry: { enabled: false },
    },
    { projectTrusted: options.projectTrusted ?? false },
  );

  // 設定ファイルは session_start（拡張の loadQualityFlowConfig）より先に配置する。
  if (options.globalConfig !== undefined) {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "quality-flow.json"), JSON.stringify(options.globalConfig, null, 2), "utf8");
  }
  if (options.projectConfig !== undefined) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "quality-flow.json"), JSON.stringify(options.projectConfig, null, 2), "utf8");
  }

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPromptOverride: () => "You are a test assistant.",
    extensionFactories: [mockExtension, qualityExtension],
  });
  await loader.reload();

  const sessionManager = options.resumeSessionFile
    ? SessionManager.open(options.resumeSessionFile)
    : options.persistent
      ? SessionManager.create(cwd)
      : SessionManager.inMemory(cwd);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: createMockModel(),
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    tools: [],
    thinkingLevel: options.thinkingLevel ?? "off",
    // 実モード（interactive / print / rpc）と同じ契約: 拡張への session_start 発火に必須。
    sessionStartEvent: { type: "session_start", reason: options.sessionStartReason ?? "startup" },
  });
  // SDK では bindExtensions() を呼ばないと session_start が発火しない。
  // run modes と同じ手順。
  await session.bindExtensions({});

  const capturedEvents: Array<{ type: string; [key: string]: unknown }> = [];
  session.subscribe((event) => {
    const copy = structuredClone(event) as { type: string; [key: string]: unknown };
    capturedEvents.push(copy);
    options.onEvent?.(copy);
  });

  const readEntries = (): Array<Record<string, unknown>> => {
    return session.sessionManager
      .getEntries()
      .filter((e) => e.type === "custom")
      .map((e) => (e as { customType: string; data?: unknown }).data as Record<string, unknown>);
  };

  const readTypedEntries = (): Array<{ customType: string; data?: unknown }> => {
    return session.sessionManager
      .getEntries()
      .filter((e) => e.type === "custom")
      .map((e) => e as { customType: string; data?: unknown });
  };

  return {
    session,
    dir,
    sessionFile: session.sessionFile,
    candidateEntries: () =>
      readEntries().filter((e) => e && typeof e === "object" && "candidateId" in e && "inputHash" in e),
    turnMappingEntries: () =>
      readEntries().filter((e) => e && typeof e === "object" && "candidateId" in e && "turnIndex" in e && !("inputHash" in e)),
    checkEntries: () =>
      readEntries().filter((e) => e && typeof e === "object" && "status" in e && "scope" in e),
    /** customType で絞った session entry（config / notify / config-problem など）。 */
    typedEntries: (customType: string) =>
      readTypedEntries()
        .filter((e) => e.customType === customType)
        .map((e) => e.data as Record<string, unknown>),
    mockState,
    events: () => capturedEvents,
    cleanup: async () => {
      session.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** assistant message の非空 text block 本文を連結する（テスト共通）。 */
export function assistantText(message: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (message.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** session から最後の assistant message を取り出す。 */
export function lastAssistantMessage(session: AgentSession):
  | { text: string; usage: unknown; stopReason: string; thinkingBlocks: number; textBlocks: number }
  | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const assistant = m as {
      content: Array<{ type: string; text?: string; thinking?: string }>;
      usage: unknown;
      stopReason: string;
    };
    const textBlocks = assistant.content.filter((b) => b.type === "text");
    return {
      text: textBlocks.map((b) => b.text ?? "").join(""),
      usage: assistant.usage,
      stopReason: assistant.stopReason,
      thinkingBlocks: assistant.content.filter((b) => b.type === "thinking").length,
      textBlocks: textBlocks.length,
    };
  }
  return undefined;
}