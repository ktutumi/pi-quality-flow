/**
 * jp-quality-gate CLI 出力の wire format パース（設計書 第15.1章）。
 *
 * 不正 JSON、schema 不一致、exit と payload の矛盾、未知 version は
 * すべて internal error として扱う。診断の完全性が保証されない出力は
 * 採用判断に使わない（原文維持、Issue #8 の gate-unusable に接続）。
 */
import type { WireIssue } from "./diagnostics.ts";

export type { WireIssue };

export interface ParsedGateReport {
  status: "pass" | "fail";
  score: { errors: number; warnings: number };
  /** 正規化済みの wire issues（offset は code point、segment 対応前）。 */
  issues: WireIssue[];
  binaryVersion: string;
  unicodeVersion: string;
}

export type ParseFailureCode =
  | "invalid-json"
  | "cli-internal-error"
  | "schema-mismatch"
  | "exit-mismatch"
  | "unknown-exit"
  | "unknown-version";

export type ParseResult =
  | { ok: true; report: ParsedGateReport }
  | { ok: false; code: ParseFailureCode };

/** 適合対象の固定版（基準 commit dac0954、jp-quality-gate 0.1.0 系）。 */
const KNOWN_UNICODE_VERSIONS = new Set(["18.0.0"]);
const KNOWN_CJ_VERSIONS = new Set(["1.0.5"]);

export function parseGateOutput(input: { stdout: string; exitCode: number }): ParseResult {
  if (input.exitCode !== 0 && input.exitCode !== 1 && input.exitCode !== 2) {
    return { ok: false, code: "unknown-exit" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout);
  } catch {
    return { ok: false, code: "invalid-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "invalid-json" };
  }
  const obj = parsed as Record<string, unknown>;

  const internalError = obj["internal_error"];
  if (typeof internalError === "string") {
    if (input.exitCode !== 2) return { ok: false, code: "exit-mismatch" };
    return { ok: false, code: "cli-internal-error" };
  }

  if (typeof obj["pass"] !== "boolean") return { ok: false, code: "schema-mismatch" };
  const summary = obj["summary"];
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    return { ok: false, code: "schema-mismatch" };
  }
  const summaryObj = summary as Record<string, unknown>;
  const errors = summaryObj["errors"];
  const warnings = summaryObj["warnings"];
  const issueCount = summaryObj["issues"];
  if (
    !isNonNegativeInt(errors) ||
    !isNonNegativeInt(warnings) ||
    !isNonNegativeInt(issueCount)
  ) {
    return { ok: false, code: "schema-mismatch" };
  }

  const issues = obj["issues"];
  if (!Array.isArray(issues)) return { ok: false, code: "schema-mismatch" };
  const wireIssues: WireIssue[] = [];
  for (const raw of issues) {
    const issue = parseIssue(raw);
    if (!issue) return { ok: false, code: "schema-mismatch" };
    wireIssues.push(issue);
  }

  // summary と issues の整合（第15.1章: exit と payload の矛盾を拒否）。
  if (issueCount !== wireIssues.length) {
    return { ok: false, code: "schema-mismatch" };
  }
  const errorCount = wireIssues.filter((i) => i.severity === "error").length;
  const warningCount = wireIssues.length - errorCount;
  if (errorCount !== errors || warningCount !== warnings) {
    return { ok: false, code: "schema-mismatch" };
  }
  const expectedStatus = errors === 0 ? "pass" : "fail";
  if (obj["pass"] !== (expectedStatus === "pass")) {
    return { ok: false, code: "schema-mismatch" };
  }
  const expectedExit = errors === 0 ? 0 : 1;
  if (input.exitCode !== expectedExit) {
    return { ok: false, code: "exit-mismatch" };
  }

  const meta = obj["meta"];
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return { ok: false, code: "schema-mismatch" };
  }
  const metaObj = meta as Record<string, unknown>;
  const unicodeVersion = metaObj["unicode_version"];
  const cjVersion = metaObj["cjclassifier_version"];
  if (typeof unicodeVersion !== "string" || typeof cjVersion !== "string") {
    return { ok: false, code: "schema-mismatch" };
  }
  if (!KNOWN_UNICODE_VERSIONS.has(unicodeVersion) || !KNOWN_CJ_VERSIONS.has(cjVersion)) {
    return { ok: false, code: "unknown-version" };
  }

  return {
    ok: true,
    report: {
      status: expectedStatus,
      score: { errors, warnings },
      issues: wireIssues,
      binaryVersion: `unicode=${unicodeVersion},cjclassifier=${cjVersion}`,
      unicodeVersion,
    },
  };
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseIssue(raw: unknown): WireIssue | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["rule"] !== "string" || obj["rule"] === "") return undefined;
  if (obj["severity"] !== "error" && obj["severity"] !== "warning") return undefined;
  if (typeof obj["message"] !== "string") return undefined;
  const start = obj["start"];
  const end = obj["end"];
  if (typeof start !== "number" || !Number.isInteger(start) || start < 0) return undefined;
  if (typeof end !== "number" || !Number.isInteger(end) || end <= start) return undefined;
  if (typeof obj["text"] !== "string") return undefined;
  if (typeof obj["line"] !== "number" || typeof obj["column"] !== "number") return undefined;
  const details = obj["details"];
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  return {
    rule: obj["rule"],
    severity: obj["severity"],
    message: obj["message"],
    start,
    end,
    text: obj["text"],
    line: obj["line"],
    column: obj["column"],
    details: details as Record<string, unknown>,
  };
}
