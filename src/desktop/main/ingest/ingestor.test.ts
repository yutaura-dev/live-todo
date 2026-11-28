import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { StoreDatabase } from "../../../store/database.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { sequentialIds } from "../task-service.js";
import { Ingestor, type Observed } from "./ingestor.js";

const layer = Ingestor.layer.pipe(Layer.provideMerge(SourceItemStore.layer.pipe(Layer.provide(StoreDatabase.layer({ filename: ":memory:" })))), Layer.provide(sequentialIds("s")));
const observed = (state: string): Observed => ({
  externalId: "https://api.github.com/repos/acme/app/pulls/42",
  uri: "github://me@github.com/acme/app/pull/42",
  url: "https://github.com/acme/app/pull/42",
  stream: "通知",
  snapshot: { title: "axios を上げる", author: "dependabot[bot]", fact: { trusted: [{ key: "状態", value: state }], body: "" }, sourceUpdatedAt: null },
});
const ingest = (changes: Parameters<Ingestor["Service"]["ingest"]>[1]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
    return yield* (yield* Ingestor).ingest("github-work", changes);
  });

describe("Ingestor（Adapter が返した変化を、事実に反映する）", () => {
  it.effect("初めて届いたものは取り込み、届いたことを返す", () =>
    Effect.gen(function* () {
      const result = yield* ingest([{ kind: "upserted", item: observed("開いている") }]);
      assert.deepStrictEqual(result.map((r) => [r.event, r.item.id, r.item.uri]), [["appeared", "s1", "github://me@github.com/acme/app/pull/42"]]);
    }).pipe(Effect.provide(layer)));

  it.effect("同じ事実が中身を変えて届いたら、事実が変わる（2 件作らない）", () =>
    Effect.gen(function* () {
      yield* ingest([{ kind: "upserted", item: observed("開いている") }]);
      const result = yield* ingest([{ kind: "upserted", item: observed("マージ済み") }]);
      assert.deepStrictEqual(result.map((r) => [r.event, r.item.id]), [["changed", "s1"]]);
    }).pipe(Effect.provide(layer)));

  it.effect("中身が同じなら、何も起きなかったことにする", () =>
    Effect.gen(function* () {
      yield* ingest([{ kind: "upserted", item: observed("開いている") }]);
      assert.deepStrictEqual((yield* ingest([{ kind: "upserted", item: observed("開いている") }])).map((r) => r.event), ["unchanged"]);
    }).pipe(Effect.provide(layer)));

  it.effect("消えたものは、外の ID で探して消えたにし、また届いたら戻す", () =>
    Effect.gen(function* () {
      yield* ingest([{ kind: "upserted", item: observed("開いている") }]);
      const removed = yield* ingest([{ kind: "removed", externalId: "https://api.github.com/repos/acme/app/pulls/42" }]);
      assert.deepStrictEqual(removed.map((r) => [r.event, r.item.presence]), [["removed", "消えた"]]);
      const back = yield* ingest([{ kind: "upserted", item: observed("閉じた") }]);
      assert.deepStrictEqual(back.map((r) => [r.event, r.item.presence]), [["restored", "あり"]]);
    }).pipe(Effect.provide(layer)));

  it.effect("知らない事実が消えたと届いても、何もしない", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* ingest([{ kind: "removed", externalId: "unknown" }]), []);
    }).pipe(Effect.provide(layer)));
});
