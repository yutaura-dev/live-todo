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
- Bash は Claude Code の sandbox（macOS の仕組みで OS が閉じ込める）の中で動かす。`--settings` で次を指定する
  - 書き込みは作業ディレクトリとパッケージのキャッシュの場所だけ（一時フォルダは sandbox の既定で書ける）。git のデータ・アプリの取り直した git のデータ・`~/.gitconfig` などには書けない
  - 読ませない: `~/.ssh`・gh の設定・`~/.aws`・`~/.npmrc` などの認証情報、アプリの秘密情報・DB・設定・ソース
  - 通信は npm・yarn のレジストリだけ（`strictAllowlist`）
  - sandbox を起動できなければ止める（`failIfUnavailable`）。sandbox の外での再実行を許さない（`allowUnsandboxedCommands: false`）
  - 2026-11-26 に、`--restricted` と組み合わせて、ホームの下での作業ディレクトリの外への書き込み・`~/.ssh` の読み取り・許可していない通信が止まることを確かめた
- commit と push は、これまでどおりアプリが行う。AI が直し終わったら、AI が触れていない git のデータを取り直し、AI の作業ツリーのファイルをそのデータで commit・push する（AI が書き換えた git の設定を使わない）。アプリの git には PATH と HOME だけを渡す。差分を見せ、承認された commit だけを、直し始めたときの head から動いていないことを確かめて push する（force はしない）
- git のデータは作業ディレクトリの外に分け、アプリの git は危ない設定を打ち消して動かす（コンフリクトの直しと同じ）

## Alternatives Considered

- **コマンドを渡さず、lockfile の更新だけアプリが決め打ちで実行する**: 確認のコマンドが実行できず、CI で初めて失敗に気づく。修正の質が下がる
- **禁止の指定だけで守る**: 禁止の書き方の漏れで書き込めてしまうおそれがある。認証情報を外すことと重ねる

## Consequences

### Positive

- 依存の更新や設定の書き換えなど、コマンドが要る修正も任せられる
- 修正のあとに、確認のコマンドの結果を見てから push を承認できる

### Negative

- sandbox の中でも、作業ディレクトリの中ではパッケージのインストールスクリプトが動く。一時フォルダには書ける。読ませない場所に挙げていないファイルは読める
- renovate のブランチに push すると、renovate はそのブランチを自動で作り直さなくなる

## References

- [ADR-0010](0010-slack-session-and-saved-api.md)（Slack と同じく、外部への書き込みは承認を経る）

## のちの見直し（2026-11-28）

specs/agent-run.spec.ts で、直す道具（Edit・Write・Bash）を渡すのは、PR を直す・コンフリクトを直す・直す Action Item をやるときに広げた。認証情報を渡さないこと、push は承認を経た書き込み（Write）でだけ行うことは変わらない。
