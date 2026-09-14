# Formatter backend の wire format に envelope marker を導入する

> 作成日時: 2026-09-14 16:39

## 状況

設計書 §20 は Formatter の出力契約として「修正後の本文だけ。レビューコメント、理由、前置き、囲いの追加は禁止」を定める。
この契約を機械的に強制する手段がなく、前置きやレビュー文を含む出力を正常な修正案として扱ってしまう risk が Issue #5 の acceptance criteria で明確になった。
prompt の指示は制御の補助であり検証を代替しない（§20 自身の記述）。

## 決定

Formatter backend の **wire format**（model → backend 間の transport 層）に、request 固有の envelope marker を導入する。

- 承認 prompt は、出力の最初と最後に request 固有の nonce 付き marker（`<<FMT:beg:<nonce>>>` / `<<FMT:end:<nonce>>>`）を書くよう求める。
- backend は marker の byte-exact な存在・位置・個数を検査し、内側だけを本文として取り出す。marker の欠落・重複・別 nonce の混入は失敗（fail-closed）とする。
- marker は request ごとに cryptographically random な nonce から生成し、本文中への複製や指示による再現を構造的に拒否できる。
- wire format の上限（出力サイズ上限）は marker を含む raw 出力に対して適用する。

**採用本文の契約は変わらない。** envelope は transport 専用であり、backend が取り出した本文（採用候補）は §20 の「修正後の本文だけ。囲いの追加は禁止」契約を満たす。marker は採用本文・保存セッション・次ターン context に現れない。

§20 の「囲いの追加は禁止」は採用本文に対する契約として維持する。wire format 層の marker は本文への囲いの追加ではなく、model が本文を包む transport フレームとして扱う。この区別を設計書 §20 に追記する。

## 影響

- 設計書 §20: 出力契約に wire format 層の envelope marker を追記する（採用本文の契約は不変）。
- `docs/pi-quality-flow-design-v0.2.md` は設計参照であり、本 ADR が初回実装の wire format を定める。
- 承認 prompt（§20 の prompt テンプレート）に framing 指示を付加する。付加文言は `src/formatter/envelope.ts` の `envelopeInstruction()` に固定する。
- backend の出力検査は、envelope 検査 → 本文取り出し → 既存の検査（非空・単一 text block・サイズ上限）の順で行う。
- 実送信試験（#14）で、model が marker 契約に従えるかを実測する。従えない場合は本 ADR を見直す。
