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
  - セッションは、アプリが開く Slack のログイン画面でユーザーにログインしてもらい、ログインが済んだら読み取る（トークンはページの `localConfig_v2`、Cookie はウィンドウのセッション）。このアプリ専用のログインになり、ふだんのブラウザのログインには影響しない
  - ログイン画面は、アプリ本体とは別の保存先を持たないセッションで開き、Node の機能も preload も渡さない。読み取ったら消す
  - User-Agent は、ログイン画面に設定した値（Electron の User-Agent から Electron とアプリの名前を除き、Chrome と同じ形にしたもの）をそのまま同期にも使う。違う User-Agent で送ると、盗まれたセッションと判定されて全端末がログアウトされた事例があるため
  - トークンと Cookie は秘密情報として暗号化して保存する（GitHub のトークンと同じ扱い）。User-Agent は設定に置く。手で入れることもできる
- To-do・Saved は `saved.list` で全件を取り（未完了と完了済みの 2 つのビュー）、SnapshotDiffer で前回との差分にする
  - Source Item のキーは `<item_id>:<ts>`。`completed` は解消、一覧から消えたら removed
  - 自分で To-do・Saved にしたものなので、判定は規則で todo にする（LLM に送らない）
  - メッセージの本文は `conversations.history` / `conversations.replies` で、初めて見たときだけ取る
- リクエストは 1 本ずつ間隔を空けて送る（公式の Tier 2 相当、毎分 20 回程度に収める）。`ratelimited` / 429 は `Retry-After` まで休む
- 書き込み（`saved.update` で完了にするなど）は、GitHub と同じく承認（Approval）を経てからだけ行う。読み取りを先に作り、書き込みはそのあとに足す
- メンション・DM・スレッドの返信は、同じセッションで公開の検索 API（`search.messages`）を使い、別の Source（`slack:<id>:inbox`）にする
  - 自分へのメンション（`<@自分>`）、自分が入っているユーザーグループへのメンション（`<!subteam^ID>`）、自分宛ての DM（`to:me`）、自分が書いたスレッドへのそのあとの返信（`from:me` と `is:thread` から求める）。`@channel`・`@here` は取らない
  - 2026-11-26 に、私用のワークスペースで `<@自分>`・`to:me`・`is:thread`・`from:me` が期待どおりに当たることを、件数と項目だけで確かめた。ユーザーグループへのメンションは、そのワークスペースにグループがなく確かめていない
  - ユーザーグループは増えたり減ったりするので、取り込みのたびに取り直す（覚えておかない）
  - 自分があとから同じスレッド（DM なら同じ DM）で書いたら、または To-do・Saved にしたら（To-do の Task に任せる）、済んだことにする
  - メッセージ 1 件では何をする Task か決まらないので、それだけでは Task にしない（仕分けを保留にして取り込む）。Source Item と Task を分ける ADR-0007 に従う
  - 保留のメッセージを会話（スレッド、スレッドの外の DM はその DM）ごとにまとめ、前後のメッセージを Claude Code に読ませて、やることはない・何をするかの Task を作る・既にある Task の続き、のどれかを決めさせる。メッセージ本文を Claude に送るので、「次にやることを Claude Code で考える」を有効にしたワークスペースだけで動かす
  - 探すのは直近 14 日。最初の取り込みでは直近 3 日分だけを考える対象にし、それより前は見たことだけ覚える

## Alternatives Considered

- **公式の Slack アプリ（`xoxp-` のユーザートークン）を作る**: To-do・Saved を読めない。`reminders.add` で行を作れる可能性はあるが、一覧も状態の変化も取れない
- **`stars.list`**: Later（To-do・Saved）の内容を反映しないと公式に明記されている
- **ユーザーにトークン・Cookie・User-Agent を開発者ツールから写してもらう**: 手間が大きく、User-Agent の写し間違いで全端末のログアウトを招くおそれがある（手で入れる道は残す）
- **ふだんのブラウザの Cookie を読む**: ブラウザの保存先を読むのは、ほかのサイトの Cookie にも触れることになり、権限も広い

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
