# ADR-0004: Epic とカスタムラベルを導入する（charter 改訂）

- **Status**: Accepted
- **Date**: 2026-11-25
- **Deciders**: YutaUra

## Context

Task が増えると、個々の Task を並べるだけでは「今どの仕事が進んでいて、どれが詰まっているか」がつかみにくい。大枠の仕事単位で管理したい。

また、既定のラベルだけでは自分の仕事の分け方を表現しきれない。「こういう Task にはこのラベル」というルールを自分で決めたい。

どちらも charter の In Scope にない機能なので、charter を改訂する。

## Decision

### Epic

- Task の上に **Epic** を置く。階層は Epic → Task の 2 段に限り、Task の下に子は作らない
- Epic は **自動で作る**
  1. 新しい Task を既存の Epic に振り分ける（選択肢 = 既存 Epic +「未分類」）
  2. 未分類になった Task について、既存の未分類 Task と同じまとまりの仕事かを判定する
  3. まとまる Task があれば、新しい Task と合わせて Epic を作る。Epic のタイトルと概要は chat LLM の structured output で生成する
- 判定するのは「新しい Task × 未分類 Task」の組み合わせだけにする。既存の Epic の構成は、同期のたびには組み直さない
- ユーザーは Epic の名前変更・統合と、Task の移動を手動でもできる

### カスタムラベル

- ユーザーがラベルとその付与ルールを定義できる。ルールは 2 種類
  - **条件ルール**: Source・アカウント・repo・チャンネル・送信者などの条件。LLM を使わずに評価する
  - **自然文ルール**: 「顧客からの問い合わせや要望」のような説明。Decisions provider の predicate（fallback 時は structured output）で評価する
- 自然文ルールは、[ADR-0003](0003-sync-and-judge-pipeline.md) の判定と同じリクエストにまとめる

### カンバンの見せ方

- 列 = ステータスのボードに、Task カードの Epic バッジを付ける
- サイドバーに Epic の一覧（進捗・更新マーク）を置き、選ぶとその Epic で絞り込む

## Alternatives Considered

- **Epic を手動でだけ作る**: 整理の手間が残り、「覚えておく負担をなくす」という charter の目的に反する
- **未分類 Task 全体を毎回クラスタリングし直す**: Epic の構成が同期のたびに揺れ、コストも未分類の件数の 2 乗で増える
- **Epic の名前付けも Decisions provider で行う**: Decisions 系の API は文章を生成できない
- **任意の深さの階層**: charter の「凝ったサブタスクには力を入れない」に反し、自動での振り分けも難しくなる
- **Epic ごとのスイムレーン表示**: Epic が増えると縦に長くなり、一覧性が落ちる。後から表示切り替えとして足せるので、初版では採らない

## Consequences

### Positive

- 大枠の仕事単位で状況をつかめる
- 自分の仕事の分け方をラベルで表現できる
- カスタムラベルを増やしても、判定のリクエスト数は増えない

### Negative

- 自動で作った Epic が意図と違うことがあり、手動での統合・移動が要る
- Epic の生成に chat LLM の呼び出しが加わる

### Neutral

- [charter.md](../charter.md) の In Scope に Epic とカスタムラベルを追加した

## References

- [ADR-0003: 同期と判定のパイプライン](0003-sync-and-judge-pipeline.md)
