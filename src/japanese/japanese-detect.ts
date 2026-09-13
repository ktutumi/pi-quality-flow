/**
 * Japanese detection（設計書 第31章）。
 *
 * 判定対象は編集可能 prose 全体ではなく、軽量な文字クラス検出。
 * 呼び出しの絞り込みであり、言語の完全な分類器ではない。
 * CJK-only も中国語混入の可能性があるため除外しない（gate に渡す）。
 */

/** ひらがな (U+3041–U+309F) / カタカナ (U+30A0–U+30FF)。 */
const KANA = /[\u3041-\u30ff]/u;
/** CJK 統合漢字、拡張 A〜F、互換漢字。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ebe0}\u{2f800}-\u{2fa1f}]/u;

/**
 * 編集可能 prose に日本語（または CJK）が含まれるか。
 * かな・漢字のいずれかがあれば true。英語のみ・コードのみ・記号のみは false。
 */
export function detectJapaneseProse(text: string): boolean {
  return KANA.test(text) || CJK.test(text);
}
