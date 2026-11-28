import { and, eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { StoreDatabase } from "./database.js";
import { documents } from "./schema.js";
import { StoreCorrupted } from "./task-store.js";

/** 種類と ID で引いて、JSON を丸ごと保存する */
export class DocumentStore extends Context.Service<
  DocumentStore,
  {
    put(kind: string, id: string, body: string): Effect.Effect<void>;
    get(kind: string, id: string): Effect.Effect<Option.Option<string>>;
    list(kind: string): Effect.Effect<ReadonlyArray<{ id: string; body: string }>>;
  }
>()("live-todo/store/DocumentStore") {
  static readonly layer = Layer.effect(
    DocumentStore,
    Effect.gen(function* () {
      const db = yield* StoreDatabase;
      const put = (kind: string, id: string, body: string) =>
        Effect.gen(function* () {
          const row = { kind, id, body, updatedAt: DateTime.formatIso(yield* DateTime.now) };
          yield* db.insert(documents).values(row).onConflictDoUpdate({ target: [documents.kind, documents.id], set: row });
        }).pipe(Effect.orDie);
      const get = (kind: string, id: string) =>
        db
          .select({ body: documents.body })
          .from(documents)
          .where(and(eq(documents.kind, kind), eq(documents.id, id)))
          .pipe(Effect.orDie, Effect.map(([row]) => Option.fromNullishOr(row?.body)));
      const list = (kind: string) => db.select({ id: documents.id, body: documents.body }).from(documents).where(eq(documents.kind, kind)).pipe(Effect.orDie);
      return DocumentStore.of({ put, get, list });
    }),
  );
}

/** 種類ごとの、型の付いた読み書き。読めない行は StoreCorrupted にする（黙って捨てない） */
export function documentsOf<A extends { readonly id: string }>(kind: string, schema: Schema.Codec<A, unknown>) {
  const codec = Schema.fromJsonString(schema as Schema.Codec<A, unknown>);
  const decode = (id: string, body: string) =>
    Schema.decodeUnknownEffect(codec)(body).pipe(Effect.mapError((error) => new StoreCorrupted({ taskId: `${kind}:${id}`, message: error.message })));
  const encode = Schema.encodeUnknownSync(codec);
  return {
    save: (value: A) =>
      Effect.gen(function* () {
        yield* (yield* DocumentStore).put(kind, value.id, encode(value) as string);
      }),
    find: (id: string) =>
      Effect.gen(function* () {
        const found = yield* (yield* DocumentStore).get(kind, id);
        return Option.isNone(found) ? Option.none<A>() : Option.some(yield* decode(id, found.value));
      }),
    all: () =>
      Effect.gen(function* () {
        const rows = yield* (yield* DocumentStore).list(kind);
        return yield* Effect.forEach(rows, (row) => decode(row.id, row.body));
      }),
  };
}
