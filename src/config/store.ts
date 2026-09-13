/**
 * 実行中の設定状態と configRevision（設計書 第27.2章・第29章、Issue #4）。
 *
 * - 設定の変更（command による ON/OFF、mode 変更、再読み込み）で revision を進める
 * - 進んだ revision は in-flight の旧結果の適用を無効化するための鍵になる
 * - 不正な値は受け付けない（呼び出し側で検証済みの値だけを渡す）
 */

import { deepMergeConfig } from "./merge.ts";
import {
  DEFAULT_CONFIG,
  type JapaneseMode,
  type QualityFlowConfig,
} from "./schema.ts";

export interface ConfigSnapshot {
  config: QualityFlowConfig;
  revision: number;
  /** 最後に revision を進めた理由（command / reload / 設定ファイル）。 */
  lastChangeReason: string;
}

export type ConfigChange =
  | { ok: true; snapshot: ConfigSnapshot }
  | { ok: false; reason: string };

export class QualityFlowConfigStore {
  private snapshot: ConfigSnapshot = {
    config: structuredClone(DEFAULT_CONFIG),
    revision: 0,
    lastChangeReason: "initial",
  };

  get current(): ConfigSnapshot {
    return this.snapshot;
  }

  /** session_start 等での全再読み込み。解決結果で置き換える。 */
  reload(config: QualityFlowConfig, reason: string): ConfigSnapshot {
    this.snapshot = { config, revision: this.snapshot.revision + 1, lastChangeReason: reason };
    return this.snapshot;
  }

  setEnabled(enabled: boolean, reason: string): ConfigChange {
    return this.update({ enabled }, reason);
  }

  setJapaneseEnabled(enabled: boolean, reason: string): ConfigChange {
    return this.update({ japanese: { ...this.snapshot.config.japanese, enabled } }, reason);
  }

  setJapaneseMode(mode: JapaneseMode, reason: string): ConfigChange {
    const japanese = { ...this.snapshot.config.japanese, mode };
    // 不正設定（gate 無効 + mode 非off）は last-known-good を維持する。
    if (!japanese.gate.enabled && mode !== "off") {
      return { ok: false, reason: `gate is disabled; mode must be off (requested: ${mode})` };
    }
    return this.update({ japanese }, reason);
  }

  setDebug(debug: boolean, reason: string): ConfigChange {
    return this.update({ debug }, reason);
  }

  /** revision の一致検査（in-flight の旧結果の適用防止用）。 */
  isCurrent(revision: number): boolean {
    return this.snapshot.revision === revision;
  }

  private update(patch: Partial<QualityFlowConfig>, reason: string): ConfigChange {
    const merged = deepMergeConfig(this.snapshot.config, {
      ...structuredClone(this.snapshot.config),
      ...patch,
    } as QualityFlowConfig);
    this.snapshot = {
      config: merged,
      revision: this.snapshot.revision + 1,
      lastChangeReason: reason,
    };
    return { ok: true, snapshot: this.snapshot };
  }
}
