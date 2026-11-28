import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { StoreDatabase } from "./database.js";
import { DocumentStore, documentsOf } from "./document-store.js";

const Note = Schema.Struct({ id: Schema.String, text: Schema.String });
const notes = documentsOf("note", Note);
const layer = DocumentStore.layer.pipe(Layer.provide(StoreDatabase.layer({ filename: ":memory:" })));

describe("DocumentStore（ID で引いて丸ごと保存する）", () => {
  it.effect("保存したものを ID で引け、保存し直すと置き換わり、種類ごとに一覧できる", () =>
    Effect.gen(function* () {
      yield* notes.save({ id: "n1", text: "前" });
      yield* notes.save({ id: "n1", text: "後" });
      yield* notes.save({ id: "n2", text: "別" });
      assert.deepStrictEqual(yield* notes.find("n1"), Option.some({ id: "n1", text: "後" }));
      assert.deepStrictEqual((yield* notes.all()).map((n) => n.id).sort(), ["n1", "n2"]);
      assert.isTrue(Option.isNone(yield* documentsOf("other", Note).find("n1")));
    }).pipe(Effect.provide(layer)));
});
