# ADR-0013: Claude Code には読むことを広く許し、書き込みだけを止める

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: YutaUra

## Context

Task への質問（「ぴあ会員は何の目的で登録したか」など）に答えるには、Task の元の項目だけでは足りないことが多い。
過去のメール・予定・ドライブのファイル・GitHub の PR や CI の結果・Web のページを読めないと、Claude Code は
「分かりませんでした」と答え、調べ方をユーザーに頼むことになる。

これまでは、他人が書いた内容（メール・PR）に仕込まれた指示で情報を外に出されるのを恐れ、Claude Code に渡す道具を
絞っていた（WebFetch を渡さない、Gmail は Gmail の Task だけ、など）。ユーザーからは、読む権限はなるべく広く与えて
便利にし、書き込みなどダメなことだけを止めてほしいと求められた。

## Decision

- Claude Code には、読むことを広く許す。質問に答えるときは次を渡す
  - ファイルを読む・探す（Read・Grep・Glob）、Web を検索する・ページを開く（WebSearch・WebFetch）
  - Google（gws）: Gmail・カレンダー・ドライブ・ドキュメント・スプレッドシート・連絡先を読むだけのコマンド（Gmail のアカウントで Claude Code で考えるのを有効にしているとき）
  - GitHub（gh）: PR・issue・CI・リポジトリ・リリースを見る・検索するだけのコマンドと、clone したリポジトリの履歴を読む git のコマンド（GitHub のアカウントで有効にしているとき）
- 書き込みは止める。止め方は重ねる
  - 許可するコマンドを、読むだけのサブコマンドに限る（`gws gmail users messages list` などを名指しする）。送信・ゴミ箱・ラベルの変更・予定の作成・コメント・merge・`gh api`（書き込みにも使える）・`git push` は許可しない。許可しないものは確認を出さずに拒否される
  - 編集の道具（Edit・Write）を渡さない
  - コマンドは sandbox の中で動かす。書き込めるのは作業場所だけ、通信は使う API（Google・GitHub）だけ。アプリの秘密情報・DB・設定・ほかの Task の作業場所、`~/.ssh` などは読ませない
  - gh は証明書の確認に macOS の仕組み（trustd）を使うので、GitHub を読ませるときは `enableWeakerNetworkIsolation` を付ける
- 外部への書き込みは、これまでどおりユーザーの承認を経てアプリが行う（charter）
- 2026-11-26 に、アプリと同じ引数で、gws で Gmail を読めること・`gws gmail users messages trash` と `gh pr comment` が拒否されること・gh で GitHub を読めることを確かめた

## Alternatives Considered

- **質問に関係するものだけを渡す（Gmail は Gmail の Task だけ、WebFetch は渡さない）**: 安全側だが、答えに必要な情報に届かず役に立たない回答になる（#368）
- **アプリが検索して結果を渡す（2 段階）**: 道具を渡さずに済むが、何を調べるかを一度で決めきれず、調べながら深掘りできない

## Consequences

### Positive

- 質問に、メール・予定・GitHub・Web をまたいで調べた答えが返る
- 読むか書くかで線を引くので、新しい道具を足すときの判断がしやすい

### Negative

- 他人が書いた内容に仕込まれた指示で、読んだ情報を Web の検索語や開く URL に載せて外に出される余地が残る（書き込みは止まる）。会社のアカウントのデータは、そのアカウントで Claude Code を有効にしたときだけ渡る（charter の前提と制約）
- 許可するコマンドを名指しで並べるので、gws・gh に読むだけの新しいサブコマンドが増えても、足すまで使えない

## References

- [ADR-0012](0012-claude-code-commands-for-fixes.md)（PR の修正で Claude Code にコマンドを許す）
