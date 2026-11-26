# ADR-0016: Google Calendar の予定から、出欠・準備・自分の todo の 3 つの Source を作る

- **Status**: Accepted
- **Date**: 2026-11-26
- **Deciders**: YutaUra

## Context

予定そのものは todo ではないが、予定から生まれる todo がある。

- 出欠を返していない招待
- 資料の用意や下調べなど、事前の準備が要る予定
- 自分で入れた、やることを書いた予定（終日の予定や、説明に TODO と書いたもの）

招待はメールでも届き、Gmail の側では人からのメールのスレッドとして Claude Code に読ませている。そのままだと、同じ招待から二重に Task ができる。

## Decision

- 認証は Gmail と同じく gws に任せる。gws の認証は 1 つなので、Calendar は別のアカウントにせず、Gmail のアカウントの `calendar` で見るかを決める（既定は見ない）。Source 名の `<id>` は Gmail のアカウントの id で、判定の LLM Profile も Gmail と同じものを使う
- 書き込めるカレンダー（`minAccessRole: writer`。owner と writer）だけを見る。祝日や他人のカレンダーは、自分の todo にならない
- 5 分おきに、前日から 31 日先までの予定を、繰り返しを展開し、取り消された予定も含めて取る（`singleEvents`・`showDeleted`）。1 回の同期で 1 度だけ取り、次の 3 つの Source に続けて反映する
  - `calendar:<id>:invites`: 自分の出欠が未回答（`needsAction`）で、自分が主催でなく、まだ終わっていない予定。出欠を返したか、終わったら済み。規則で todo にする
  - `calendar:<id>:prep`: 3 日以内に始まる、時刻のある予定のうち、自分が出る（主催か、出席・仮）で、自分のほかに参加者がいるもの。準備が要るかは、このアカウントの LLM Profile で判定する（予定の名前と説明を送る）。終わったら済み
  - `calendar:<id>:todos`: 自分で入れた、ほかの参加者のいない予定のうち、説明に TODO の印（`TODO`・`やること`・`[ ]`・`☐`）があるものと、終日のもの。前日から Task にする。印があれば規則で todo、終日の予定だけなら休みや記念日でないかを LLM で判定する。日が過ぎても済んだことにしない（自分でやるまで残す）
- 当てはまらなくなった項目は済んだことにする。一覧から消えた項目は、まだ先の予定なら消されたとして removed にし、過ぎて範囲から出ただけなら前の状態のまま覚えておく。終わって 30 日たった予定は覚えるのをやめる
- 終日の予定の日付は、カレンダーのタイムゾーンのその日の 0 時として扱う
- Calendar も見る Gmail のアカウントでは、日程がまだ先の招待メールを対応待ちに数えない（出欠は Calendar の Task にする）。日程が過ぎた招待メールの片付けは、これまでどおり Gmail の側で行う
- 出欠を返すなどの書き込みは、まだ作らない。作るときは Approval を経てからだけ行う

## Alternatives Considered

- **Source を 1 つにして、予定ごとに 1 つの項目にする**: 出欠を返したあとに準備が要る、のように同じ予定から別の todo が順に生まれる。種類が変わるたびに Task の意味が変わってしまう
- **SnapshotDiffer で差分を取る**: 範囲から出ただけの予定まで removed になり、片付けた Task が archived に変わる
- **Gmail の招待メールだけで出欠を扱う**: 自分が返事をしたかがメールからは分からない。カレンダーの画面で返事をしても Task が残る
- **Calendar を別のアカウント（`calendarAccounts`）にする**: どの Google アカウントを読むかは gws の認証で決まり、設定では選べない。別のアカウントにしても、id と LLM Profile を持つだけで、同じ予定を二重に取り込む余地ができる。Gmail と LLM Profile がずれると、同じ Google アカウントのデータを別の LLM に送ることにもなる
- **読むだけのカレンダーも見る**: 祝日や同僚の予定まで取り込み、自分の todo にならないものが増える

## Consequences

### Positive

- 出欠の返し忘れと、準備の忘れを防げる
- 招待の Task が Gmail と Calendar で二重にならない

### Negative

- 準備が要るかの判定で、予定の名前と説明を LLM に送る
- gws を同期ごとにカレンダーの数だけ動かす

### Neutral

- 自分の todo の印は固定で始め、あとから設定できるようにする

## References

- [ADR-0003](0003-sync-and-judge-pipeline.md)、[ADR-0007](0007-separate-source-items-from-tasks.md)
