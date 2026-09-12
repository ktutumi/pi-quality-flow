# Issue tracker: GitHub

> 作成日時: 2026-09-13 02:33

Issue と仕様は `ktutumi/pi-quality-flow` の GitHub Issues で管理する。
操作には `gh` CLI を使用する。

## 操作規約

コマンドはこのリポジトリ内で実行する。
対象リポジトリは git remote から判定される。
別のディレクトリから実行する場合は `--repo ktutumi/pi-quality-flow` を指定する。

- 作成: `gh issue create --title "..." --body-file <本文ファイル>`
- 本文・ラベル・コメントの取得: `gh issue view <number> --json number,title,body,labels,comments`
- 一覧: `gh issue list --state open --json number,title,body,labels`
- コメント: `gh issue comment <number> --body-file <本文ファイル>`
- ラベル追加: `gh issue edit <number> --add-label "<label>"`
- ラベル削除: `gh issue edit <number> --remove-label "<label>"`
- クローズ: `gh issue close <number>`

複数行の本文は一時ファイルに記述し、`--body-file` で渡す。
ラベルは `docs/agents/triage-labels.md` の対応表に従う。

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub の Issue と PR は番号を共有する。
番号だけでは区別できない場合は `gh pr view <number>` で確認し、
PR でなければ `gh issue view <number>` で取得する。

## スキルの指示との対応

「issue tracker に公開する」は、GitHub Issue の作成を意味する。
「関連チケットを取得する」は、`gh issue view <number> --comments` を意味する。
