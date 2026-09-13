# 適合記録: jp-quality-gate CLI adapter（Phase 0A〜1 / Issue #3）

> 作成日時: 2026-09-13 05:30
> 更新日時: 2026-09-13 05:30

Issue #3「回答候補をローカル CLI で検証する」の契約試験記録。
形式は設計書 Appendix D.2 のテンプレートに従う。

## 確認日

2026-09-13（JST）

## テスト実行者 / CI run

ローカル実行（`npm test`、node:test）。CI 未設定。

## OS / runtime

- OS: Linux x86_64（Omarchy / Arch 系）
- runtime: Node.js v26.8.1（node:test、ESM、TS は node の type stripping で実行）

## CLI version / binary digest / schema adapter ID

- 対象: `jp-quality-gate`（隣接リポジトリ `../jp-quality-gate`）
- 基準 commit: `dac09548710b82333581fc2a3457c6346b628074`
- 実 binary digest（SHA-256、`bin/jp-quality-gate`）:
  `fa3436f936962b990bb0bb6e1dd04a576f3b316ab72abad34a682deef4d1400f`
- 固定場所: `src/jpqg/runner.ts` の `PINNED_GATE_SHA256`。`checkJapanese()` は
  spawn 前に digest を検証し、不一致・読み取り失敗では実行しない（fail-closed）
- schema adapter: `src/jpqg/schema.ts`（wire format → 内部 DTO schemaVersion 1）

## 実行条件の固定

- spawn: `spawn(executable, ["-textlint=false", "-natural-japanese=false"], { detached: true })`
  shell 文字列なし。file 引数なし（stdin から本文を送る）。
  executable は絶対パスのみ許可（相対名は PATH 探索先が検証対象とずれるため拒否）
- env: 許可 list（`PATH` / `LANG` / `LC_ALL` / `TZ`）のみを引き継ぎ、
  `JPQG_*` を含む他の環境変数は渡さない。呼び出し側が渡しても
  許可 list 外の key は無視される
- cwd: executable の隣接ディレクトリに固定（暗黙の project config 読み込みを回避）。
  `-unihan-table` を渡さないため embedded table を使用
- optional lint: args と env の両方で無効化。textlint / natural-japanese は
  初回の自動処理対象外（設計書 第14章）

## wire format の観測事実（基準 commit dac0954）

1. stdout は 1 行の JSON。`{pass, summary:{errors,warnings,issues}, issues[], meta}`
2. `issues[]` の各要素は `{rule, severity, message, start, end, text, line, column, details}`
3. `start` / `end` は **Unicode code point（rune）offset**
   （`internal/report/report.go` のコメントどおり）。内部 DTO では UTF-16 code unit
   に変換する（`src/jpqg/diagnostics.ts`）
4. exit code: `0=pass`（error 0件）、`1=fail`（error あり）、`2=CLI / config / runtime error`。
   internal error は stdout に `{"pass":false,"internal_error":"..."}` を出力し exit 2
5. `pass` は error 0件のみを意味する。warning は pass に影響しない
   （`-warnings-as-errors` を使わないため）
6. Unihan rule は `simplified_chinese_form`（severity=error、6076字）と
   `chinese_han_without_japanese_source`（severity=warning、16258字）。
   embedded table は Unicode 18.0.0、schema_version 1、計 22334字
7. **Unihan 診断は rule ごとの合計で最大50件**（`internal/unihan.MaxIssues=50`）。
   CJ の `chinese_segment` は別カウントで 50件上限に含まれない。
   打切りの有無を示す field は出力に存在しないため、Unihan rule の診断が
   50件に達したら `gate-diagnostics-incomplete` として採用判断に使わない
8. CJ classifier は `chinese_segment`（warning）を出力。CJ model は embedded
   （cjclassifier 1.0.5）

## 実行した test ID と結果

| ID | 検証内容 | 結果 |
|---|---|---|
| G00 | 実 binary digest が `PINNED_GATE_SHA256` と一致 | pass |
| G01 | PASS テキスト → exit 0 / status=pass | pass |
| G02 | 簡体字 error → exit 1 / status=fail / rule=simplified_chinese_form | pass |
| G03 | optional lint を env（JPQG_TEXTLINT=1 等）から注入しても無効化される | pass |
| G04 | Unihan 49件は完全な診断、50件で打切り（`gate-diagnostics-incomplete`） | pass |
| G05 | 存在しない executable → spawn 前の digest チェックで失敗 | pass |
| G06 | input 128 KiB 超は実行前に拒否 | pass |
| G07 | stdout 256 KiB 超は output-limit-exceeded（過剰バッファリングなし） | pass |
| G08 | timeout で実 process を停止（SIGTERM 無視 process を SIGKILL で停止、生存確認） | pass |
| G09 | cancel（AbortSignal）で実 process を停止 | pass |
| G10 | signal 終了（SIGTERM）は signal-terminated で失敗 | pass |
| G11 | JSON 前後の余分な stdout は invalid-json で失敗 | pass |
| G12 | stdin を読まず exit 2 の process は失敗 | pass |
| G13 | 不正 JSON / 空stdout / exit と payload の矛盾 / 未知 version / summary 不整合 / 非負整数以外の件数 | pass |
| G14 | 診断 offset の code point → UTF-16 変換（surrogate pair / 結合文字 / 範囲外拒否）＋実 CLI fixture（`😀简` → UTF-16 offset 2） | pass |
| G15 | score 比較（lexicographic、(0,0)→(0,5) は regression） | pass |
| S01 | `checkJapanese()`: 平文 PASS / FAIL / 英語のみ skip / 構造 skip（fence・inline code・blockquote・raw HTML・link・表）/ digest 検証 / 50件打切り | pass |
| W01 | 拡張配線: 自動 validation-only gate（日本語 / 英語のみ / CJK-only）と `/quality japanese check`（read-only、モデル要求 0 回、signal・10秒 deadline 伝播、正常 stop 本文のみ対象） | pass |

## 根拠

- `test/jpqg/score.test.ts`、`diagnostics.test.ts`、`schema.test.ts`、`runner.test.ts`
- `test/japanese/japanese-detect.test.ts`、`service.test.ts`、`extension-wiring.test.ts`
- `npm test`（81 tests / 81 pass）、`npm run typecheck`（tsc --noEmit クリーン）

## 安全性の境界

- 診断対象文字列や stderr 全文は通常ログ・session entry に入れない。
  entry には rule ID / severity / 座標 / score のみを記録する
- timeout / cancel は process group（`detached: true` + 負 PID）に対して
  SIGTERM → 500ms 猶予 → SIGKILL の順で停止する
- digest 不一致の binary は一切実行しない。binary の rebuild 時は
  本記録と `PINNED_GATE_SHA256` を更新する

## 既知の制限

- 編集可能 prose の保護（code block / inline code / 引用 / URL 等）と
  source map は Issue #6（EditableDocument）の領域。現段階では
  Markdown 構造の可能性がある候補（fence / inline code / blockquote /
  raw HTML / link / 表）を `unsupported-structure` として保守的に skip する
- segmentId は単一 segment（"s0"）のみ。segment 分割は Issue #6
- exit 2 の際の stderr は失敗理由の hint として先頭 200 文字のみ返す
- exit 2（CLI internal error）は代替実行可能 file で再現している。
  固定 args（`-textlint=false -natural-japanese=false`）と固定 env では
  実 binary を exit 2 にする入力が見つかっておらず、実 binary での
  exit 2 fixture は将来の CLI 契約拡張時に補完する
- timeout / cancel の子孫 process 停止は `detached` + process group kill で実装。
  kill 開始後は close 時に SIGKILL timer を解除しない（TERM 耐性の子孫の
  残留を防ぐ）。実 gate binary が子 process を spawn する構成は現状ない
- 設定面（schema v2 / /quality status / doctor）は Issue #4。
  現在の gate 実行条件は harness 注入または `JPQG_GATE_BIN`（テスト用）のみ

## 再検証が必要な変更条件

- `jp-quality-gate` の基準 commit / binary digest の変更
- `src/jpqg/{schema,diagnostics,runner}.ts` の契約変更
- CLI 出力 schema（`pass` / `summary` / `issues` / `meta`）の変更
- Unihan table / cjclassifier model の更新（version 固定値の更新）
