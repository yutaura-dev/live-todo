# ADR-0009: 見張る頻度を、対象の状態の変化に合わせて下げる

- **Status**: Accepted
- **Date**: 2026-11-25
- **Deciders**: YutaUra

## Context

本物の GitHub で試したところ、放置している自分の open な PR が `quipper/tararepo` だけで 50 件ほどあり、見張りの Task の大半を占めた。仕事でも使うリポジトリなので、リポジトリごとの除外では対応できない。また、すべての PR を 5 分ごとに 3 回（詳細・check・レビュー）ずつ確認すると、API の呼び出しが多く、同期にも時間がかかる。

## Decision

- [ADR-0008](0008-watchers.md) の Watcher に、**対象ごとの確認の予定**を持たせる（カーソルに保存する）
  - 初めて見た対象・状態が変わった対象は、最初の間隔（GitHub では 5 分）で次の確認を予定する
  - 確認しても状態が変わらなければ、間隔を倍にする（5 分 → 10 分 → 20 分 → …）。上限は 1 日
  - 次に確認する時刻より前は、詳細を取りに行かず、成り立っている条件をそのまま引き継ぐ
- WatchProvider を 2 段に分ける
  - `listSubjects`: 見張る対象の一覧（安く取れる情報だけ）。GitHub では検索 API 1 回
  - `loadSubject`: 1 件の詳細（高い）。GitHub では PR・check・レビューで 3 回
- 「状態が変わったか」は、Provider が返す `fingerprint`（判定に効く値だけ）で比べる。GitHub では head のコミット・`mergeable`・check の結果・レビューの状態
- 一覧の `revision`（GitHub では PR の `updated_at`）が変わったら、予定の時刻より前でも確認し、間隔を最初に戻す
- 判定が `unknown` の条件があるうちは、間隔を延ばさない
- 時間の条件は `revisitAt`（成り立つかもしれない時刻）を返せる。次の確認はその時刻より遅らせない

## Alternatives Considered

- **一定期間更新のない PR と draft を見張らない**: 放置している PR が conflict したことに気づけなくなる。間隔を延ばす方式なら、放置している PR でも 1 日に 1 回は確認する
- **revision（`updated_at`）が変わったときだけ確認する**: conflict の多くはベースブランチが進んで起き、PR の `updated_at` は変わらないため気づけない
- **GitHub の Provider の中だけで頻度を制御する**: Slack の返信待ちなど、ほかの Source の見張りでも同じ仕組みが要る

## Consequences

### Positive

- 放置している PR への API の呼び出しが、最終的に 1 日 1 回まで減る
- 動きのある PR は、引き続き 5 分ごとに確認する

### Negative

- 放置している PR が conflict したことに気づくのが、最大で 1 日遅れる
- カーソルが対象ごとの予定を持つので大きくなる（対象 1 件あたり数十バイト）

### Neutral

- 見張りのカーソルの形が変わった。古い形のカーソルは読めないため、初回はカーソルなしで取り直す（Sync の既存の扱い）

## References

- [ADR-0008: 見張り（Watcher）を Source 共通の仕組みにする](0008-watchers.md)
