/**
 * 契約試験用: AgentSessionRuntime の起動 fixture（session 切替の契約試験共通）。
 *
 * createAgentSessionServices → createAgentSessionFromServices の起動手順を
 * fixture にまとめ、試験固有の拡張設定（extensionFactories）だけを各テストが
 * 渡せるようにする。応答 script や拡張の組み立ては呼び出し側に残す。
 */
import type { SessionStartEvent, InlineExtension, SessionManager, ModelRuntime as ModelRuntimeType } from "@earendil-works/pi-coding-agent";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createMockModel } from "./harness.ts";

/**
 * CreateAgentSessionRuntimeFactory に渡せる起動 factory を作る。
 * sessionStartEvent は runtime が渡した値をそのまま転送する（new / fork などを反映）。
 *
 * buildExtensionFactories は session ごとに呼ばれる。拡張 instance が内部 state
 * を持つ場合（mock provider の応答消費など）も、session ごとに新鮮な状態になる。
 */
export function createRuntimeSessionFactory(input: {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntimeType;
  /** 試験固有の拡張（mock provider / pi-quality-flow など）。session ごとに構築する。 */
  buildExtensionFactories: () => InlineExtension[];
}) {
  return async ({
    sessionManager,
    sessionStartEvent,
  }: {
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
  }) => {
    const services = await createAgentSessionServices({
      cwd: input.cwd,
      agentDir: input.agentDir,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      modelRuntime: input.modelRuntime,
      resourceLoaderOptions: {
        systemPromptOverride: () => "You are a test assistant.",
        extensionFactories: input.buildExtensionFactories(),
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent:
          sessionStartEvent ?? ({ type: "session_start", reason: "startup" } as SessionStartEvent),
        model: createMockModel(),
        thinkingLevel: "off",
        tools: [],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
}
