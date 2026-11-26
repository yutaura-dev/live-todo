# ADR-0015: Notion はブラウザのセッションで取得し、受信トレイ（Inbox）を Source にする

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: YutaUra

## Context

Notion で自分の todo になるのは、主に次の 3 つである。

- 受信トレイ（Inbox）に届く通知: ページやコメントでの自分へのメンション、自分がいるコメントスレッドへの返信、リマインダー
- コメントでのメンション（受信トレイにも届く）
- 指定したページの変化: 他人の編集と、未解決のコメント

公開 API（Internal Integration）には、受信トレイを読む口も、自分へのメンションを探す口もない。読めるのはインテグレーションに共有したページと DB だけである。
Web クライアントが使う非公開 API（`/api/v3/*`）は、ブラウザのセッション（Cookie の `token_v2`）で動き、受信トレイも読める。
形は OSS の実装（react-notion-x の notion-client、notion-py、Nishan の型定義など）から読み取った。実際の応答ではまだ確かめていない。

## Decision

- Notion の Account は、Cookie の `token_v2`・ユーザー ID（Cookie の `notion_user_id`）・そのセッションを取ったブラウザの User-Agent・API の接続先で接続する
  - セッションは、Slack と同じく（[ADR-0010](0010-slack-session-and-saved-api.md)）、アプリが開くログイン画面でログインしてもらい、済んだら Cookie を読み取る。保存先を持たないセッションで開き、Node の機能も preload も渡さない。読み取ったら消す
  - `token_v2` は秘密情報として暗号化して保存する。ユーザー ID・User-Agent・接続先は設定に置く
  - 接続先は Cookie のドメインで決める（`notion.so` なら `https://www.notion.so`、`notion.com` なら `https://app.notion.com`）。移行中で、どちらが使われるかがアカウントによって違うため
- リクエストは JSON の POST で、1 本ずつ間隔を空けて送る。429 は 60 秒休む（`Retry-After` はほぼ返らないと notion-client に書かれている）。401・403 はセッション切れとして、設定画面で取り直してもらう
- レコードは `{ value: {...}, role }`（旧）と `{ value: { value: {...}, role } }`（新）の両方の入れ子を受ける
- 受信トレイは `getNotificationLogV2`（`type: "unread_and_read"`、`variant: "no_grouping"`）で、自分が入っているワークスペース（space）ごとに直近 50 件を取り、別の Source（`notion:<id>:inbox`）にする
  - Source Item のキーは通知の ID。扱うのは activity の種類が `user-mentioned`（メンション）・`commented`（コメント）・`reminder`（リマインダー）のものだけ。ページの編集・共有・招待などは、ここでは取らない
  - コメントのスレッドが解決されたら、または自分があとから同じスレッドに書いたら、済んだことにする。通知が無効（`invalid`、元のコメントが消えたなど）になったら済んだことにする
  - Notion の既読は「開いた」だけで、対応したことにはならないので、済んだことにしない
  - リマインダーは自分で付けたものなので、判定は規則で todo にする。メンションとコメントは、このアカウントの LLM Profile で判定する（ADR-0003。fail closed）
  - 最初の取り込みでは直近 3 日分だけを Task にする対象にし、それより前は見たことだけ覚える（Slack の受信と同じ）
- 書き込み（既読にする、コメントに返信するなど）は、まだ作らない。作るときは Approval を経てからだけ行う
- 指定したページの見張り（他人の編集・未解決のコメント）は、受信トレイの応答の形を実際に確かめてから、別の段階で足す

## Alternatives Considered

- **公式 API（Internal Integration）を使う**: 受信トレイと自分へのメンションが読めない。読ませたいページを 1 つずつインテグレーションに共有する手間もある
- **公式の Public Integration（OAuth）**: 読める範囲は Internal Integration と同じで、受信トレイは読めない
- **ユーザーに `token_v2` を開発者ツールから写してもらう**: HttpOnly の Cookie なので写しにくく、User-Agent の写し間違いも起きる（手で入れる道は残す）
- **通知のメールを Gmail から拾う**: 遅れて届き、まとめられることがあり、スレッドの解決も分からない

## Consequences

### Positive

- 受信トレイに届いたメンション・コメント・リマインダーが Task になり、コメントのスレッドを解決すれば Task も片付く

### Negative

- 非公開 API なので、予告なく仕様が変わる。壊れたら同期が失敗し、設定画面に理由を出す
- Notion の利用規約は自動化したアクセスを制限している。私用のワークスペースで、自分のデータを読むだけに使う。会社のワークスペースでは管理者に確かめてから使う
- ブラウザでログアウトするとセッションが無効になる。取り直してもらう必要がある

### Neutral

- 想定外の形の通知は取り込まずに、数だけログに残す
- 2026-11-26 に、1 つのワークスペースの実際の応答で、キーと型だけを見て次を確かめた（本文は見ていない）
  - `app.notion.com` のドメインでログインしたアカウントは、`https://app.notion.com/api/v3/getNotificationLogV2` で受信トレイが取れる。レコードは新しい入れ子で返る
  - 直近 31 件の内訳: `user-invited`（ページへの招待）25 件、`user-mentioned` 5 件、`team-membership-edited` 1 件。通知のレコードにも activity と同じ `type` が入る
  - メンションは本文ではなく、表の行のセルや DB のプロパティに入ることが多い。activity の `mentioned_property` がそのプロパティのキーを指す。ページのタイトル以外のプロパティなら、ページはタイトルを、表の行は行のセルをつないだものを本文にする
  - 招待はページを共有されただけ（会議のメモなど）のものが多いので、取り込まない
  - コメントの通知（`commented`）と、`comment`・`discussion` の表は、この応答にはなかった。コメントの扱いはまだ確かめていない

## References

- [ADR-0003](0003-sync-and-judge-pipeline.md)、[ADR-0007](0007-separate-source-items-from-tasks.md)、[ADR-0010](0010-slack-session-and-saved-api.md)
- https://github.com/NotionX/react-notion-x/tree/master/packages/notion-client
- https://github.com/Devorein/Nishan/blob/master/packages/types/libs/notifications.ts
