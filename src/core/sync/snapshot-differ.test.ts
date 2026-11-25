import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { diffSnapshot, DuplicateExternalIdError } from "./snapshot-differ.js";

type Fixture = { id: string; body: string };

const identify = (item: Fixture) => ({ externalId: item.id, fingerprint: item.body });

describe("diffSnapshot", () => {
  it.effect("前回のスナップショットにない項目は upserted として返す", () =>
    Effect.gen(function* () {
      const previous = new Map<string, string>();
      const current = [{ id: "a", body: "v1" }];

      const { changes } = yield* diffSnapshot(previous, current, identify);

      assert.deepStrictEqual(changes, [{ kind: "upserted", item: { id: "a", body: "v1" } }]);
    }));

  it.effect("fingerprint が変わった項目は upserted として返す", () =>
    Effect.gen(function* () {
      const previous = new Map([["a", "v1"]]);
      const current = [{ id: "a", body: "v2" }];

      const { changes } = yield* diffSnapshot(previous, current, identify);

      assert.deepStrictEqual(changes, [{ kind: "upserted", item: { id: "a", body: "v2" } }]);
    }));

  it.effect("fingerprint が変わっていない項目は変更として返さない", () =>
    Effect.gen(function* () {
      const previous = new Map([["a", "v1"]]);
      const current = [{ id: "a", body: "v1" }];

      const { changes } = yield* diffSnapshot(previous, current, identify);

      assert.deepStrictEqual(changes, []);
    }));

  it.effect("今回のスナップショットから消えた項目は removed として返す", () =>
    Effect.gen(function* () {
      const previous = new Map([["a", "v1"]]);
      const current: Fixture[] = [];

      const { changes } = yield* diffSnapshot(previous, current, identify);

      assert.deepStrictEqual(changes, [{ kind: "removed", externalId: "a" }]);
    }));

  it.effect("次回の比較に使う fingerprint の一覧を今回のスナップショットから作る", () =>
    Effect.gen(function* () {
      const previous = new Map([["a", "v1"], ["gone", "x"]]);
      const current = [{ id: "a", body: "v2" }, { id: "b", body: "v1" }];

      const { nextFingerprints } = yield* diffSnapshot(previous, current, identify);

      assert.deepStrictEqual(nextFingerprints, new Map([["a", "v2"], ["b", "v1"]]));
    }));

  it.effect("同じ externalId が今回のスナップショットに重複していたらエラーにする", () =>
    Effect.gen(function* () {
      const previous = new Map<string, string>();
      const current = [{ id: "a", body: "v1" }, { id: "a", body: "v2" }];

      const error = yield* Effect.flip(diffSnapshot(previous, current, identify));

      assert.instanceOf(error, DuplicateExternalIdError);
      assert.strictEqual(error.externalId, "a");
    }));
});
