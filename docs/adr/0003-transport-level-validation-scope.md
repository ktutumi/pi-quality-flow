# Formatter backend の検証範囲を transport 層に限定する（ADR 0003）

> 作成日時: 2026-09-14 16:50
> 更新日時: 2026-09-14 17:02

初版（2026-09-14 16:50）では本文の内部 invariant（marker 不在、EditableDocument による構造・保護 span 検査、文頭一致検査）を backend に課す決定をしたが、**撤回して置き換える**。

撤回の理由:

1. **文頭一致検査（body-prefix-mismatch）は正当な修正を誤拒否する。** 文頭の誤字修正は tech-minimal の中核ケースであり、共通 prefix の不在を拒否すると「文字を直す」という本来の仕事を妨げる。逆に unchanged prefix の後ろへのレビュー文挿入は見逃すため、偽陰性と偽陽性の両方を生む非対称な検査である。
2. **保護 span・構造一致の検査は #8 の pipeline invariant と重複する。** 採用判断（decideAdoption）が保護領域・構造・意味リスクを検査する前提で backend に同じ検査を入れると、責務が二重化し、メンテナンス対象が増えるだけである。

## 決定

Issue #5 の AC「部分出力、前置きやレビュー文を正常な修正案と扱わない」を **transport 層（framing）の検証に narrow する**。

backend が保証するもの（ADR 0002 の envelope 契約）:

- 出力の完全性: marker の欠落（前置き・後置き・囲いなし出力・部分出力）の拒否
- 境界の正しさ: marker の byte-exact な位置・個数、別 request の marker 混入の拒否
- サイズ上限: marker を含む raw 出力への適用

backend が保証しないもの（#8 の pipeline invariant の管轄）:

- marker の内側に書かれたレビュー文・前置きの検出（内容の判定）
- 保護領域・Markdown 構造・意味リスク・採用判断（decideAdoption の決定表）

**前置き・レビュー文の完全な拒否は #8 の pipeline invariant で達成する**。pipeline は採用判断の一部として、修正案の本文を原文と照合する。ただし既存の構造検査（Markdown block 種別・個数・順序）と保護 span の byte 列一致は段落内の挿入を捕捉できない（Markdown 構造を変えず、保護 span にも触れないため）。レビュー文の検出には、編集可能 segment 内のテキスト差分を扱う**内容レベルの差分 rule（変更量上限、挿入位置・形態の判定）の新規設計と、レビュー文の fixture（文頭追加・段落内挿入）による検証が必要である。

この narrow により、#5 は transport 契約の実装と検証で完了できる。#8 には、編集可能 segment 内のテキスト差分を扱う**内容レベルの差分 rule（変更量上限、挿入位置・形態の判定）を新規に設計し、レビュー文の fixture（文頭追加・段落内挿入）で検証する**ことを受け入れ要件として記録した。既存の構造検査（Markdown block 種別・個数・順序）と保護 span の byte 列一致は段落内の挿入を捕捉できない（Markdown 構造を変えず、保護 span にも触れないため）。既存検査がこの要件を保証すると前提しないこと。

## 影響

- `src/formatter/backend.ts`: 変更なし。本文中の marker prefix は既存の envelope 検査（`extractEnvelope` の marker prefix 出現数チェック）で拒否済みであり、別途の post-extraction 検査は到達不能な重複になるため追加しない。
- Issue #5 の本文: 該当 AC を transport 層の文言に更新する。
- docs/compat/formatter-backend.md: 保証範囲の記録を更新する。
- Issue #8: pipeline invariant の受け入れ要件として「内容レベルの差分 rule の新規設計とレビュー文 fixture による検証」を記録する（既存の構造・保護 span 検査が要件を保証すると前提しない）。
- ADR 0003 初版は撤回（本 ADR に統合）。
