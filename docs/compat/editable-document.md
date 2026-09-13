# 適合記録: EditableDocument（Markdown 構造の保護と編集可能 prose の検証）

> 作成日時: 2026-09-13 15:21
> 更新日時: 2026-09-13 16:20

Issue #6「コード・引用を保護して Markdown 本文だけを検証する」の契約試験記録。
設計書 Appendix D.2 のテンプレートに従う。

## 確認日

2026-09-13（JST）

## テスト実行者 / CI run

ローカル実行（`npm test`、node:test）。CI 未設定。

## OS / runtime

- OS: Linux x86_64（Omarchy / Arch 系）
- runtime: Node.js v26.8.1（node:test、ESM、TS は node の type stripping で実行）

## Pi / SDK version / commit

- `@earendil-works/pi-coding-agent` **0.85.1**（npm registry、npm-shrinkwrap 固定）
- `@earendil-works/pi-ai` 0.85.1
- 本記録の対象コミットは git log 参照（Issue #6 の working-tree 実装）

## Extension / adapter version / commit

- `pi-quality-flow` Phase 0A scaffold + Issue #6 実装
- 構成: `src/japanese/editable-document.ts`（新規）、`src/japanese/service.ts`（`checkJapanese` / `mapGateDiagnostics`）

## Provider / model ID / endpoint（secret を除く）

N/A — 本 Issue はモデル送信を伴わないローカル検証のみ。

## Bridge / agy / ACP engine version（該当時）

N/A — 未使用。

## CLI version / binary digest / schema adapter ID

- `jp-quality-gate` 基準 commit `dac09548710b82333581fc2a3457c6346b628074`
- binary digest（SHA-256）:
  `fa3436f936962b990bb0bb6e1dd04a576f3b316ab72abad34a682deef4d1400f`
- schema adapter: `src/jpqg/schema.ts`（wire → 内部 DTO schemaVersion 1）
- 診断座標の対応付け: `src/japanese/service.ts` `mapGateDiagnostics()`

## Profile / rule policy / config digest

- profile: `tech-minimal`（固定。Issue #9 で許可助詞パターンを追加予定）
- gate rule set: Unihan（`simplified_chinese_form` / `chinese_han_without_japanese_source`）+ CJClassifier（`chinese_segment`）
- optional lint（textlint / natural-japanese）: args と env の両方で無効化（`src/jpqg/runner.ts`）

## 許可された egress / tools / workspace の範囲

- egress: なし（ローカル CLI 呼び出しのみ。モデル送信 0 回）
- tools / workspace: gate CLI の spawn のみ。executable は digest 固定の絶対パス

## 対応構造と parser version

- parser: `mdast-util-from-markdown@2.0.3` + `micromark-extension-gfm@3.0.0` +
  `mdast-util-gfm@3.1.0`（CommonMark + GFM の表 / task list / 打ち消し線）
- source offset 付き AST を使用。parse → stringify による全文再生成は行わない
- 対応範囲は `src/japanese/editable-document.ts` の allowlist で固定:
  - 編集可能 leaf: `text`
  - 編集可能 container: `root`（走査の起点）、`paragraph` `heading`
    `emphasis` `strong` `delete` `listItem` `tableCell` `link`
    `linkReference` `table` `tableRow` `list`
  - 保護 leaf: `inlineCode` `code`（fence / indented）`image` `break`
    `thematicBreak` `footnoteReference` `footnoteDefinition` `definition`
    `yaml`（防御的項目。parser は yaml node を生成しないため通常は到達しない）、
    `blockquote` 全体
  - `link` / `linkReference` は prose label（子 text）だけ編集可能。
    括弧・destination は保護 span
  - 確認済み HTML `code` / `pre`（inline pair と block）のみ保護。
    その他の raw HTML は unsupported-structure
  - text leaf 内の `「…」` / `『…』` は保護（不平衡は unsupported-structure）
  - text leaf 内の URL / path / version / CLI flag / 数値+単位 は保護
- 未知の node 型は fail-closed（unsupported-structure）
- frontmatter（先頭行が `---` または `+++` で、同じ marker の閉じ行が
  存在する対）は unsupported-structure。parser は対応せず
  thematicBreak + heading に分解するため明示的に拒否する。
  単独の `---` 行は CommonMark の正当な thematic break として対応する
- 未解決の reference link（definition なしの `[x][y]`、plain text に分解される）
  は text leaf の raw 走査で検出し unsupported-structure

## 実行条件の固定

- 保護部分は gate projection で中立区切り（空行）に置換し、sentinel は gate に渡さない
- gate への入力は編集可能 segment を原文順に連結した projection。
  同一 block 内の inline 分割（strong / emphasis / link label 等）は
  `blockId` で連結し、block 境界だけ空行区切りを入れる
- 診断は projection 全体の code point offset → 単一 segment 内でのみ
  原文 UTF-16 座標へ変換。`wire.text` と対応 slice の一致を要求し、
  不一致・区切り落ち・segment またぎは `gate-scope-unmappable`（fail-closed）
- BOM は保護 span として保持（micromark が strip する分を補正）
- 全文の Unicode 正規化は行わない。保護 byte 列は原文 byte-equal

## 実行した test ID

|ID|検証内容|結果|
|---|---|---|
|E01|平文 / fence / inline code / blockquote / HTML / link / autolink / image / reference / 表 / task list / heading / emphasis の保護と編集可能範囲|pass|
|E02|未閉じ fence・不平衡 quote・未確認 raw HTML は unsupported-structure|pass|
|E03|entity / escape を含む text leaf の source offset 正確性（`&amp;` 後の version / flag）|pass|
|E04|escaped pipe が table と誤認されない|pass|
|E05|絵文字（surrogate pair）/ BOM / CRLF の座標変換と byte 保持|pass|
|E06|保護 byte 列の byte-equal 保持（独立比較）と重なり併合|pass|
|E07|gate projection の生成と global code point → 原文 UTF-16 変換、区切り落ち・segment またぎの拒否、inline 分割の連結|pass|
|E08|1行 indented code block の対応|pass|
|E09|frontmatter の対（`--- … ---` / `+++ … +++`）は unsupported-structure、単独 `---` は thematic break として対応|pass|
|E10|未解決 reference link（definition なし）は unsupported-structure|pass|
|S02|`checkJapanese()` が EditableDocument 経由で Markdown を検証（fence / inline code / blockquote / 引用 / 表 / HTML code の保護、コードのみ skip、未閉じ fence / 未確認 HTML skip）|pass|
|S03|`mapGateDiagnostics()` の wire.text 一致検査（不一致は gate-scope-unmappable、一致は原文座標）|pass|

## 結果

pass（`npm test` 143 tests / 143 pass、`npm run typecheck` クリーン）

## 根拠

- `test/japanese/editable-document.test.ts`（47 tests）
- `test/japanese/service.test.ts`（23 tests、Issue #3 の構造 skip 期待は Issue #6 の保護挙動へ更新）
- 本文・credential は含まない（診断座標と rule ID のみを entry 記録）

## 既知の制限

- 識別子 / API / package 名 / 辞書の固有名詞 / ログ・エラー原文・citation marker の
  自動検出は未実装（Issue #8 / #9 の profile 固定で追加）。footnoteReference と
  definition は保護済み
- 結合文字（combining sequence）の専用 fixture は未整備（絵文字 surrogate pair のみ）
- pre/post 間の segment 対応契約（同じ segment ID の再利用）は Issue #8 の
  Formatter 復元フローで確定する
- 公開イベント（harness）経路での表 / task list / 対応不能構造の E2E は未実施。
  現状は service 層の unit test で確認

## 再検証が必要な変更条件

- parser 依存（mdast-util-from-markdown / micromark-extension-gfm / mdast-util-gfm）の
  version 変更
- 対応構造 allowlist の変更（node 型の追加・保護規則の変更）
- `jp-quality-gate` の基準 commit / binary digest の変更
- projection の区切り形式や `mapGateDiagnostics` の対応規則の変更
