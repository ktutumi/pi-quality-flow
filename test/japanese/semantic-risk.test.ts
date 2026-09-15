/**
 * 意味変更リスク検査の単体試験（Issue #8、設計書 第22.2章、ADR 0003）。
 *
 * 評価例（fixture）は profile tech-minimal-v1 の許容・拒否の境界を固定する:
 * - 否定・条件・比較・因果・必須／任意・確信度の変更を拒否
 * - 助詞変更（許可パターン導入前）を拒否
 * - 文・段落の追加削除、広範な変更を拒否
 * - レビュー文の挿入（文頭追加・段落内挿入の fixture）を拒否
 * - 明らかな誤字・文字混入の局所修正は許可
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  verifySemanticRisk,
  diffChangedRegions,
  hasParticleChange,
  splitSentences,
  TECH_MINIMAL_PROFILE_VERSION,
} from "../../src/japanese/semantic-risk.ts";
import { prepareEditableDocument } from "../../src/japanese/editable-document.ts";

function riskOf(original: string, corrected: string) {
  const result = verifySemanticRisk(
    { segments: [{ text: original }] },
    { segments: [{ text: corrected }] },
  );
  return result;
}

function expectReject(original: string, corrected: string, code: string): void {
  const result = riskOf(original, corrected);
  assert.ok(!result.ok, `拒否されるべき: ${JSON.stringify(result)}`);
  assert.equal(result.code, code);
}

function expectAllow(original: string, corrected: string): void {
  const result = riskOf(original, corrected);
  assert.ok(result.ok, `許可されるべき: ${JSON.stringify(result)}`);
}

test("明らかな誤字・文字混入の局所修正は許可する", () => {
  expectAllow("この実装方案では、APIの返却値を直接利用します。", "この実装方針では、APIの返却値を直接利用します。");
  expectAllow("確認お愿いします。", "確認お願いします。");
  expectAllow("設計です。", "設計です。"); // 無変更
  expectAllow("確認をお願ｲします。", "確認をお願いします。");
  expectAllow("削除しすます。", "削除します。");
  // 純削除（文字混入の除去）
  expectAllow("確認をお願ｲｲします。", "確認をお願いします。");
});

test("否定の反転を拒否する（削除しません → 削除します）", () => {
  expectReject("削除しません。", "削除します。", "risk-word-change");
  expectReject("実行しない。", "実行する。", "risk-word-change");
  // 逆方向（肯定→否定）も拒否（敬体否定の挿入は否定 token として検出）
  expectReject("対応済みです。", "対応済みではありません。", "risk-word-change");
});

test("必須／任意・確信度・比較の変更を拒否する", () => {
  expectReject("設定は必須です。", "設定は任意です。", "risk-word-change");
  expectReject("5未満です。", "5以下です。", "risk-word-change");
  expectReject("確実に動作します。", "おそらく動作します。", "risk-word-change");
  expectReject("場合のみ実行します。", "条件を満たすと実行します。", "risk-word-change");
  // 同じ token が両側にあれば許可（token の移動でない置換）
  expectAllow("必須の確認しまzす。", "必須の確認します。");
  // 助詞の挿入（欠落補い）も許可パターン未登録のため拒否する
  expectReject("このため実行します。", "このために実行します。", "particle-change");
});

test("主体・対象を反転させる助詞変更を拒否する（許可パターン導入前）", () => {
  expectReject("A が B を削除します。", "A を B が削除します。", "particle-change");
  expectReject("設定の変更です。", "設定を変更です。", "particle-change");
  // 助詞の重複削除（のの → の）も許可パターン未登録のため拒否
  expectReject("設定のの変更です。", "設定の変更です。", "particle-change");
});

test("助詞文字を含まない普通の語の修正は許可する", () => {
  expectAllow("確認ました。", "確認しました。");
  expectAllow("しますた。", "しました。");
});

test("文の追加・削除（文数の不一致）を拒否する", () => {
  expectReject("本文です。", "前置きの文です。本文です。", "sentence-structure-changed");
  expectReject("本文です。追加分です。", "本文です。", "sentence-structure-changed");
  // 同一 segment 末尾への文追加（構造上は同じ segment）
  expectAllow("ひとつの文です。", "ひとつの文です。");
});

test("広範な変更（変更量上限）を拒否する", () => {
  const long = "あいうえおかきくけこさしすせそたちつてとなにぬねの。";
  expectReject(long, "ABCDEFGHijklmnopqrstuvwxyz0123456789です。", "change-limit-exceeded");
  // 大きな置換（文数を保ったままの全文書き換え）
  expectReject(
    "ごく普通の説明の文です。ここから先も続きます。",
    "完全に別の内容に置き換えた文章の例。ここから先も拒否します。",
    "change-limit-exceeded",
  );
});

test("複数の局所修正は許可する（1 segment 内の複数 region）", () => {
  expectAllow(
    "方案と方案と方案の修正です。",
    "方針と方針と方針の修正です。",
  );
});

test("レビュー文の文頭追加を拒否する（ADR 0003 fixture 1）", () => {
  const original = "この実装方案では、APIの返却値を直接利用します。";
  // 文頭にレビュー文を追加した修正案
  expectReject(
    original,
    "修正しました。この実装方案では、APIの返却値を直接利用します。",
    "sentence-structure-changed",
  );
  // 句点なしの文頭追加（「修正案です」）
  expectReject(
    original,
    "修正案:この実装方案では、APIの返却値を直接利用します。",
    "commentary-inserted",
  );
});

test("レビュー文の段落内挿入を拒否する（ADR 0003 fixture 2）", () => {
  const original = "この実装方案では、APIの返却値を直接利用します。";
  expectReject(
    original,
    "この実装方案では、修正案です:APIの返却値を直接利用します。",
    "commentary-inserted",
  );
  // 敬体接尾辞の挿入（前置きの形態）
  expectReject(
    original,
    "この実装方案では、以下のAPIの返却値を直接利用します。",
    "commentary-inserted",
  );
});

test("sentinel 断片の混入を拒否する", () => {
  expectReject("本文です。", "本文⟦です。", "sentinel-fragment");
  expectReject("本文です。", "本文⟧です。", "sentinel-fragment");
});

test("diffChangedRegions は複数の変更点を分離する", () => {
  const regions = diffChangedRegions("方案あ方案い方案う", "方針あ方針い方針う");
  assert.equal(regions.length, 3);
  assert.deepEqual(regions[0], { start: 1, del: "案", ins: "針" });
});

test("degree 助詞・核助詞同時置換・文の並べ替え・有効無効の反転を拒否する", () => {
  expectReject("数分ほど待機します。", "数分くらい待機します。", "particle-change");
  expectReject("犬がいる。", "犬をみる。", "particle-change");
  expectReject("設定は有効です。", "設定は無効です。", "risk-word-change");
  expectReject("成功します。", "失敗します。", "risk-word-change");
  expectReject("送信します。保存します。", "保存します。送信します。", "sentence-structure-changed");
});

test("ラベル付き前置きの挿入を marker 一覧外でも拒否する", () => {
  const original = "この実装方案では、返却値を直接利用します。";
  // 文頭追加（marker 一覧外の「修正版:」）
  expectReject(original, "修正版:この実装方案では、返却値を直接利用します。", "commentary-inserted");
  // 段落内挿入
  expectReject(original, "この実装方案では、修正版:返却値を直接利用します。", "commentary-inserted");
  // 「（校正後）」のような前置きは文頭ルールが先に分類する（挿入上限より先）
  expectReject("本文です。", "（校正後）本文です。", "commentary-inserted");
});

test("sentinel 境界をまたぐ文字の再配分を拒否する", () => {
  const risk = (a: string, b: string) => {
    const docA = prepareEditableDocument(a);
    const docB = prepareEditableDocument(b);
    assert.ok(docA.supported && docB.supported);
    return verifySemanticRisk(docA, docB);
  };
  const r1 = risk("項目`API`説明", "項`API`目説明");
  assert.ok(!r1.ok);
  assert.equal(r1.code, "boundary-redistribution");
  const r2 = risk("あ`x`いう。", "あい`x`う。");
  assert.ok(!r2.ok);
  assert.equal(r2.code, "boundary-redistribution");
  // 片側だけの境界隣接修正（誤字修正）は許可する
  assert.ok(risk("項目`API`説明", "項目`API`解説").ok);
  assert.ok(risk("`API`方案の返却", "`API`方針の返却").ok);
});

test("splitSentences は文末記号と改行で分割する", () => {
  assert.deepEqual(splitSentences("ひとつ。ふたつ！みっつ"), ["ひとつ。", "ふたつ！", "みっつ"]);
  assert.deepEqual(splitSentences("行1\n行2\n"), ["行1\n", "行2\n"]);
});

test("hasParticleChange は純助詞 run と核助詞の先頭ペアを検出する", () => {
  assert.equal(hasParticleChange("が", ""), true);
  assert.equal(hasParticleChange("", "のは"), true);
  assert.equal(hasParticleChange("ほど", "くらい"), true);
  assert.equal(hasParticleChange("ました", "しました"), false);
  assert.equal(hasParticleChange("など", ""), true);
  assert.equal(hasParticleChange("もの", ""), false);
  // 助詞と語句の同時置換（主体・対象の反転）: 先頭核助詞が異なる組
  assert.equal(hasParticleChange("がい", "をみ"), true);
  // 同じ核助詞のままの変更は助詞変更として扱わない
  assert.equal(hasParticleChange("がい", "がなる"), false);
  assert.equal(hasParticleChange("まし", "しまし"), false);
});

test("profile version は固定値として公開する", () => {
  assert.equal(TECH_MINIMAL_PROFILE_VERSION, "tech-minimal-v1");
});
