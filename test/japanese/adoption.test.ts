/**
 * 採用決定表の単体試験（Issue #8、設計書 第17章）。
 *
 * 決定表の全行・境界値・複数条件の同時成立を検査する:
 * - (0,0) → (0,5) は post PASS でも拒否（regression を PASS より先に評価）
 * - (0,0) → (0,0) / (0,3) → (0,3) の同点 PASS は採用（局所改善）
 * - (1,0) → (0,3) の PASS は採用（error の改善を優先）
 * - (2,0) → (1,0) の FAIL は acceptImprovement に従う
 * - (1,0) → (1,0) / (1,0) → (2,0) の FAIL は原文維持
 * - 新規 error・forbidNewRules の新規 warning・policy 不一致・診断不完全・
 *   severity 変化・同一 rule の重複を拒否する
 * - 原文採用時の verification は pre、修正案採用時は post
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideAdoption,
  findNewDiagnostics,
  type AdoptionInputs,
} from "../../src/japanese/adoption.ts";
import type { GateCheck, ProseDiagnostic } from "../../src/japanese/service.ts";
import { DEFAULT_CONFIG } from "../../src/config/schema.ts";

const ADOPTION = DEFAULT_CONFIG.japanese.adoption;
const NO_IMPROVE = { ...ADOPTION, acceptImprovement: false };
const FORBID_UNIHAN = { ...ADOPTION, forbidNewRules: ["simplified_chinese_form"] };

const VERSION = "unicode=18.0.0,cjclassifier=1.0.5";
const POLICY = "test-policy/tech-minimal-v1";

function check(
  overrides: Partial<GateCheck> & Pick<GateCheck, "status" | "score">,
  diagnostics: ProseDiagnostic[] = [],
): GateCheck {
  return {
    status: overrides.status,
    scope: overrides.scope ?? "editable-prose",
    diagnostics,
    score: { errors: overrides.score.errors, warnings: overrides.score.warnings },
    binaryVersion: overrides.binaryVersion ?? VERSION,
    incomplete: overrides.incomplete,
    policyDigest: overrides.policyDigest ?? POLICY,
  };
}

function diag(
  ruleId: string,
  severity: "error" | "warning",
  segmentId: string,
  issueKey: string,
): ProseDiagnostic {
  return { ruleId, severity, segmentId, issueKey, start: 0, end: 1, message: "" };
}

function decide(inputs: Omit<AdoptionInputs, "config">, config = ADOPTION) {
  return decideAdoption({ ...inputs, config });
}

test("決定表 第7行: post PASS は採用（同点 PASS の局所改善を含む）", () => {
  for (const [pre, post] of [
    [{ errors: 0, warnings: 0 }, { errors: 0, warnings: 0 }],
    [{ errors: 0, warnings: 3 }, { errors: 0, warnings: 3 }],
    [{ errors: 1, warnings: 0 }, { errors: 0, warnings: 3 }],
  ]) {
    const decision = decide({
      pre: check({ status: "fail", score: pre }),
      post: check({ status: "pass", score: post }),
    });
    assert.equal(decision.result, "adopt", `(${pre.errors},${pre.warnings}) → (${post.errors},${post.warnings})`);
    assert.equal(decision.verification, "post");
  }
});

test("決定表 第6行が 第7行に優先する: (0,0) → (0,5) は PASS でも拒否", () => {
  const decision = decide({
    pre: check({ status: "pass", score: { errors: 0, warnings: 0 } }),
    post: check({ status: "pass", score: { errors: 0, warnings: 5 } }),
  });
  assert.deepEqual(decision, { result: "original", reason: "quality-regression", verification: "pre" });
});

test("決定表 第8行: post FAIL・score 改善は acceptImprovement に従う", () => {
  const improved = decide({
    pre: check({ status: "fail", score: { errors: 2, warnings: 0 } }),
    post: check({ status: "fail", score: { errors: 1, warnings: 0 } }),
  });
  assert.deepEqual(improved, {
    result: "adopt",
    reason: "post-fail-improved",
    verification: "post",
    remainingIssues: true,
  });

  const rejected = decide(
    {
      pre: check({ status: "fail", score: { errors: 2, warnings: 0 } }),
      post: check({ status: "fail", score: { errors: 1, warnings: 0 } }),
    },
    NO_IMPROVE,
  );
  assert.deepEqual(rejected, { result: "original", reason: "no-acceptable-improvement", verification: "pre" });
});

test("決定表 第9行: 改善なしの FAIL は原文維持", () => {
  const same = decide({
    pre: check({ status: "fail", score: { errors: 1, warnings: 0 } }),
    post: check({ status: "fail", score: { errors: 1, warnings: 0 } }),
  });
  assert.deepEqual(same, { result: "original", reason: "no-acceptable-improvement", verification: "pre" });

  const worse = decide({
    pre: check({ status: "fail", score: { errors: 1, warnings: 0 } }),
    post: check({ status: "fail", score: { errors: 2, warnings: 0 } }),
  });
  assert.equal(worse.reason, "quality-regression");
});

test("決定表 第1〜4行はスコア比較より先に評価する", () => {
  const pre = check({ status: "fail", score: { errors: 1, warnings: 0 } });
  const post = check({ status: "pass", score: { errors: 0, warnings: 0 } });

  assert.equal(decide({ invalidated: "cancelled", pre, post }).result, "abort");
  assert.equal(decide({ invalidated: "stale", pre, post }).result, "abort");
  assert.equal(decide({ invalidated: "deadline", pre, post }).result, "abort");

  assert.equal(
    decide({ outputInvalid: "stop-reason-length", pre, post }).reason,
    "incomplete-or-invalid-output:stop-reason-length",
  );
  assert.equal(
    decide({ invariantViolation: "structure-changed", pre, post }).reason,
    "unsafe-rewrite:structure-changed",
  );
  assert.equal(
    decide({ gateUnusable: "post-skipped:gate-scope-unmappable", pre, post }).reason,
    "gate-unusable:post-skipped:gate-scope-unmappable",
  );
  // 複数条件の同時成立: 先頭行で決定する。
  assert.equal(
    decide({ outputInvalid: "stop-reason-length", invariantViolation: "x", pre, post }).reason,
    "incomplete-or-invalid-output:stop-reason-length",
  );
  assert.equal(decide({ pre: undefined, post }).reason, "gate-unusable:missing-check");
});

test("診断不完全・policy 不一致は第4行で拒否する", () => {
  const pre = check({ status: "fail", score: { errors: 1, warnings: 0 } });
  const incompletePost = check({
    status: "pass",
    score: { errors: 0, warnings: 0 },
    incomplete: "gate-diagnostics-incomplete",
  });
  assert.equal(
    decide({ pre, post: incompletePost }).reason,
    "gate-unusable:gate-diagnostics-incomplete",
  );
  const versionPost = check({
    status: "pass",
    score: { errors: 0, warnings: 0 },
    binaryVersion: "unicode=18.0.0,cjclassifier=0.9.9",
  });
  assert.equal(
    decide({ pre, post: versionPost }).reason,
    "gate-unusable:binary-version-mismatch",
  );
  // scope の不一致も比較不能（防御。型上は同値だが policy 違反として拒否）。
  const scopePost = check({
    status: "pass",
    score: { errors: 0, warnings: 0 },
    scope: "full-text" as never,
  });
  assert.equal(
    decide({ pre, post: scopePost }).reason,
    "gate-unusable:scope-mismatch",
  );
  // 比較 policy（policyDigest）の不一致も第4行で拒否する。
  const policyPost = check({
    status: "pass",
    score: { errors: 0, warnings: 0 },
    policyDigest: "test-policy/tech-minimal-v2",
  });
  assert.equal(
    decide({ pre, post: policyPost }).reason,
    "gate-unusable:policy-mismatch",
  );
});

test("新規 error を multiset で拒否する（件数が同じでも別 error なら拒否）", () => {
  const pre = check({ status: "fail", score: { errors: 1, warnings: 0 } }, [
    diag("rule_a", "error", "s0", "key-1"),
  ]);
  const postSameCount = check({ status: "fail", score: { errors: 1, warnings: 0 } }, [
    diag("rule_b", "error", "s0", "key-2"),
  ]);
  assert.equal(
    decide({ pre, post: postSameCount }).reason,
    "new-forbidden-diagnostic:error:rule_b",
  );

  // 診断が消えた場合は新規ではない
  const postResolved = check({ status: "pass", score: { errors: 0, warnings: 0 } }, []);
  assert.equal(decide({ pre, post: postResolved }).result, "adopt");
});

test("重複診断の multiset 比較（同数なら新規ではない）", () => {
  const duplicate = (): ProseDiagnostic[] => [
    diag("rule_a", "error", "s0", "key-1"),
    diag("rule_a", "error", "s0", "key-1"),
  ];
  const pre = check({ status: "fail", score: { errors: 2, warnings: 0 } }, duplicate());
  // 同数の FAIL は新規診断はないが改善もない → 第9行で原文維持
  const postSame = check({ status: "fail", score: { errors: 2, warnings: 0 } }, duplicate());
  assert.deepEqual(decide({ pre, post: postSame }), {
    result: "original",
    reason: "no-acceptable-improvement",
    verification: "pre",
  });
  // 同一診断が1つ増えた場合は新規 error
  const postPlusOne = check({ status: "fail", score: { errors: 3, warnings: 0 } }, [
    ...duplicate(),
    diag("rule_a", "error", "s0", "key-1"),
  ]);
  assert.equal(
    decide({ pre, post: postPlusOne }).reason,
    "new-forbidden-diagnostic:error:rule_a",
  );
  // 重複が減ったときは改善として採用経路に進む
  const postLess = check({ status: "fail", score: { errors: 1, warnings: 0 } }, [
    diag("rule_a", "error", "s0", "key-1"),
  ]);
  assert.equal(decide({ pre, post: postLess }).result, "adopt");
});

test("forbidNewRules の新規診断（warning 含む）を拒否する", () => {
  const pre = check({ status: "pass", score: { errors: 0, warnings: 0 } }, []);
  const post = check({ status: "fail", score: { errors: 0, warnings: 1 } }, [
    diag("simplified_chinese_form", "warning", "s0", "char:设"),
  ]);
  assert.equal(
    decide({ pre, post }, FORBID_UNIHAN).reason,
    "new-forbidden-diagnostic:forbidden:simplified_chinese_form",
  );
});

test("severity の変化（warning→error）は新規 error として拒否する", () => {
  const pre = check({ status: "fail", score: { errors: 0, warnings: 1 } }, [
    diag("rule_a", "warning", "s0", "key-1"),
  ]);
  const post = check({ status: "fail", score: { errors: 1, warnings: 0 } }, [
    diag("rule_a", "error", "s0", "key-1"),
  ]);
  assert.equal(
    decide({ pre, post }).reason,
    "new-forbidden-diagnostic:error:rule_a",
  );
});

test("原文採用時の検証状態は pre、採用時は post（不採用修正案の PASS を転用しない）", () => {
  const pre = check({ status: "fail", score: { errors: 1, warnings: 0 } });
  // gate-unusable で原文維持 → verification は pre
  const rejected = decide({ gateUnusable: "post-gate-failed:timeout", pre });
  assert.deepEqual(rejected, {
    result: "original",
    reason: "gate-unusable:post-gate-failed:timeout",
    verification: "pre",
  });
});

test("findNewDiagnostics は multiset で新規出現だけを返す", () => {
  const pre = [diag("a", "error", "s0", "k1"), diag("a", "error", "s0", "k1")];
  const post = [diag("a", "error", "s0", "k1"), diag("a", "warning", "s0", "k1")];
  // post の warning は新規（forbidNewRules に a があれば拒否）
  const forbidA = { ...ADOPTION, forbidNewRules: ["a"] };
  assert.equal(findNewDiagnostics(pre, post, forbidA), "forbidden:a");
  // forbidNewRules が空なら新規 warning は拒否しない
  assert.equal(findNewDiagnostics(pre, post, ADOPTION), undefined);
  // 消費しきれない post の error は新規 error
  const postNewError = [diag("a", "error", "s0", "k1"), diag("a", "error", "s0", "k1"), diag("a", "error", "s0", "k2")];
  assert.equal(findNewDiagnostics(pre, postNewError, ADOPTION), "error:a");
});
