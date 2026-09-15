# 適合記録: Formatter pipeline の保護・検査・採用判断（Issue #8）

> 作成日時: 2026-09-14 21:20
> 更新日時: 2026-09-14 21:20

Issue #8「誤字・文字混入を1 passで修正し、悪化する修正案を拒否する」の pipeline invariant と
risk rule の固定記録。形式は設計書 Appendix D.2 のテンプレートに準ずる。

## pipeline の編成（src/japanese/pipeline.ts）

```text
pre gate（ok・診断完全なものだけ通す）
  → buildProtectedRequest（編集可能 segment だけを露出し、残りを全て request 固有
    sentinel に置き換える。保護 span と Markdown 構文・区切りの両方が露出しない）
  → backend.rewrite（回答候補あたり最大1回。失敗でも再要求しない）
  → verifyAndRestore（衝突・集合・個数・順序・未知 token を検査し、
    送信前 immutable map だけで復元する）
  → verifyRestoredStructure（保護 byte 列 / segment 数 / 所属 block / 構造 fingerprint）
  → verifySemanticRisk（内容レベルの差分 rule）
  → post gate（pre と同じ executable・scope・policy）
  → decideAdoption（決定表。src/japanese/adoption.ts）
```

backend の capability が未検証の間は自動 Formatter を有効化しない
（`docs/compat/formatter-backend.md`、拡張側の `backend-not-verified` 判定）。

## sentinel 契約（src/japanese/sentinel.ts）

- token 形式: `⟦PQF_PROTECTED_<nonce>_<index>⟧`。nonce は request ごとに
  `crypto.randomBytes(12)` から生成する
- request 本文は「gap の sentinel → 編集可能 segment」の document 順交互。
  保護 span に加えて Markdown の構文区切り（見出し marker / list marker /
  表の `|` / paragraph 間の空行 / emphasis marker）も sentinel になり、
  Formatter は編集可能 segment しか変更できない
- 原文に `⟦PQF_PROTECTED_` を含む場合は `sentinel-collision` で拒否
- 検査: 欠落（missing）/ 重複（duplicate）/ 未知 token・改変（unknown）/
  順序変更（out-of-order）を個別コードで拒否する
- 復元は token 出現位置と immutable map の範囲だけから行う。出力内の
  保護内容・周辺 text は信用しない（sentinel 直後の追記は編集領域の変更として
  意味リスク検査に渡る）

## 構造検査（src/japanese/structural.ts）

復元文を再 parse し、原文と比較する:

1. `prepareEditableDocument` で parse 可能（unsupported なら拒否）
2. 保護 span の byte 列一致（sentinel 復元と独立した再 parse 比較）
3. 編集可能 segment 数と所属 block の対応関係（blockId 系列の一致）
4. Markdown 構造 fingerprint（node 型 + 深度 + heading 深度 / list 種別 /
   task list checked の pre-order 列。text leaf の内容は含めない）

## 意味変更リスク（src/japanese/semantic-risk.ts、profile tech-minimal-v1）

| 項目 | 固定値 |
| --- | --- |
| profile version | `tech-minimal-v1` |
| 文境界 | `。！？!?.` と `\n` で分割し、文の組を対応付ける |
| segment 内変更 region 数 | 8 以下 |
| 置換変更の片側上限 | 12 code points |
| 挿入のみの変更上限 | 4 code points |
| 削除のみの変更上限 | 64 code points（文字混入の連続除去を許容） |
| 合計変更量上限 | 64 code points、かつ segment 長 20 以上では 50% |
| LCS diff 展開上限 | 片側 400 code points（超過は単一 region として上限検査） |

risk rule（token は削除側と挿入側の文で token 単位に多重度比較する）:

- negation: `ない` `ません` `なかった` `ぬ` `ず` `無し` `不可` `禁止` `できな` `らない` `れない` `あり得ない`
- necessity: `必須` `必要` `必ず` `任意` `推奨` `望ましい` `すべき` `なければ` `なくては`
- comparison: `未満` `以下` `以上` `超過` `超える` `超す` `最大` `最小` `少なくとも` `増加` `減少` `増える` `減る`
- condition: `場合` `とき` `時に` `条件` `もし` `ならば` `すれば` `ついて` `関して` `すると`
- causality: `ため` `ので` `それで` `により` `によって` `したがって` `つまり` `よって` `なぜなら`
- certainty: `確実` `おそらく` `たぶん` `かもしれません` `でしょう` `だろう` `はず` `可能性` `おそれ`

助詞変更は、単体・複合助詞のみからなる kana run の変更として
（`は` `が` `を` `に` `で` `と` `も` `へ` `の` `や` `か` `ね` `よ` `な` `わ` `け` と
`から` `まで` `より` `って` `には` `では` `への` `との` `での` `ので` `のに` `のは` `のが`
`のを` `のも` `にも` `でも` `とも` `とは` `など` `しか` `こそ` `けど` `のみ` `ばかり` `けれど`）、
Issue #9 の許可助詞パターン導入まで **すべて拒否する**（部分採用はしない）。

レビュー文・前置きの検出（ADR 0003 の受け入れ要件）:

- 挿入側の marker 語（`修正案` `修正済` `修正し` `修正:` `直し` `直して` `変更し`
  `変更済` `訂正` `置き換え` `対応済` `対応し` `ご確認` `確認の` `※` `備考` `補足`
  `注:` `注：` `以上です` `お願いし` `以下の` `上記の`）
- 挿入のみの変更の敬体接尾辞（`です` `ます` `ました` `ません` `ましょう` `でした`
  `でしょう` `ください` で終わる 2 code points 以上の挿入）
- 文境界文字（`。！？!?.`、`\n`）・sentinel 断片（`⟦` `⟧`）を含む変更 region

評価例はテスト fixture として固定する:
`test/japanese/semantic-risk.test.ts`（否定・助詞・文追加・広範変更・
レビュー文の文頭追加／段落内挿入）、`test/japanese/pipeline.test.ts`
（公開イベントからの採用と拒否）。

## 既知の限界

- 変更 region が読点（`、`）の追加・削除・移動を含む場合も、句点・改行以外は
  検査しない（変更量上限とマーカー検査でのみ捕捉）。読点位置の移動は
  tech-minimal の採用対象外だが、本実装では明示的に拒否しない
- segment 内で構造を変えない文字の挿入（例: 見出し語の先頭への `#` 追加）は
  構造 fingerprint では検出できず、変更量上限の範囲で採用され得る
- RISK_TOKENS は部分一致のため、token を含む一般語の修正を拒否することがある
  （fail-closed の方向で許容）
- 閾値・marker 一覧の変更は profile version の更新と評価例の再検証を伴う
