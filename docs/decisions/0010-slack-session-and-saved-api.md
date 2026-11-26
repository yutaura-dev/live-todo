# ADR-0010: Slack はブラウザのセッションで取得し、To-do・Saved は非公開の saved.* API を使う

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: YutaUra

## Context

Slack は todo の入口として大きい。特に、自分で「To-do」「Saved（旧 後で）」にしたメッセージは、それ自体が自分の todo である。
しかし To-do・Saved を読み書きする公開 API はない（`stars.*` は Later の内容を反映しないと公式に明記されている）。
Web クライアントが使う内部 API `saved.*`（`saved.list` / `add` / `update` / `delete` / `clearCompleted`）は、
ブラウザのセッション（`xoxc-` のトークンと `d` の Cookie）でだけ動く。仕様は作者がまとめた「Slack saved.* 非公開 API 仕様書」による。

## Decision

- Slack の Account は、ワークスペースのドメイン・`xoxc-` のトークン・`d` の Cookie・そのセッションを取ったブラウザの User-Agent で接続する
  - トークンと Cookie は秘密情報として暗号化して保存する（GitHub のトークンと同じ扱い）。User-Agent は設定に置く
  - User-Agent はユーザーに入れてもらい、アプリで作らない。違う User-Agent で送ると、盗まれたセッションと判定されて全端末がログアウトされた事例があるため
- To-do・Saved は `saved.list` で全件を取り（未完了と完了済みの 2 つのビュー）、SnapshotDiffer で前回との差分にする
  - Source Item のキーは `<item_id>:<ts>`。`completed` は解消、一覧から消えたら removed
  - 自分で To-do・Saved にしたものなので、判定は規則で todo にする（LLM に送らない）
  - メッセージの本文は `conversations.history` / `conversations.replies` で、初めて見たときだけ取る
- リクエストは 1 本ずつ間隔を空けて送る（公式の Tier 2 相当、毎分 20 回程度に収める）。`ratelimited` / 429 は `Retry-After` まで休む
- 書き込み（`saved.update` で完了にするなど）は、GitHub と同じく承認（Approval）を経てからだけ行う。読み取りを先に作り、書き込みはそのあとに足す
- メンション・DM・スレッドの返信など、To-do・Saved 以外の Slack の todo は、同じセッションで別の Source として足す（あとで決める）

## Alternatives Considered

- **公式の Slack アプリ（`xoxp-` のユーザートークン）を作る**: To-do・Saved を読めない。`reminders.add` で行を作れる可能性はあるが、一覧も状態の変化も取れない
- **`stars.list`**: Later（To-do・Saved）の内容を反映しないと公式に明記されている
- **User-Agent をアプリで固定する**: ブラウザと違うと全端末のログアウトを招くおそれがある

## Consequences

### Positive

- 自分で「後で」にしたメッセージが、そのまま Task になる
- Slack 側で完了・削除すれば、Task も自動で片付く

### Negative

- 非公開 API なので、予告なく仕様が変わる。壊れたら同期が失敗し、設定画面に理由を出す
- セッショントークンの利用は、利用規約やワークスペースのポリシーに触れる可能性がある。会社のワークスペースでは管理者に確認してから使う
- ブラウザでログアウトするとセッションが無効になる（`invalid_auth`）。取り直してもらう必要がある

### Neutral

- `filter` の有効な値など、未確定の点がある。全件は「filter なし」と「completed」の 2 つのビューで取り、`counts.total_count` と照らす

## References

- Slack saved.* 非公開 API 仕様書（作者のドキュメント）
- [ADR-0007](0007-separate-source-items-from-tasks.md)、[ADR-0008](0008-watchers.md)
