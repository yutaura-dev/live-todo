import { SqliteClient } from "@effect/sql-sqlite-node";
import { Layer } from "effect";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { TaskRepository } from "../task/task-repository.js";
import { Database, DatabaseMigrations } from "./database.js";

/** テストごとにまっさらなインメモリ DB を用意する。Effect.provide するたびに新しい DB になる */
export const TestDatabase = Layer.mergeAll(SourceItemRepository.layer, TaskRepository.layer).pipe(
  Layer.provideMerge(DatabaseMigrations),
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);
