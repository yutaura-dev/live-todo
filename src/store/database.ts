import { fileURLToPath } from "node:url";
import * as SQLiteNodeDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Effect, Layer } from "effect";

const makeDatabase = SQLiteNodeDrizzle.makeWithDefaults();
type Database = Effect.Success<typeof makeDatabase>;

/** 作り直しのアプリの DB。開くときにマイグレーション（drizzle-store/）を当てる */
export class StoreDatabase extends Context.Service<StoreDatabase, Database>()("live-todo/store/StoreDatabase") {
  static readonly layer = (options: { filename: string; migrationsFolder?: string }) =>
    Layer.effect(
      StoreDatabase,
      Effect.gen(function* () {
        const db = yield* makeDatabase;
        yield* migrate(db, { migrationsFolder: options.migrationsFolder ?? fileURLToPath(new URL("../../drizzle-store", import.meta.url)) });
        return db;
      }),
    ).pipe(Layer.provide(SqliteClient.layer({ filename: options.filename })), Layer.orDie);
}
