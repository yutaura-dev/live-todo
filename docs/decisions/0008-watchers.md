# ADR-0008: 見張り（Watcher）を Source 共通の仕組みにする（charter 改訂）

- **Status**: Accepted
- **Date**: 2026-11-25
- **Deciders**: YutaUra

## Context

通知を起点にした取得では拾えない「困った状態」がある。

- GitHub は、PR が conflict しても通知を出さない（`mergeable` の変化を知らせる通知もイベントもない）
- 「自分が送ったメールに返信がない」「自分の質問に N 時間返信がない」のように、**何も起きないこと**自体が todo になる場合がある

こうした見張りは GitHub に限らず、Slack・メール・カレンダー・Notion などでも必要になる。charter の In Scope にも明示されていないため、あわせて改訂する。

## Decision

- 見張りを **Watcher**（Source 共通）× **WatchProvider**（Source ごと）× **Condition**（条件）に分ける
  - **WatchProvider**: 自分が関わる、今開いているもの（見張る対象）を一覧で取る
  - **Condition**: 対象 1 件と今の時刻から `holds` / `clear` / `unknown` を返す。Source をまたいで使える条件（返信待ちなど）は core に、Source 固有の条件（PR の conflict など）は Source 側に置く
  - **Watcher**: 対象を取り、条件を評価し、前回の結果と比べて Sync に渡す
- 条件が成り立っている間は **Condition Item**（Source Item の一種）が open、解消したら resolved。見張る対象が一覧から消えたら removed。あとは既存の Sync に流れ、Task ができ、解消したら done になる（[ADR-0007](0007-separate-source-items-from-tasks.md)）
- `unknown`（GitHub が `mergeable` を計算中など）は、**前回の判定を引き継ぐ**。前回の記録がなければ成り立っていない扱いにする
- 前回の結果（成り立っている条件の一覧）は Sync のカーソルに保存し、Task の反映と同じトランザクションで書く
- 時間の条件（「48 時間返信がない」）は、同期のたびに今の時刻で評価し直す。時刻は Effect の `Clock` から取る
- 条件の期間（N 時間・N 日）は、最初は固定の値で始め、あとから設定できるようにする
- 最初に作る条件は GitHub の **conflict / CI の失敗 / changes requested**

## Alternatives Considered

- **Source ごとに Watcher を作る（GitHubWatcher など）**: 「わからないときは前回を引き継ぐ」「前回と比べて差分にする」といった共通の扱いが Source ごとに重複し、ずれる。返信待ちのような Source をまたぐ条件も使い回せない
- **通知を待つ方式で拾う**: conflict や返信がないことのように、Source が通知を出さないものは原理的に拾えない
- **`unknown` を「成り立っていない」として扱う**: 計算待ちや一時的な取得失敗のたびに Task が開閉してしまう
- **`SnapshotDiffer` で差分を取る**: `unknown` のときに前回を引き継ぐ扱いが入らないため使わない

## Consequences

### Positive

- 通知が来ない困った状態や、何も起きないことを Task にできる
- 条件を Source をまたいで使い回せる
- 将来、カスタムラベルと同じようにユーザーが条件を書けるように広げられる

### Negative

- 見張る対象を同期のたびに取り直すため、API の呼び出しが増える
- 状態が取れない条件（CI の通知など）は、Watcher でも `unknown` のままになる

### Neutral

- [charter.md](../charter.md) の In Scope に見張りを追加した

## References

- [ADR-0007: Source Item と Task を別の概念として分ける](0007-separate-source-items-from-tasks.md)
