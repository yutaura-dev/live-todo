import { SqliteClient } from "@effect/sql-sqlite-node";
import { Layer } from "effect";
import { TaskMigrations } from "./migrations.js";
import { TaskRepository } from "./task-repository.js";

/** テストごとにまっさらなインメモリ DB を用意する。Effect.provide するたびに新しい DB になる */
export const TaskRepositoryTest = TaskRepository.layer.pipe(
  Layer.provideMerge(TaskMigrations),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);
