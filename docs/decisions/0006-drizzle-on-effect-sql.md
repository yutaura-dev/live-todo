# ADR-0006: DB アクセスに Drizzle ORM（Effect 版）を使う

- **Status**: Accepted
- **Date**: 2026-11-25
- **Deciders**: YutaUra

## Context

[ADR-0005](0005-adopt-effect.md) で DB アクセスを `effect/sql` にし、SQL を文字列で書いて結果を Schema で検証する形にした。この形では、テーブルの構造を SQL の文字列・Schema・ビューの 3 か所に書く必要がある。どれかがずれても、型チェックでは気づけず、実行して初めてわかる。

調べ直したところ、Drizzle ORM 1.0 が Effect 4 に公式対応していた。`drizzle-orm/effect-sqlite-node` は、すでに使っている `@effect/sql-sqlite-node` の `SqliteClient` の上で動く。

## Decision

- DB アクセスには **drizzle-orm 1.0.0-rc.6 の `drizzle-orm/effect-sqlite-node`** を使う
- テーブル定義（`src/core/task/schema.ts`）を唯一の出どころとし、行の型は `$inferSelect` で導く
- マイグレーションは drizzle-kit（1.0.0-rc.6）で生成し（`pnpm db:generate`）、`drizzle/` を Drizzle の Effect 版 `migrate` で適用する
- ドライバ（`@effect/sql-sqlite-node`、`node:sqlite`）とトランザクションの仕組み（`SqlClient.withTransaction`）は変えない。Drizzle の Effect 版も内部で `SqlClient.withTransaction` を使うので、同じトランザクションに入る
- [ADR-0005](0005-adopt-effect.md) の「DB: `effect/sql` + `@effect/sql-sqlite-node`」は、この ADR で「その上に Drizzle を載せる」に置き換える

## Alternatives Considered

- **`effect/sql` の生 SQL のまま**: 依存が少なく、安定版だけで済む。一方、テーブルの構造を 3 か所に書く二重管理が残り、列名の打ち間違いを型で検出できない
- **`@effect/sql-drizzle`（Effect チーム製）**: 2026-11-25 時点の最新 0.51.0 は `effect ^3.22.0` までの対応で、Effect 4 では使えない
- **Drizzle の安定版（0.45.x）**: Effect 対応が入っていない。Promise との変換を自前で書くことになる

## Consequences

### Positive

- クエリがテーブル定義から型で守られ、列名の誤りを型チェックで検出できる
- テーブル構造の二重管理がなくなる
- マイグレーションをテーブル定義の差分から生成できる

### Negative

- **Drizzle 1.0 は rc（リリース候補）**。正式版までに API が変わる可能性がある。rc の更新は約 1 か月おき（rc.5: 2026-10-21、rc.6: 2026-11-20）
- drizzle-kit も rc を使う

### Neutral

- 1.0 の正式版が出たら、rc から正式版に上げる

## References

- [ADR-0005: 実装の基盤に Effect を採用する](0005-adopt-effect.md)
- `node_modules/drizzle-orm/effect-sqlite-node/driver.d.ts`
