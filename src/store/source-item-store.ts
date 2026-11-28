import { and, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SourceItem } from "../domain/source-item/source-item.js";
import { StoreDatabase } from "./database.js";
import { sourceItems } from "./schema.js";
import { StoreCorrupted } from "./task-store.js";

const codec = Schema.fromJsonString(SourceItem);
const decode = (id: string, body: string) => Schema.decodeUnknownEffect(codec)(body).pipe(Effect.mapError((error) => new StoreCorrupted({ taskId: `source-item:${id}`, message: error.message })));

export class SourceItemStore extends Context.Service<
  SourceItemStore,
  {
    save(item: SourceItem, key: { accountId: string; externalId: string }): Effect.Effect<void>;
    find(id: string): Effect.Effect<Option.Option<SourceItem>, StoreCorrupted>;
    findByUri(uri: string): Effect.Effect<Option.Option<SourceItem>, StoreCorrupted>;
    findByExternal(accountId: string, externalId: string): Effect.Effect<Option.Option<SourceItem>, StoreCorrupted>;
    findMany(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<SourceItem>, StoreCorrupted>;
  }
>()("live-todo/store/SourceItemStore") {
  static readonly layer = Layer.effect(
    SourceItemStore,
    Effect.gen(function* () {
      const db = yield* StoreDatabase;
      const one = (rows: ReadonlyArray<{ id: string; body: string }>) => (rows[0] === undefined ? Effect.succeed(Option.none()) : Effect.map(decode(rows[0].id, rows[0].body), Option.some));
      const save = (item: SourceItem, key: { accountId: string; externalId: string }) => {
        const row = { id: item.id, uri: item.uri, accountId: key.accountId, externalId: key.externalId, body: Schema.encodeUnknownSync(codec)(item) as string };
        return db.insert(sourceItems).values(row).onConflictDoUpdate({ target: sourceItems.id, set: row }).pipe(Effect.asVoid, Effect.orDie);
      };
      return SourceItemStore.of({
        save,
        find: (id) => db.select().from(sourceItems).where(eq(sourceItems.id, id)).pipe(Effect.orDie, Effect.flatMap(one)),
        findByUri: (uri) => db.select().from(sourceItems).where(eq(sourceItems.uri, uri)).pipe(Effect.orDie, Effect.flatMap(one)),
        findByExternal: (accountId, externalId) =>
          db.select().from(sourceItems).where(and(eq(sourceItems.accountId, accountId), eq(sourceItems.externalId, externalId))).pipe(Effect.orDie, Effect.flatMap(one)),
        findMany: (ids) =>
          ids.length === 0
            ? Effect.succeed([])
            : db.select().from(sourceItems).where(inArray(sourceItems.id, [...ids])).pipe(Effect.orDie, Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.id, row.body)))),
      });
    }),
  );
}
