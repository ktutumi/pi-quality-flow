# 適合記録: Pi 0.85.1 での採用本文の直接置換（Phase 0A）

> 作成日時: 2026-09-13 04:05
> 更新日時: 2026-09-13 04:45

Issue #2「Pi 0.85.1 で採用本文の5面一致を確認する」の契約試験記録。
形式は設計書 Appendix D.2 のテンプレートに従う。

## 確認日

2026-09-13（JST）

## テスト実行者 / CI run

ローカル実行（`npm test`、node:test）。CI 未設定。

## OS / runtime

- OS: Linux x86_64（Omarchy / Arch 系）
- runtime: Node.js v26.8.1（node:test、ESM、TS は node の type stripping で実行）

## Pi / SDK version / commit

- `@earendil-works/pi-coding-agent` **0.85.1**（npm registry）
  - integrity: `sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==`（npm-shrinkwrap により pi-ai / pi-agent-core も同版に固定）
- `@earendil-works/pi-ai` 0.85.1
- 実バイナリ: 同版の pi CLI。試験は `pi --version` が `0.85.1` であることを前提に実行する（cli.test.ts が検証）

## Extension / adapter version / commit

- `pi-quality-flow` Phase 0A scaffold（本記録の対象コミット。コミット hash は git log で参照）
- 構成: `extensions/index.ts`（fail-closed 既定）、`src/extension.ts`（`createQualityFlowExtension({ finalize })`）、`src/pi/adapter.ts`、`src/coordinator/candidates.ts`
- 既定 export は finalize を持たないため、どの回答候補も置換しない（candidate の観測と記録のみ）

## Provider / model ID / endpoint（secret を除く）

- provider `pi-qf-mock` / model `mock-1` / API `pi-qf-mock-api`
- `streamSimple` による決定論的 mock（test/helpers/mock-provider.ts）。外部 endpoint への送信なし
- 実モデル（Gemini 等）は本段階では接続しない

## CLI version / binary digest / schema adapter ID

- `jp-quality-gate` CLI は本段階で未接続（Issue #3）
- 対応計画: 基準 commit `dac09548710b82333581fc2a3457c6346b628074`

## 許可された egress / tools / workspace の範囲

- egress なし（mock provider は in-process）
- tools 無効（`tools: []`）
- workspace 参照なし（project config 未読み取り。Phase 0A では trust が挙動を変えない）

## 実行した test ID と結果

5面の定義（設計書 第23.2章）: TUI 最終表示、RPC final（`message_end.message`）、`turn_end.message`、保存セッション、次ターン Executor context。

| ID | 検証内容 | 結果 |
|---|---|---|
| P01 面2（SDK） | `message_end.message` が採用本文。usage・provider・model・thinking・stopReason を保持 | pass |
| P01 面2（実 CLI json mode） | 同上を実バイナリの JSON 出力で確認 | pass |
| P01 面2（実 CLI rpc mode） | RPC final event の message が採用本文 | pass |
| P01 面3 | `turn_end.message` が採用本文（SDK と実 CLI json mode） | pass |
| P01 面4 | 保存セッションが採用本文（SDK 永続 session と実 CLI `--session-dir`） | pass |
| P01 面4b | resume: 実 SDK の `SessionManager.open` + `reason=resume` で復元され、復元後の最初の request context も採用本文 | pass |
| P01 面5 | 次ターン Executor context に採用本文（mock provider が受けた request.messages で確認） | pass |
| P01 面1 | TUI 最終表示が採用本文（実バイナリ + `script` PTY。採用本文が描画され、原文は置換前の暫定描画にのみ現れる） | pass |
| P02 | streaming は暫定版: delta は原文 A、final は採用本文 B に収束 | pass |
| P03 | candidateId は本文 hash に依存しない。A→B 置換後も同一 candidateId。同一本文の別 run は別 candidate。message_end と turn_end の対応（entry 記録で確認） | pass |
| P05 部分 | streaming 中 abort → stopReason=aborted、置換なし、candidate 記録なし。length → 置換なし | pass |
| P05 部分 | queued continuation 観測時（`ctx.hasPendingMessages()`）は置換を開始しない。待機が空いた後の応答は置換される。追加 Executor ターン 0（mock request 数で確認） | pass |
| P05 部分 | runtime `newSession()` → `session_start reason=new`、`fork()` → `reason=fork` が届き、旧 session の candidate epoch は無効化される | pass |
| （対称判定） | stop のみ対象。length/aborted/error/toolCall/空 text/複数非空 text block/8193 bytes は対象外、8192 bytes ちょうどは対象 | pass |
| （trust 観測） | `ctx.isProjectTrusted()` は拡張から呼べる boolean（未信頼 tmp project で false を観測）。Phase 0A は project config を読まないため挙動に影響しない | pass（観測のみ） |
| P04 steering（技術指摘） | Phase 2 に移設（設計書 第49章） | not-run（計画どおり） |
| P06 compaction | harness は自動 compaction 無効。compaction 時の挙動は Issue #7 で契約試験する | not-run（限界を明示） |
| 実 Escape キー入力 | in-process 試験は TUI Escape と同じ abort 経路（`session.abort()`）を使用。キーボードレベルの検証はしていない | not-run（限界を明示） |
| toolCall 含む実応答の agent loop 全体 | 対象判定は adapter 単体で検証済み。実 stream での toolCall 応答フローは Issue #8 の完了性試験 | not-run（部分） |
| P10 他 Extension 競合 | 未実施。doctor 競合診断は Issue #10 | not-run |
| 複数 candidate の同時実行（同時 event） | Phase 0A の finalize は同期完了のため発生し得ない。非同期化後（Issue #7）に single-flight を統合試験する | not-run（限界を明示） |

## 根拠

- `test/compatibility/replacement.test.ts`、`candidate.test.ts`、`lifecycle.test.ts`、`cli.test.ts`（node:test、18 tests / 18 pass）
- `npm run typecheck`（tsc --noEmit クリーン）
- 本文・credential はログに含めない。テスト内の非機密 fixture の短い断片が失敗時メッセージに現れることがある

## Phase 0A で確認した Pi 0.85.1 の契約事実

1. `message_end` の返却 `{ message }` は同一 role の message に対する in-place 置換
   （`AgentSession._replaceMessageInPlace`）。agent state・`turn_end.message`・session 永続化・
   session.subscribe リスナー・次ターン context が同一の置換後本文を参照する
2. このバージョンでは置換後も message オブジェクト identity は保持される
   （実測： message_end と turn_end が同じオブジェクトを渡す）。
   Phase 0A の拡張はこの観測された動作に依存し、
   重複・再入検出と turn_end の対応付けを pre-replacement の message オブジェクトへの
   WeakMap 束縛で実装している。
   これは Pi 0.85.1 固有の仮定であり、将来版で message が再生成される
   （identity が変わる）実装になった場合、同一 candidate を
   別 candidate として再処理する可能性がある。
   バージョン非依存の event identity mapping は Issue #7 で再検討する
3. SDK（`createAgentSession`）は `sessionStartEvent` を渡しても `session.bindExtensions()` を
   呼ばないと `session_start` が拡張へ届かない（run modes は必ず bind する）
4. `ctx.hasPendingMessages()` は steering / followUp の待機件数。message_end 時点で観測可能
5. `session.abort()` で stream が中断されると stopReason=aborted の部分本文が確定する（対象外）
6. `AgentSessionRuntime.newSession()` / `fork()` は `session_shutdown` → 新 `session_start(reason=new|fork)` の順で拡張に通知される
7. `turn_end` の session.subscribe に流れる event は内部 agent event で turnIndex を持たない。
   拡張は `turn_start` で Pi の turnIndex を追跡して対応付ける。各 prompt は新しい agent run になり turnIndex は 0 に戻る

## 既知の制限

- Phase 0A の finalize は同期的に完了する。await 後の stale 検査・遅延結果の適用競合・
  実停止は本段階では検証できない（Issue #7）
- compaction（P06）と実キーボードの Escape は未検証（Issue #7 / TUI 手順で補完）
- 実モデル・`jp-quality-gate` CLI は未接続。実 Pi バイナリ（0.85.1）での契約試験と
  mock provider / file-based finalizer による検証のみ
- RPC client の event 取りこぼしに関する継続消費の検証は Issue #13 の E2E で行う
- project trust が挙動に関わるのは Issue #4（project config 読み取り導入時）以降

## 再検証が必要な変更条件

- Pi / SDK のバージョン変更（0.85.1 以外への対応時）
- `src/pi/adapter.ts` の対象判定または `replaceSingleTextBlock` の変更
- `src/coordinator/candidates.ts` の identity 規則の変更
- extension のイベント接続構造の変更（message_end / turn_end ハンドラ）
- Node.js の major 更新（type stripping の挙動変化）

## 次段階への引き継ぎ

- Issue #3: 同一 harness に `jp-quality-gate` CLI adapter を接続（pre gate / validation-only）
- Issue #4: 設定 schema v2 と `/quality` command（fail-closed default は維持）
- Issue #7: finalize の非同期化、await 後 token 検査、deadline 実停止、compaction / Escape 契約
- Issue #8: `finalize` シームを日本語 Pipeline で置換し、採用決定表を導入
