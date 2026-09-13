/**
 * PiAdapter (Phase 0A): Pi 0.85.1 依存部分の最小契約。
 *
 * - 対象判定（terminal candidate / Formatter eligibility）
 * - 単一非空 text block の検査と置換
 * - inputHash / outputHash（UTF-8 byte 列の SHA-256）
 *
 * 設計: docs/pi-quality-flow-design-v0.2.md 第6・11・23章。
 * Phase 0A では lifecycle signal 合成や snapshot 検証は行わない（Issue #7）。
 */
import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { MAX_SOURCE_BYTES_LIMIT } from "../config/schema.ts";

/** 自動処理の対象となる原文の上限の既定値（設計書 第19章）。設定値は呼び出し側が渡す。 */
export const MAX_SOURCE_BYTES = MAX_SOURCE_BYTES_LIMIT;

export type EligibilityCode =
  | "ok"
  | "not-assistant"
  | "not-normal-stop"
  | "tool-call-content"
  | "multi-or-empty-text-blocks"
  | "source-too-large";

export interface EligibleText {
  ok: true;
  /** 置換対象の text block の content 配列内 index。 */
  textIndex: number;
  text: string;
}

export type Eligibility =
  | EligibleText
  | { ok: false; code: Exclude<EligibilityCode, "ok"> };

/**
 * terminal candidate 判定 + Formatter eligibility。
 *
 * - 正常 `stop` のみ対象（length / toolUse / error / aborted / deferred / 未知は対象外）
 * - 非空の text block が1つの場合のみ対象。thinking 等の非 text block は保持対象
 * - 原文が設定上限（maxSourceBytes、既定は 8192）を超えたら候補全体を skip
 */
export function isEligibleTerminalCandidate(
  message: AssistantMessage,
  maxSourceBytes: number = MAX_SOURCE_BYTES,
): Eligibility {
  if (message.role !== "assistant") return { ok: false, code: "not-assistant" };
  if (message.stopReason !== "stop") return { ok: false, code: "not-normal-stop" };

  const content = message.content ?? [];
  if (content.some((block) => block.type === "toolCall")) {
    return { ok: false, code: "tool-call-content" };
  }

  type TextBlock = Extract<AssistantMessage["content"][number], { type: "text" }>;
  const isText = (block: AssistantMessage["content"][number]): block is TextBlock =>
    block.type === "text";

  const nonEmptyText: Array<{ index: number; text: string }> = [];
  content.forEach((block, index) => {
    if (isText(block) && block.text.length > 0) {
      nonEmptyText.push({ index, text: block.text });
    }
  });

  if (nonEmptyText.length !== 1) {
    return { ok: false, code: "multi-or-empty-text-blocks" };
  }

  const { index, text } = nonEmptyText[0];
  if (Buffer.byteLength(text, "utf8") > maxSourceBytes) {
    return { ok: false, code: "source-too-large" };
  }

  return { ok: true, textIndex: index, text };
}

/**
 * 単一非空 text block の text だけを置換した AssistantMessage を返す。
 * role / usage / timestamps / thinking / provider・model metadata はすべて保持し、
 * `original` は変更しない（新しいオブジェクトを返す）。
 */
export function replaceSingleTextBlock(
  original: AssistantMessage,
  textIndex: number,
  adopted: string,
): AssistantMessage {
  const content = original.content.map((block, index) =>
    index === textIndex && block.type === "text" ? { ...block, text: adopted } : block,
  );
  return { ...original, content };
}

export function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
