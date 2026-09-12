/**
 * CLI 契約試験専用: file-based finalizer を注入した pi-quality-flow 拡張。
 *
 * - `PI_QF_REWRITE_FILE`（JSON）を読み、採用本文を返す
 * - `PI_QF_REWRITE_FILE` 未設定時は fail-closed（置換しない）
 *
 * 本番エントリ（extensions/index.ts）からは読み込まれない。テストのみで -e で渡す。
 *
 * fixture 形式:
 * { "adoptedText": "採用本文の全文" }
 */
import { readFileSync } from "node:fs";
import { createQualityFlowExtension } from "../../src/extension.ts";

interface RewriteFixture {
  adoptedText?: string;
}

export default createQualityFlowExtension({
  finalize: () => {
    const path = process.env.PI_QF_REWRITE_FILE;
    if (!path) return undefined;
    const fixture = JSON.parse(readFileSync(path, "utf8")) as RewriteFixture;
    return fixture.adoptedText ?? undefined;
  },
});
