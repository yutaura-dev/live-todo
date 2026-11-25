import { fileURLToPath } from "node:url";
import { Context, Effect, Layer } from "effect";
import * as SQLiteNodeDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";

type DrizzleDatabase = Effect.Success<ReturnType<typeof SQLiteNodeDrizzle.makeWithDefaults>>;

export class Database extends Context.Service<Database, DrizzleDatabase>()("live-todo/core/db/Database") {
  static readonly layer = Layer.effect(Database, SQLiteNodeDrizzle.makeWithDefaults());
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export const DatabaseMigrations = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database;
    yield* migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }),
);
