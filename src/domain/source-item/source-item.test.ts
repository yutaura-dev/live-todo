import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import * as Spec from "../../../specs/source-item.spec.ts";
import { capture, remove, restore, type Snapshot, update } from "./source-item.js";

const sync = { kind: "sync" } as const;
const ai = { kind: "agent" } as const;
const at = (iso: string) => TestClock.setTime(DateTime.makeUnsafe(iso).epochMilliseconds);
const snapshot = (state: string, title = "axios を 1.8 に上げる"): Snapshot => ({
  title,
  author: "dependabot[bot]",
  fact: { trusted: [{ key: "種類", value: "PullRequest" }, { key: "状態", value: state }], body: "依存を上げます" },
  sourceUpdatedAt: null,
});
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);
const pr = Effect.gen(function* () {
  yield* at("2026-11-28T00:00:00Z");
  return yield* capture({ id: "s1", uri: "github://me@github.com/acme/app/pull/42", url: "https://github.com/acme/app/pull/42", stream: "通知", snapshot: snapshot("開いている") }, sync);
});

describe("取り込む（spec の initial）", () => {
  it.effect("初めて届いた事実は、あり・初めて届いた出来事を 1 つ持つ", () =>
    Effect.gen(function* () {
      const item = yield* pr;
      assert.deepStrictEqual({ presence: item.presence, streams: item.streams, history: item.history.map((a) => a.kind), firstSeenAt: item.firstSeenAt }, {
        presence: "あり",
        streams: ["通知"],
        history: ["appeared"],
        firstSeenAt: "2026-11-28T00:00:00.000Z",
      });
    }));
});

describe(specOf(Spec.update), () => {
  it.effect("変わった項目すべての前と後を、出来事に残す", () =>
    Effect.gen(function* () {
      yield* at("2026-11-28T01:00:00Z");
      const item = yield* update(yield* pr, sync, snapshot("マージ済み"));
      assert.deepStrictEqual(item.history.at(-1)?.changes, [{ field: "trusted", key: "状態", before: "開いている", after: "マージ済み" }]);
      assert.strictEqual(item.latest.fact.trusted[1]?.value, "マージ済み");
    }));

  it.effect("中身が変わっていなければ、出来事を足さない", () =>
    Effect.gen(function* () {
      const item = yield* pr;
      assert.strictEqual((yield* update(item, sync, snapshot("開いている"))).history.length, 1);
    }));

  it.effect(specOf(Spec.update, "同期だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(update(yield* pr, ai, snapshot("マージ済み"))), "同期だけ");
    }));

  it.effect(specOf(Spec.update, "Source にあるときだけ"), () =>
    Effect.gen(function* () {
      const gone = yield* remove(yield* pr, sync, "削除された");
      assert.strictEqual(yield* reasonOf(update(gone, sync, snapshot("マージ済み"))), "Source にあるときだけ");
    }));
});

describe(specOf(Spec.remove), () => {
  it.effect("消えたことを、消えた理由と一緒に出来事に残す", () =>
    Effect.gen(function* () {
      const item = yield* remove(yield* pr, sync, "範囲の外になった");
      assert.deepStrictEqual({ presence: item.presence, last: item.history.at(-1)?.kind, removal: item.history.at(-1)?.removal }, { presence: "消えた", last: "removed", removal: "範囲の外になった" });
    }));

  it.effect(specOf(Spec.remove, "同期だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(remove(yield* pr, ai, "削除された")), "同期だけ");
    }));

  it.effect(specOf(Spec.remove, "Source にあるときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(remove(yield* remove(yield* pr, sync, "削除された"), sync, "削除された")), "Source にあるときだけ");
    }));
});

describe(specOf(Spec.restore), () => {
  it.effect("また現れたら、ありに戻し、消えていた間に変わった項目を持つ", () =>
    Effect.gen(function* () {
      const item = yield* restore(yield* remove(yield* pr, sync, "削除された"), sync, snapshot("閉じた"));
      assert.deepStrictEqual({ presence: item.presence, kind: item.history.at(-1)?.kind, changes: item.history.at(-1)?.changes }, {
        presence: "あり",
        kind: "restored",
        changes: [{ field: "trusted", key: "状態", before: "開いている", after: "閉じた" }],
      });
    }));

  it.effect(specOf(Spec.restore, "同期だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(restore(yield* remove(yield* pr, sync, "削除された"), ai, snapshot("閉じた"))), "同期だけ");
    }));

  it.effect(specOf(Spec.restore, "消えたときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(restore(yield* pr, sync, snapshot("閉じた"))), "消えたときだけ");
    }));
});
