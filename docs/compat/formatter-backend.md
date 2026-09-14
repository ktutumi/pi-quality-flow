# 適合記録: 隔離した Gemini backend の単発要求（Phase 1 / Issue #5）

> 作成日時: 2026-09-13 21:05

Issue #5「隔離した Gemini backend の単発要求を適合確認する」の適合記録。
形式は設計書 Appendix D.2 のテンプレートに従う。

## 状態

**実送信試験: 未実施。** 本記録は実装と mock 試験までを記録し、実モデルへの
送信による適合確認は完了していない。したがって本 backend は **ready ではない**
（capability は既定ですべて false、`isReady() === false`）。自動 Formatter は
本記録の実送信試験が完了するまで有効化しない。

## 確認日

- mock 試験（実装検証）: 2026-09-13（JST）
- 実送信試験: **未実施**

## テスト実行者 / CI run

ローカル実行（`node --test test/formatter/backend.test.ts`、node:test）。CI 未設定。

## OS / runtime

- OS: Linux x86_64（Omarchy / Arch 系）
- runtime: Node.js v26.8.1（node:test、ESM、TS は node の type stripping で実行）

## Pi / SDK version / commit

- `@earendil-works/pi-coding-agent` **0.85.1**（npm registry、npm-shrinkwrap 固定）
- `@earendil-works/pi-ai` 0.85.1
- adapter API: `ModelRegistry.complete(model, context, options)` — `options.signal`
  を request/stream に伝播する。`streamSimple` は使用しない

## Extension / adapter version / commit

- `pi-quality-flow` Phase 1 backend 実装（本記録の対象コミット。コミット hash は git log で参照）
- 構成: `src/formatter/backend.ts`（`StatelessApiBackend` / `resolveFormatterModel` / `validateCompletion`）

## Provider / model ID / endpoint（secret を除く）

- **未固定。** 実 model ID は実送信試験時に固定する（設計書 第19.4章）。
  候補: Google Gemini API の Flash 系1モデル（provider `google`、API `google-generative-ai`）
- 解決は Pi の model discovery と credentials（`registry.find` + `hasConfiguredAuth`）で行う。
  見つからない・認証未設定でも別 model / 別 provider へ fallback しない
- endpoint は `Model.baseUrl` を観測する（secret は記録しない）

## CLI version / binary digest / schema adapter ID

- 本記録は CLI に依存しない（gate CLI は docs/compat/jp-quality-gate-cli.md）

## 許可された egress / tools / workspace の範囲

- egress: `security.cloudEgress=allow` かつ `security.allowedModels.formatter` に
  解決済み model が含まれる場合のみ送信する（extension.ts の `formatterPermission`）
- 送信内容: 承認済み prompt（systemPrompt）+ 保護処理済み本文（user 1通）+
  固定の非機密辞書のみ。`Context` を毎回新規構築するため Main transcript /
  system prompt / thinking / tool result / 過去の Formatter 会話は含まない
- tools: `tools: []` で要求（実行権限の段階での拒否は実送信試験で確認する。
  `tools: []` や自己申告だけで適合とはしない）
- workspace 参照なし（`includeContext` 相当の情報を送らない）

## 実行した test ID と結果（mock 試験）

| ID | 検証内容 | 結果 |
|---|---|---|
| B01 | 未検証 capability は既定ですべて false、`isReady() === false` | pass |
| B02 | 検証済み capability の注入で `isReady() === true` | pass |
| B03 | `resolveFormatterModel` が find + hasConfiguredAuth で解決する | pass |
| B04 | 未設定 model は model-unresolved（fallback しない） | pass |
| B05 | registry に無い model は model-unresolved（fallback しない） | pass |
| B06 | 認証未設定 model は auth-unavailable（fallback しない） | pass |
| B07 | fresh context（systemPrompt + 本文1通、tools 空）を送る | pass |
| B08 | complete は 1回だけ（再試行しない） | pass |
| B09 | complete の throw を request-failed として返す（再試行しない） | pass |
| B10 | abort 済み signal では request を発行しない | pass |
| B11 | complete 中の abort は aborted として返す | pass |
| B12 | 正常 stop の text と usage を返す | pass |
| B13 | length / toolUse / error / aborted を失敗に変換する | pass |
| B14 | 未知の stopReason を失敗に変換する | pass |
| B15 | stop でも toolCall block が混在すれば失敗 | pass |
| B16 | 空出力・複数 text block を失敗にする | pass |
| B17 | thinking があっても text だけを取り出す | pass |
| B18 | 上限超過の出力は切り詰めず失敗にする | pass |
| B19 | 利用不明・部分報告の usage をゼロにしない | pass |
| B20 | request 固有の envelope marker を生成し、framing 指示を承認 prompt に付加する | pass |
| B21 | request ごとに marker が変わる（nonce の使い回しなし） | pass |
| B22 | envelope 契約に従う出力から本文だけを返す（end-to-end） | pass |
| B23 | 前置き付き出力は envelope-missing で拒否する（end-to-end） | pass |
| B24 | 前置き・後置き・囲いなし出力を envelope-missing で拒否する | pass |
| B25 | 本文内の marker 複製（envelope-duplicate）と別 nonce marker（envelope-unknown-marker）を拒否する | pass |
| B26 | 上限超過の raw 出力（marker 込み）は切り詰めず失敗にする | pass |

## AC「前置き・レビュー文を正常な修正案と扱わない」の達成範囲（ADR 0003）

Issue #5 の同 AC は **transport 層（framing）の検証に限定する**（ADR 0003、
docs/adr/0003-transport-level-validation-scope.md）。backend が保証するもの:

- 出力の完全性: marker の欠落（前置き・後置き・囲いなし出力・部分出力）の拒否
- 境界の正しさ: marker の byte-exact な位置・個数、別 request の marker 混入の拒否
- サイズ上限: marker を含む raw 出力への適用

backend が保証しないもの（#8 の pipeline invariant の管轄）:

- **marker の内側に書かれたレビュー文・前置きの検出**（内容の判定）
- 保護領域・Markdown 構造・意味リスク・採用判断

内側のレビュー文（例: `${begin}修正案です：修正しました。…${end}`）は
backend 層では検出できない。framing は境界の証明であり、内側の内容の証明ではない。
完全な拒否は #8 の pipeline invariant で達成する。ただし既存の構造検査
（Markdown block 種別・個数・順序）と保護 span の byte 列一致だけでは
**既存段落内へのレビュー文挿入は捕捉できない**（段落内の挿入は Markdown 構造を
変えず、保護 span にも触れない）。#8 には、編集可能 segment 内のテキスト差分を
扱う内容レベルの差分 rule（変更量上限、挿入位置・形態の判定）を新規に設計し、
レビュー文の fixture（文頭追加・段落内挿入）で検証することを受け入れ要件として
記録済み（issue comment、2026-09-14）。既存の構造・保護 span 検査がこの要件を
保証すると前提しないこと。

文頭一致検査（body-prefix-mismatch）等の backend 層 heuristic は、
文頭の誤字修正（tech-minimal の中核ケース）を誤拒否し、unchanged prefix 後の
挿入を見逃すため ADR 0003 初版で検討したが撤回した。

model が marker 契約そのものに従えない（内側にレビュー文を書く）頻度は
#14 の実送信試験で実測し、頻発する場合は ADR 0002 の見直し（出力契約の
再設計または pipeline 側の追加 invariant）を検討する。

## 実送信試験で確認すべき項目（未実施）

実送信試験は以下を確認してから本記録の「状態」を更新すること:

1. **履歴・指示の分離**: 複数 request で固有データと指示を変え、1つ目の request
   の内容が2つ目の出力に影響しないこと（provider 側の session / cache を含む）。
2. **実行権限の段階での拒否**: file read/write、shell、MCP、delegation を試みる
   入力でも tool 実行が発生しないこと。偶然 tool を呼ばなかったことだけでは
   合格にしない（`tools: []` が provider で強制されることを観測する）。
3. **完了理由と利用量**: 正常 stop / length / error / aborted の区別と、
   usage の報告有無（known / unknown）を実測する。
4. **中断**: cancel / timeout が request/stream に伝播し、以後の処理が
   開始しないこと（`cancellationVerified` の根拠）。
5. **出力完全性**: 部分出力、前置き・レビュー文、巨大出力の扱いを実測する。
   前置き・レビュー文の機械的な拒否機構は上記「未充足の項目」のとおりで、
   envelope 契約の決定（Issue #8）まで存在しない。実送信試験では、
   現行の検査（stop reason / 非空単一 text / toolCall なし / サイズ上限）を
   通過する前置き付き出力が実際に発生するかを実測し、envelope 設計の
   根拠データとする。
6. **固定値の決定**: 実 model ID、endpoint、profile version、送信 token 実測値を
   本記録に追記する。

## 実送信試験の手順（実施時に使う）

実送信は global 許可と明示開始を必須とする別手順で行う（Issue #5 AC、
設計書 第27.2章）。試験は「1 candidate につき Formatter 要求は最大1回」という
運用時の不変則とは別物であり、適合確認のために固定入力群を
**明示承認された bounded suite** として複数回送信する。手順:

1. `~/.pi/agent/auth.json`（または provider 設定）に Google Gemini API の
   credential を設定する。
2. global 設定（`~/.pi/agent/pi-quality-flow.json` 等の global layer）で
   `security.cloudEgress: "allow"` と `security.allowedModels.formatter` に
   対象 model を明示する。project 設定では許可範囲を広げられない。
3. **ユーザーの明示承認**（送信回数と入力群を含めた説明への同意）を得てから
   下記の bounded suite を実行する。運用経路（自動 Formatter）からは送信しない。
4. bounded suite（各 case は独立した `StatelessApiBackend.rewrite()` 呼び出し）:
   - fresh request ×2: 固有データと指示を変えた2つの request を送り、
     1つ目の内容が2つ目の出力に影響しないこと（確認項目1）。
   - tool 誘発入力 ×1〜2: file read/write、shell、MCP、delegation を試みる
     入力を送り、tool 実行が発生しないこと（確認項目2）。
   - 正常入力 ×1: 完了理由と usage の報告有無を観測する（確認項目3）。
   - 中断 case ×1: request 開始後に abort し、伝播と後続処理の停止を
     観測する（確認項目4）。
   - 出力完全性 ×1〜2: 部分出力・前置き・巨大出力の扱いを観測する（確認項目5）。
   合計は概ね6〜8回の送信に収める。
5. 結果を本記録に追記し、capability を検証済み値に更新する
   （確認できない capability は false のまま残す）。

## 観測限界

- provider 内部の再試行・remote 計算・課金の即時停止は観測できない。
  `complete()` の cancel は request/stream の中止のみを保証する。
- provider が usage を報告しない場合、`FormatterUsage.known === false` となり
  token / cost は不明（ゼロと記録しない）。

## 再検証条件

- Pi / pi-ai の version 変更
- model ID / endpoint / provider の変更
- `src/formatter/backend.ts` の request 構築・出力検査の変更
- prompt / profile の変更
