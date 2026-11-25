import { fileURLToPath } from "node:url";
import { Context, Effect, Layer } from "effect";
import * as SQLiteNodeDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { SqlClient } from "effect/sql";

type DrizzleDatabase = Effect.Success<ReturnType<typeof SQLiteNodeDrizzle.makeWithDefaults>>;

export class Database extends Context.Service<Database, DrizzleDatabase>()("live-todo/core/db/Database") {
  static readonly layer = Layer.effect(Database, SQLiteNodeDrizzle.makeWithDefaults());
}

// ソースのまま実行するとき（tsx・テスト）のマイグレーションの場所。Electron のように 1 ファイルに束ねると
// import.meta.url の位置が変わるので、そのときは databaseMigrationsFrom でフォルダを渡す。
const SOURCE_MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export const databaseMigrationsFrom = (migrationsFolder: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* migrate(db, { migrationsFolder });
    }),
  );

export const DatabaseMigrations = databaseMigrationsFrom(SOURCE_MIGRATIONS_FOLDER);

// db.transaction ではなく SqlClient.withTransaction を使う理由: 呼び出し側の Effect は tx ではなく
// 各 repository が持つ db を使って書かれている。Drizzle の Effect 版も内部で SqlClient.withTransaction を使い、
// トランザクションは fiber 単位で引き継がれるため、db 経由のクエリも同じトランザクションに入る。
export const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", Effect.die));
  });

export const returnedRow = <A>(rows: ReadonlyArray<A>): Effect.Effect<A> =>
  rows[0] === undefined ? Effect.die(new Error("RETURNING が行を返さなかった")) : Effect.succeed(rows[0]);
