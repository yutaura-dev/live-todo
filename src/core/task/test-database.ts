import { SqliteClient } from "@effect/sql-sqlite-node";
import { Layer } from "effect";
import { Database, DatabaseMigrations } from "../db/database.js";
import { TaskRepository } from "./task-repository.js";

/** テストごとにまっさらなインメモリ DB を用意する。Effect.provide するたびに新しい DB になる */
export const TaskRepositoryTest = TaskRepository.layer.pipe(
  Layer.provideMerge(DatabaseMigrations),
  Layer.provideMerge(Database.layer),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
);
