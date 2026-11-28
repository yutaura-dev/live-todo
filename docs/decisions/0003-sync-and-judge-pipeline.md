# ADR-0003: 同期と判定のパイプライン

- **Status**: Accepted
- **Date**: 2026-11-25
- **Deciders**: YutaUra

## Context

live-todo は 8 つの Source から Task を作り、状況の変化に追従させる。Source ごとに API の性質が違い、差分を返せるもの（Gmail の `historyId`、Drive の `changes` トークンなど）と、全件取得しかできないものがある。

また、Source Item が「自分の todo か」「どのラベル・優先度か」を判定する必要がある。判定の結果で自動処理と人間の確認を分けたいので、閾値をかけられる確率が欲しい。一方、charter の制約により、会社 PC では会社が許可した LLM しか使えず、確率付きの判定 API が使えない環境もある。

## Decision

### 同期

- Source Adapter のインターフェースは「カーソル以降の変更（`SourceChange`: upserted / removed）を返す」の 1 つにそろえる
- 差分 API がある Source はそれを使う（ネイティブ差分）。ない Source は全件を取得し、共通の `SnapshotDiffer` が前回の fingerprint（内容のハッシュ）と比べて `SourceChange` に変換する（スナップショット差分）
- 状態や内容の変化は、確認なしで自動で Task に反映する。反映のたびに変更履歴（`TaskChange`）を積み、未読の変更がある Task に **更新マーク** を表示する。Task を開いたらマークは消える

### 判定

1. **規則**: GitHub のレビュー依頼や自分宛ての assign など、規則で確定できるものは LLM を呼ばない
2. **Decisions provider**: 確率付きの判定 API（Jev / OpenAI Decisions / Gemini Decisions）が使える LLM Profile では、todo 判定（predicate）・ラベル（choice）・優先度（score）・カスタムラベル（predicate）を `questions` で 1 リクエストにまとめる。確率に閾値をかけて「todo / 要確認 / 対象外」に振り分ける
3. **fallback**: どれも使えない LLM Profile では、chat LLM の structured output で判定する。自己申告の確信度は使わず、選択肢に `uncertain` を用意して要確認に回す

- refusal や想定外の応答は **要確認** に倒す（fail closed）。否定判定として扱わない
- Decisions provider が使えるかどうかは、LLM Profile の capability として表す。判定方式を個別に設定させない
- 要確認はカンバンの専用レーンに置き、ユーザーが仕分けた結果を閾値の見直しの材料として残す

## Alternatives Considered

- **全 Source をスナップショット差分にする**: 実装は単純になるが、メールのように件数が多い Source で毎回全件を取るのは API 制限とコストに見合わない
- **chat LLM に確信度を自己申告させて閾値をかける**: 返る数字は生成されたトークンで、確率として校正されていない。閾値運用の土台にならない
- **すべて LLM で判定する**: レビュー依頼のように確実に todo であるものまで確率のぶれにさらし、取りこぼしを生む。コストも増える
- **状態変化をユーザーの承認後に反映する**: 自動で集める価値が薄れる。変化は自動で反映し、更新マークで気づけるようにする

## Consequences

### Positive

- Sync 層は Source ごとの差分の取り方を意識しなくてよい
- 確率がある環境では、閾値で自動処理と人間の確認を分けられる
- 会社 PC でも fallback で動き、会社データが許可外の LLM に送られない

### Negative

- 判定の経路が 2 系統（Decisions / fallback）になり、テストもそれぞれ必要になる
- 閾値の初期値は経験則なので、運用しながら調整が要る

### Neutral

- 閾値の具体的な値は [architecture.md](../architecture.md) で管理し、ADR には書かない

## References

- [ADR-0004: Epic とカスタムラベル](0004-epic-and-custom-labels.md)
- Jev（TypeSafe）、OpenAI Decisions API（`gpt-6-luna`）、Gemini Decisions API（`gemini-decision-1`）。API の詳細は実装時に公式ドキュメントで確認する

## のちの見直し（2026-11-28）

振る舞いの正本は specs/ にある（ADR-0015）。次の点は、のちの ADR と spec で置き換えた。

- LLM Profile と「Decisions がなければ structured output で判定する」は、AI Settings（PC に 1 つ、使い道ごとに Decisions・Generation・Agent）に置き換えた。Decisions が迷ったら要確認にし、別の AI に上げない（ADR-0022）
- 届いた事実の振り分けは Routing（specs/routing.spec.ts）。迷った事実は、どの Task にも入れず「ユーザー待ち」にする
- Task の変化は Task Activity（ADR-0021）
