# ADR-0012: PR の修正では Claude Code にコマンドを許し、認証情報は渡さない

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: YutaUra

## Context

依存更新の PR の「修正して push する」手順（#39 など）を Claude Code に任せたい。修正には lockfile の更新
（`pnpm install`）や、確認のコマンド（`pnpm changeset version`、型チェックなど）が要る。
これまでは、外部への書き込みを承認なしにさせない（charter・CLAUDE.md）ため、Claude Code に Bash を渡していなかった。

## Decision

- PR の修正（`fix_pull_request`）に限り、Claude Code に Read・Edit・Write・Grep・Glob・Bash を許す
- それでも外部への書き込みを承認なしにさせないため、2 つを重ねる
  - Claude Code の許可で、外部に書き込めるもの・履歴を変えるものを禁止する（`git push`・`git commit`・`git reset`・`git checkout`・`git switch`・`git rebase`・`git remote`・`git config`・`gh`）
  - Claude Code に渡す環境から認証情報を外す。git の全体とシステムの設定（gh の認証を使う credential.helper を含む）を読ませず、gh の設定は空のフォルダを指させ、`GH_TOKEN`・`GITHUB_TOKEN`・SSH エージェントを外す。禁止をすり抜けても、認証がないので書き込めない
- commit と push は、これまでどおりアプリが行う。差分を見せ、承認された commit だけを、直し始めたときの head から動いていないことを確かめて push する（force はしない）
- git のデータは作業ディレクトリの外に分け、アプリの git は危ない設定を打ち消して動かす（コンフリクトの直しと同じ）

## Alternatives Considered

- **コマンドを渡さず、lockfile の更新だけアプリが決め打ちで実行する**: 確認のコマンドが実行できず、CI で初めて失敗に気づく。修正の質が下がる
- **禁止の指定だけで守る**: 禁止の書き方の漏れで書き込めてしまうおそれがある。認証情報を外すことと重ねる

## Consequences

### Positive

- 依存の更新や設定の書き換えなど、コマンドが要る修正も任せられる
- 修正のあとに、確認のコマンドの結果を見てから push を承認できる

### Negative

- Claude Code は作業ディレクトリの外のファイルを読み書きしたり、ネットワークに出たりできる。パッケージのインストールスクリプトも動く。私用のリポジトリで、Claude Code の防御を前提に受け入れる
- renovate のブランチに push すると、renovate はそのブランチを自動で作り直さなくなる

## References

- [ADR-0010](0010-slack-session-and-saved-api.md)（Slack と同じく、外部への書き込みは承認を経る）
