# ADR-0005: 実装の基盤に Effect を採用する

- **Status**: Accepted
- **Date**: 2026-11-25
- **Deciders**: YutaUra

## Context

live-todo の中心は「外部 API を呼ぶ」「失敗の種類によって扱いを変える」「依存（Source のクライアント、LLM provider）を環境ごとに差し替える」処理である。

- refusal は要確認、通信エラーは再試行のように、エラーの種類ごとに扱いを変えたい（[ADR-0003](0003-sync-and-judge-pipeline.md)）。Promise と例外では、どんなエラーが起きうるかが型に現れない
- Decisions provider が使えるかどうかは LLM Profile によって変わる。依存の有無を型と実行時の両方で表したい
- LLM の出力や各 Source の応答など、信用できない外部データを検証する手段を 1 つにそろえたい
- ポーリング、再試行、同時実行数の制限、時刻に依存するテストを、場当たりでなく共通の仕組みで扱いたい

## Decision

- 実装は **Effect**（`effect` 4.x）で書く
  - エラーは `Schema.TaggedError` で定義し、型のエラーチャネルに載せる。`throw` は使わない
  - 依存は `Context.Service` と `Layer` で注入する。任意の依存（Decisions provider など）は `Effect.serviceOption` で扱う
  - 外部データは `Schema` でデコードする。手書きの型ガードで検証しない
  - 時刻は `DateTime` / `Clock` を使い、テストでは `TestClock` で固定する
  - テストは `@effect/vitest` の `it.effect` で書く
- **Effect の生態系にある部品を優先する**。これに伴い [ADR-0002](0002-desktop-app-stack.md) の次の 2 点を置き換える
  - LLM の抽象: Vercel AI SDK → `effect/ai`（`LanguageModel`）と `@effect/ai-*` の各 provider
  - DB: better-sqlite3 + Drizzle ORM → `effect/sql` + `@effect/sql-sqlite-node`
- Effect の API は v3 から大きく変わっているため、**`node_modules/effect` に同梱されたドキュメント（`CLAUDE.md` と `ai-docs/`）と型定義を一次情報にする**。外部の記事は v3 のものが多いので参考にとどめる
- Electron の main プロセスと renderer の境界（IPC）や React など、Effect の外の世界との接続には `ManagedRuntime` を使う

## Alternatives Considered

- **Promise と例外のまま書く**: 書き始めは速い。しかし、起きうるエラーが型に現れず、refusal と通信エラーの区別のような ADR-0003 の方針をコードで守らせにくい
- **neverthrow などの Result 型ライブラリ**: エラーの型付けはできる。ただ、依存の注入、スケジュール、同時実行数の制限、テスト用の時計は別に用意する必要があり、部品がばらける
- **Vercel AI SDK / Drizzle を残し、Effect と組み合わせる**: 実績のある部品を使える。一方、Promise の世界との変換が各所に入り、エラーの型付けが境界で途切れる。どちらもまだ実装前で、置き換えのコストが低い今のうちにそろえる

## Consequences

### Positive

- 起きうるエラーが関数の型に現れ、扱い漏れを型チェックで検出できる
- テストで依存と時刻を差し替えやすい
- 外部データの検証、再試行、ポーリング、同時実行数の制限を共通の仕組みで書ける

### Negative

- Effect の学習コストがかかる
- Effect 4 は新しく、周辺パッケージの v4 対応にばらつきがある。2026-11-25 時点で `@effect/ai-google` は 0.16.0 で、ほかの provider（4.1.5）に追いついていない。Gemini は実装時に、OpenAI 互換エンドポイントを使うか自前で provider を書くかを判断する
- Jev / OpenAI Decisions / Gemini Decisions の各 API には Effect の provider がないため、`effect/http` の HttpClient で自前で実装する

### Neutral

- [ADR-0002](0002-desktop-app-stack.md) のうち、Electron + TypeScript、React、dnd-kit、safeStorage、Vitest、pnpm の決定は変わらない

## References

- `node_modules/effect/CLAUDE.md`（Effect 同梱のドキュメント）
- [architecture.md](../architecture.md)
