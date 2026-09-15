/**
 * 意味変更リスク検査（設計書 第22.2章、ADR 0003、Issue #8）。
 *
 * 構造一致だけでは検出できない変更を、編集可能 segment 内のテキスト差分
 * （内容レベルの差分 rule）で検査する:
 *
 * - 文境界判定: segment を文に分割し、文の追加・削除（→ 文段落の追加削除）を
 *   文数の不一致として検出する
 * - 変更量上限: 変更 region 数・region 長・合計変更量を上限で拒否する
 *   （広範な書き換え・レビュー文の挿入を拒否する）
 * - 危険信号: 否定・条件・比較・因果・必須／任意・確信度のトークンが
 *   削除側と挿入側で一致しない変更を拒否する
 * - 助詞変更: 助詞（単体・複合）だけからなる変更 region を
 *   許可パターン導入（Issue #9）まで拒否する
 * - レビュー文・前置き: 挿入側のマーカー語・敬体接尾辞・sentinel 断片を拒否する
 *   （文頭追加・段落内挿入の fixture で検証する）
 *
 * rule・閾値・文境界は TECH_MINIMAL_PROFILE_VERSION に固定する
 * （docs/compat/formatter-pipeline.md、評価例はテスト fixture）。
 */

export const TECH_MINIMAL_PROFILE_VERSION = "tech-minimal-v1";

/** 変更量上限と文境界の固定値（profile tech-minimal-v1）。 */
export const SEMANTIC_RISK_LIMITS = {
  /** segment 内の最大変更 region 数。 */
  maxChangeRegionsPerSegment: 8,
  /** 置換変更（削除+挿入）の片側上限（code points）。 */
  maxReplaceLength: 12,
  /** 挿入のみの変更の上限（code points）。 */
  maxInsertLength: 4,
  /** 削除のみの変更（文字混入除去など）の上限（code points）。 */
  maxDeleteLength: 64,
  /** segment 内の合計変更量上限（code points）。 */
  maxTotalChangePoints: 64,
  /** segment 長がこれを超える場合は比率上限も適用する。 */
  ratioMinSegmentLength: 20,
  /** 合計変更量が segment 長のこの比率を超えたら拒否する。 */
  maxChangeRatio: 0.5,
  /** 文境界の分割に使う文字。 */
  sentenceTerminators: "。！？!?.\n",
} as const;

export type SemanticRiskCode =
  | "sentence-structure-changed"
  | "change-limit-exceeded"
  | "particle-change"
  | "risk-word-change"
  | "commentary-inserted"
  | "sentinel-fragment"
  | "boundary-redistribution";

export type SemanticRiskResult =
  | { ok: true }
  | { ok: false; code: SemanticRiskCode; detail?: string };

export interface ChangeRegion {
  /** 変更開始位置（原文・修正案共通の code point offset）。 */
  start: number;
  /** 削除された原文側の text（空なら純挿入）。 */
  del: string;
  /** 挿入された修正案側の text（空なら純削除）。 */
  ins: string;
}

/** 単純 prefix/suffix で得られる1つの変更 region。 */
export function diffChangedRegions(a: string, b: string): ChangeRegion[] {
  const A = [...a];
  const B = [...b];
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = A.slice(start, endA).join("");
  const midB = B.slice(start, endB).join("");
  if (midA === "" && midB === "") return [];
  // 差分が大きい segment は広範な変更として上限検査に渡す（LCS を展開しない）。
  // 比較は code point 単位（A / B は code point 配列）。
  if (endA - start > MAX_DIFF_LENGTH || endB - start > MAX_DIFF_LENGTH) {
    return [{ start, del: midA, ins: midB }];
  }
  return lcsChangedRegions(A.slice(start, endA), B.slice(start, endB), start);
}

/** LCS diff の展開上限（code points）。これを超える差分は単一 region として扱う。 */
const MAX_DIFF_LENGTH = 400;

/** code point 単位の LCS diff。連続する非一致を1つの region にまとめ、offset を保持する。 */
function lcsChangedRegions(A: string[], B: string[], base: number): ChangeRegion[] {
  const n = A.length;
  const m = B.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        A[i] === B[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const regions: ChangeRegion[] = [];
  let del = "";
  let ins = "";
  let open = false;
  let regionStart = 0;
  const flush = (): void => {
    if (open && (del.length > 0 || ins.length > 0)) {
      regions.push({ start: base + regionStart, del, ins });
    }
    del = "";
    ins = "";
    open = false;
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      flush();
      i++;
      j++;
    } else {
      if (!open) {
        open = true;
        regionStart = i;
      }
      if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        del += A[i++];
      } else {
        ins += B[j++];
      }
    }
  }
  if (!open && (i < n || j < m)) {
    open = true;
    regionStart = i;
  }
  while (i < n) del += A[i++];
  while (j < m) ins += B[j++];
  flush();
  return regions;
}

/** 文に分割する（文末記号を文に含めて分割。文の追加・削除を検出する単位）。 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";
  for (const ch of text) {
    current += ch;
    if (SEMANTIC_RISK_LIMITS.sentenceTerminators.includes(ch)) {
      sentences.push(current);
      current = "";
    }
  }
  if (current.length > 0) sentences.push(current);
  return sentences;
}

/**
 * 助詞変更の検査（Issue #9 の許可パターン導入まで拒否）。
 *
 * 1. 単体・複合助詞のみからなる kana run の一致（純助詞の挿入・削除・置換）。
 *    主体・対象を変えない一般語（例: 「もの」「ました」「しますた」）は一致しない。
 * 2. 削除側と挿入側の先頭 kana run が異なる核助詞ではじまる組
 *    （例: 「がい」→「をみ」）。助詞と語句の同時置換による主体/対象の反転を検出する。
 */
const PARTICLES = new Set([
  "は", "が", "を", "に", "で", "と", "も", "へ", "の", "や", "か", "ね", "よ", "な", "わ", "け",
  "ほど", "くらい", "ぐらい", "ごろ", "ころ",
  "から", "まで", "より", "って", "には", "では", "への", "との", "での", "ので",
  "のに", "のは", "のが", "のを", "のも", "にも", "でも", "とも", "とは",
  "など", "しか", "こそ", "けど", "のみ", "ばかり", "けれど",
]);

/** 主体・対象を反転させ得る核助詞（run 先頭での比較に使う）。 */
const CORE_PARTICLE_CHARS = "がをはにでの";

function kanaRuns(text: string): string[] {
  return text.match(/[ぁ-ゖ]+/g) ?? [];
}

/** 先頭が核助詞ではじまる kana run（2 code points 以上）の先頭助詞。 */
function leadingCoreParticle(text: string): string | undefined {
  const run = text.match(/^[ぁ-ゖ]+/)?.[0];
  if (run === undefined || [...run].length < 2) return undefined;
  const first = [...run][0];
  return CORE_PARTICLE_CHARS.includes(first) ? first : undefined;
}

export function hasParticleChange(del: string, ins: string): boolean {
  // 純助詞の run（例: 「が」「のは」「ほど」）の出入り。
  if (kanaRuns(del).some((run) => PARTICLES.has(run))) return true;
  if (kanaRuns(ins).some((run) => PARTICLES.has(run))) return true;
  // 助詞と語句の同時置換（例: 「がい」→「をみ」）: 両側の先頭核助詞が異なるなら反転。
  const delLead = leadingCoreParticle(del);
  const insLead = leadingCoreParticle(ins);
  if (delLead !== undefined && insLead !== undefined && delLead !== insLead) {
    return true;
  }
  return false;
}

/**
 * 削除側と挿入側で多重度が変わる危険トークン（設計書 第22.2章）。
 * 削除側にだけ / 挿入側にだけ現れるトークンがある場合は意味変更リスクとして拒否。
 */
const RISK_TOKENS: ReadonlyArray<{ category: string; tokens: readonly string[] }> = [
  { category: "negation", tokens: ["ない", "ません", "なかった", "ぬ", "ず", "無し", "不可", "禁止", "できな", "らない", "れない", "あり得ない", "無効", "有効", "成功", "失敗"] },
  { category: "necessity", tokens: ["必須", "必要", "必ず", "任意", "推奨", "望ましい", "すべき", "なければ", "なくては"] },
  { category: "comparison", tokens: ["未満", "以下", "以上", "超過", "超える", "超す", "最大", "最小", "少なくとも", "増加", "減少", "増える", "減る"] },
  { category: "condition", tokens: ["場合", "とき", "時に", "条件", "もし", "ならば", "すれば", "ついて", "関して", "すると"] },
  { category: "causality", tokens: ["ため", "ので", "それで", "により", "によって", "したがって", "つまり", "よって", "なぜなら"] },
  { category: "certainty", tokens: ["確実", "おそらく", "たぶん", "かもしれません", "でしょう", "だろう", "はず", "可能性", "おそれ"] },
];

/**
 * 挿入側のレビュー文・前置きの痕跡（ADR 0003: 文頭追加・段落内挿入の検出）。
 * marker は変更 region の挿入側に現れたときだけ検査する。
 */
const COMMENTARY_MARKERS = [
  "修正案", "修正済", "修正し", "修正:", "修正：",
  "直し", "直して",
  "変更し", "変更済", "訂正", "置き換え", "対応済", "対応し",
  "ご確認", "確認の", "※", "備考", "補足", "注:", "注：", "以上です",
  "お願いし", "以下の", "上記の",
];

/** 挿入のみの変更の敬体接尾辞（前置き・レビュー文の形態）。 */
const POLITE_SUFFIX = /(?:です|ます|ました|ません|ましょう|でした|でしょう|ください)$/;

/** 変更 region に含めてはならない文字（文境界・行境界・sentinel 断片）。 */
const SENTENCE_CHARS = new Set([...SEMANTIC_RISK_LIMITS.sentenceTerminators]);
const SENTINEL_BRACKETS = new Set(["⟦", "⟧"]);

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + 1;
  }
  return count;
}

/** 変更量上限の検査（局所修正の範囲を超える変更の拒否）。 */
function checkChangeLimit(region: ChangeRegion):
  | { ok: true }
  | { ok: false; detail: string } {
  const delLen = [...region.del].length;
  const insLen = [...region.ins].length;
  if (delLen > 0 && insLen > 0) {
    if (delLen > SEMANTIC_RISK_LIMITS.maxReplaceLength || insLen > SEMANTIC_RISK_LIMITS.maxReplaceLength) {
      return { ok: false, detail: `replace ${delLen}→${insLen}` };
    }
    return { ok: true };
  }
  if (delLen > 0) {
    return delLen > SEMANTIC_RISK_LIMITS.maxDeleteLength
      ? { ok: false, detail: `delete ${delLen}` }
      : { ok: true };
  }
  return insLen > SEMANTIC_RISK_LIMITS.maxInsertLength
    ? { ok: false, detail: `insert ${insLen}` }
    : { ok: true };
}

/** sentinel 断片・文境界文字の有無。 */
function findForbiddenChar(text: string): { kind: "sentence" | "sentinel"; ch: string } | undefined {
  for (const ch of text) {
    if (SENTENCE_CHARS.has(ch)) return { kind: "sentence", ch };
    if (SENTINEL_BRACKETS.has(ch)) return { kind: "sentinel", ch };
  }
  return undefined;
}

/**
 * 危険トークンの比較。総量ではなく token 単位で比較する
 * （必須→任意は両側1件ずつでも拒否しなければならない。設計書 第16.2章と同じ
 * 多重度比較の原則を category 内の token に適用する）。
 */
function changedRiskCategory(del: string, ins: string): string | undefined {
  for (const { category, tokens } of RISK_TOKENS) {
    const changed = tokens.some(
      (token) => countOccurrences(del, token) !== countOccurrences(ins, token),
    );
    if (changed) return category;
  }
  return undefined;
}

/** 1つの変更 region の検査 第1段（境界文字・レビュー文・前置き）。 */
function checkRegionCommentary(region: ChangeRegion, segmentText: string):
  | { ok: true }
  | { ok: false; code: SemanticRiskCode; detail: string } {
  const { del, ins } = region;
  const deletedForbidden = findForbiddenChar(del);
  if (deletedForbidden?.kind === "sentence") {
    return { ok: false, code: "sentence-structure-changed", detail: `deleted:${deletedForbidden.ch}` };
  }
  if (deletedForbidden?.kind === "sentinel") {
    return { ok: false, code: "sentinel-fragment", detail: "deleted" };
  }
  const insertedForbidden = findForbiddenChar(ins);
  if (insertedForbidden?.kind === "sentence") {
    return { ok: false, code: "sentence-structure-changed", detail: `inserted:${insertedForbidden.ch}` };
  }
  if (insertedForbidden?.kind === "sentinel") {
    return { ok: false, code: "sentinel-fragment", detail: "inserted" };
  }

  // レビュー文・前置き（挿入側のみ検査。ADR 0003 の fixture を先に特定する）。
  const markers = COMMENTARY_MARKERS.filter((marker) => ins.includes(marker));
  if (markers.length > 0) {
    return { ok: false, code: "commentary-inserted", detail: markers.join(",") };
  }
  if ([...del].length === 0 && [...ins].length >= 2 && POLITE_SUFFIX.test(ins)) {
    return { ok: false, code: "commentary-inserted", detail: `polite-suffix:${ins}` };
  }
  // ラベル付き前置き（「修正版:」等）: 挿入が文境界の直後にあり、かつ
  // 2 code points 以上、あるいは末尾が区切り記号（: ：）で終わる。
  if ([...del].length === 0 && [...ins].length >= 2) {
    const atSentenceStart =
      region.start === 0 || SENTENCE_CHARS.has([...segmentText][region.start - 1] ?? "");
    const labeledSuffix = /(?:[：:]$)/.test(ins);
    if (atSentenceStart || labeledSuffix) {
      return { ok: false, code: "commentary-inserted", detail: `prefixed:${ins}` };
    }
  }
  return { ok: true };
}

/** 1つの変更 region の検査 第2段（変更量・助詞）。 */
function checkRegionChange(region: ChangeRegion):
  | { ok: true }
  | { ok: false; code: SemanticRiskCode; detail: string } {
  // 変更量上限（局所修正の範囲を超える変更の拒否）。
  const limit = checkChangeLimit(region);
  if (!limit.ok) return { ok: false, code: "change-limit-exceeded", detail: limit.detail };

  // 助詞変更（Issue #9 の許可パターン導入まで拒否）。
  if (hasParticleChange(region.del, region.ins)) {
    return { ok: false, code: "particle-change", detail: `${region.del}→${region.ins}` };
  }
  return { ok: true };
}

/**
 * 修正案と原文の編集可能 segment を対応付けて意味リスク検査を行う。
 * segment 数の一致は構造検査（verifyRestoredStructure）で確認済みだが、
 * ここでも防御として検査する。
 */
export function verifySemanticRisk(
  original: { segments: ReadonlyArray<{ text: string }> },
  corrected: { segments: ReadonlyArray<{ text: string }> },
): SemanticRiskResult {
  if (original.segments.length !== corrected.segments.length) {
    return { ok: false, code: "sentence-structure-changed", detail: "segment-count" };
  }
  /** 変更が segment 境界に触れた位置（隣接 pair の再配分検査に使う）。 */
  const boundaryEdits = new Map<number, { start: boolean; end: boolean }>();
  for (let s = 0; s < original.segments.length; s++) {
    const a = original.segments[s].text;
    const b = corrected.segments[s].text;
    if (a === b) continue;

    const originalSentences = splitSentences(a);
    const correctedSentences = splitSentences(b);
    if (originalSentences.length !== correctedSentences.length) {
      return { ok: false, code: "sentence-structure-changed", detail: `segment ${s}` };
    }
    // 文の並べ替え（再配置）: 同じ文の集合が異なる順で現れたら拒否する
    // （設計書 第22.2章: 文や段落の再配置の拒否）。同一文の入れ替えは無害。
    if (reordered(originalSentences, correctedSentences)) {
      return { ok: false, code: "sentence-structure-changed", detail: `segment ${s}: reorder` };
    }

    const regions = diffChangedRegions(a, b);
    if (regions.length > SEMANTIC_RISK_LIMITS.maxChangeRegionsPerSegment) {
      return { ok: false, code: "change-limit-exceeded", detail: `segment ${s}: ${regions.length} regions` };
    }
    const total = regions.reduce(
      (sum, region) => sum + [...region.del].length + [...region.ins].length,
      0,
    );
    const length = [...a].length;
    if (
      total > SEMANTIC_RISK_LIMITS.maxTotalChangePoints ||
      (length >= SEMANTIC_RISK_LIMITS.ratioMinSegmentLength &&
        total > length * SEMANTIC_RISK_LIMITS.maxChangeRatio)
    ) {
      return { ok: false, code: "change-limit-exceeded", detail: `segment ${s}: ${total} points` };
    }

    // region 単位の検査 第1段（境界文字・レビュー文・前置き）。文の始まり
    // 直後の挿入は位置情報を使うため segment 本文を渡す。
    for (const region of regions) {
      const violation = checkRegionCommentary(region, a);
      if (!violation.ok) {
        return { ok: false, code: violation.code, detail: `segment ${s}: ${violation.detail}` };
      }
    }

    // 危険トークンの比較は文の組単位で行う。LCS の一致境界で
    // token（例: ません）が分断されても検出できるようにする
    // （設計書 第16.2章と同じ token 単位の多重度比較を文に適用する）。
    // 助詞検査より先に分類する（「確実に→おそらく」は risk-word-change）。
    for (let i = 0; i < originalSentences.length; i++) {
      const category = changedRiskCategory(originalSentences[i], correctedSentences[i]);
      if (category !== undefined) {
        return { ok: false, code: "risk-word-change", detail: `segment ${s}: ${category}` };
      }
    }

    // region 単位の検査 第2段（変更量・助詞）。
    for (const region of regions) {
      const violation = checkRegionChange(region);
      if (!violation.ok) {
        return { ok: false, code: violation.code, detail: `segment ${s}: ${violation.detail}` };
      }
    }

    // sentinel 境界をまたぐ文字の再配分を検出する（設計書 第21.2章:
    // 所属 block / segment 境界の維持）。隣接する 2 segment が、
    // 片側の末尾と他方の先頭で同時に変わった場合は文字が境界を超えて移動
    // している（例: 「項目`c`説明」→「項`c`目説明」）。
    boundaryEdits.set(s, boundaryTouches(regions, [...a].length));
  }
  const ordered = [...boundaryEdits.entries()].sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < ordered.length; i++) {
    const [prev, prevEdit] = ordered[i - 1];
    const [curr, currEdit] = ordered[i];
    if (curr === prev + 1 && prevEdit.end && currEdit.start) {
      return {
        ok: false,
        code: "boundary-redistribution",
        detail: `segments ${prev}/${curr}`,
      };
    }
  }
  return { ok: true };
}

/** 同じ文の集合が異なる順序で現れたか（再配置の検出）。 */
function reordered(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const sortedA = [...a].sort();
      const sortedB = [...b].sort();
      return sortedA.every((v, k) => v === sortedB[k]);
    }
  }
  return false;
}

/**
 * region が segment の先頭・末尾境界に触れているか
 * （sentinel をはさんだ再配分の検出に使う）。
 */
function boundaryTouches(regions: readonly ChangeRegion[], chunkLength: number): { start: boolean; end: boolean } {
  let touchesStart = false;
  let touchesEnd = false;
  for (const region of regions) {
    const delLen = [...region.del].length;
    const insLen = [...region.ins].length;
    if (region.start === 0) touchesStart = true;
    if (region.start + delLen === chunkLength) touchesEnd = true;
    if (delLen === 0 && insLen > 0 && region.start === chunkLength) touchesEnd = true;
  }
  return { start: touchesStart, end: touchesEnd };
}
