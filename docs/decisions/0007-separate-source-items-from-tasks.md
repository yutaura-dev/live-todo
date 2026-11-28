# ADR-0007: Source Item と Task を別の概念として分ける

- **Status**: Accepted
- **Date**: 2026-11-25
- **Deciders**: YutaUra

## Context

初期の実装では、Source から取ってきた 1 件をそのまま 1 つの Task にしていた。しかし実際には、1 つの Task に複数の Source から情報が集まる（Slack のスレッドで頼まれたレビューと、その GitHub の PR）。

また、更新マークは「Task に更新があったとき」に付けるものであり、「Source で何かが起きたとき」ではない。Source の変化をそのまま Task の更新として扱うと、雑談のコメントでも更新マークが付いてしまう。

## Decision

次の 4 つの概念に分ける。

| 概念 | 何か |
|------|------|
| **Source Item** | Source から取ってきた 1 件（PR、スレッド、メール、予定）。外の世界の写し |
| **Activity** | Source Item に起きた出来事（appeared / changed / resolved / reopened / removed） |
| **Link** | Task と Source Item のつながり（その Item が Task の事実になる）。つながりに役割の区別は持たない |
| **Task** | 自分がやること。Source の言葉ではなく、自分にとっての意味（何をするか、今の状況と次の一手）で書く |

- **1 つの Source Item が属せる Task は 1 つまで**。同じ Item が 2 つの Task にまたがると、Item の完了でどちらを done にするかがあいまいになるため（のちに見直した。今は複数の Task の事実になれ、AI が振り分けるのは 1 つ目だけ。2 つ目以降は識別子で決まるときかユーザーが足したときだけ。Item の変化は持っているすべての Task に届く。specs/routing.spec.ts）
- **更新マークは Task Change にだけ付ける**。Activity はそのままでは更新マークにならず、「その出来事が Task にとって何を意味するか」を解釈して Task の項目が実際に変わったときだけ Task Change を記録する
- Task が終わるかは、つながった Item の状態から直接は導かず、計画の完了条件（Action Item）で決める（specs/task.spec.ts）。つながりに「完了を決める（tracks）」「関連情報（context）」の役割を持たせる案は、どの事実で終わるかを Task の計画が決めるようになったので外した
- Source Item は Task を作らなかったもの（対象外）も保存する。判定のやり直しや、あとからの紐づけに使う

段階的に作る。

1. モデルの分離。紐づけは「同じ Item なら同じ Task」のみ、Task の自動更新は status のみ
2. Activity を受けて AI が Task の brief（今の状況と次の一手）を書き直す
3. Source をまたいで、新しい Item を既存の Task に紐づける判定を入れる

## Alternatives Considered

- **Source Item = Task のまま、Task に複数の URL を持たせる**: Source ごとの状態（PR はマージ済み、スレッドは未解決）を持てず、完了の判定ができない
- **1 つの Source Item を複数の Task に属せるようにする**: Item の完了でどの Task を done にするかがあいまいになる（のちに、完了を計画の完了条件で決めるようにしたので、複数の Task が持てるように見直した）
- **Source の変化（fingerprint）で更新マークを付ける**: 画面に出ない値の変化で更新マークが付き、Task の項目が変わっていないのに目印だけが出る

## Consequences

### Positive

- 複数の Source にまたがる仕事を 1 つの Task として扱える
- 更新マークが「自分のやることが変わったか」という意味に揃う
- 対象外にした Item も残るので、判定の見直しができる

### Negative

- テーブルと処理の段が増える
- Task の title と Source Item の title が別になるため、Item 側のタイトル変更は Task に自動で反映されない（Phase 2 の brief で状況として伝える）

### Neutral

- 既存の `syncSource` と `TaskRepository` は作り直した。本番データがないため、マイグレーションは初期の 1 本として生成し直した

## References

- [ADR-0003: 同期と判定のパイプライン](0003-sync-and-judge-pipeline.md)
- [ADR-0006: DB アクセスに Drizzle ORM（Effect 版）を使う](0006-drizzle-on-effect-sql.md)
