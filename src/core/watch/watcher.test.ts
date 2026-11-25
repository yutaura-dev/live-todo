import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { SourceChange } from "../sync/source-change.js";
import { type Condition, type ConditionItem, makeWatcher, type WatchProvider } from "./watcher.js";

type Subject = { id: string; broken: boolean | null; waitingSince: string };

const brokenCondition: Condition<Subject> = {
  id: "broken",
  title: (subject) => `${subject.id} を直す`,
  evaluate: (subject) => (subject.broken === null ? "unknown" : subject.broken ? "holds" : "clear"),
};

const WAIT_LIMIT_MS = 48 * 60 * 60 * 1000;
const waitingTooLong: Condition<Subject> = {
  id: "waiting",
  title: (subject) => `${subject.id} の返事を催促する`,
  evaluate: (subject, now) =>
    DateTime.toEpochMillis(now) - Date.parse(subject.waitingSince) >= WAIT_LIMIT_MS ? "holds" : "clear",
};

const subject = (overrides: Partial<Subject> = {}): Subject => ({
  id: "s1",
  broken: false,
  waitingSince: "2026-11-25T00:00:00Z",
  ...overrides,
});

const setup = (conditions: Condition<Subject>[] = [brokenCondition]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
    const subjects = yield* Ref.make<Subject[]>([]);
    const provider: WatchProvider<Subject, never> = {
      source: "test",
      subjects: Ref.get(subjects),
      subjectId: (value) => value.id,
      subjectUrl: (value) => `https://example.com/${value.id}`,
    };
    const watcher = makeWatcher(provider, conditions);
    return { subjects, watcher };
  });

const upsertedItems = (changes: readonly SourceChange<ConditionItem>[]) =>
  changes.flatMap((change) => (change.kind === "upserted" ? [change.item] : []));

describe("makeWatcher", () => {
  it.effect("条件が成り立った対象を、成り立っている Condition Item として返す", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);

      const { changes } = yield* watcher.fetchChanges(null);

      assert.deepStrictEqual(upsertedItems(changes), [
        {
          externalId: "s1#broken",
          subjectId: "s1",
          conditionId: "broken",
          title: "s1 を直す",
          url: "https://example.com/s1",
          holds: true,
        },
      ]);
    }));

  it.effect("条件が成り立っていない対象は Item として返さない", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: false })]);

      const { changes } = yield* watcher.fetchChanges(null);

      assert.deepStrictEqual(changes, []);
    }));

  it.effect("成り立ち続けている条件は、2 回目以降は変更として返さない", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);
      const first = yield* watcher.fetchChanges(null);

      const second = yield* watcher.fetchChanges(first.nextCursor);

      assert.deepStrictEqual(second.changes, []);
    }));

  it.effect("成り立っていた条件が解消したら、解消した Item として返す", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);
      const first = yield* watcher.fetchChanges(null);
      yield* Ref.set(subjects, [subject({ broken: false })]);

      const second = yield* watcher.fetchChanges(first.nextCursor);

      assert.deepStrictEqual(upsertedItems(second.changes).map((item) => [item.externalId, item.holds]), [["s1#broken", false]]);
    }));

  it.effect("判定が unknown のときは、前回成り立っていれば成り立ったままにする", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);
      const first = yield* watcher.fetchChanges(null);
      yield* Ref.set(subjects, [subject({ broken: null })]);

      const second = yield* watcher.fetchChanges(first.nextCursor);
      yield* Ref.set(subjects, [subject({ broken: false })]);
      const third = yield* watcher.fetchChanges(second.nextCursor);

      assert.deepStrictEqual(second.changes, []);
      assert.deepStrictEqual(upsertedItems(third.changes).map((item) => item.holds), [false]);
    }));

  it.effect("前回の記録がない unknown は、成り立っていない扱いにする", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: null })]);

      const { changes } = yield* watcher.fetchChanges(null);

      assert.deepStrictEqual(changes, []);
    }));

  it.effect("条件が成り立っていた対象が一覧から消えたら removed として返す", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);
      const first = yield* watcher.fetchChanges(null);
      yield* Ref.set(subjects, []);

      const second = yield* watcher.fetchChanges(first.nextCursor);

      assert.deepStrictEqual(second.changes, [{ kind: "removed", externalId: "s1#broken" }]);
    }));

  it.effect("時間の条件は、対象に何も起きなくても時間が経てば成り立つ", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup([waitingTooLong]);
      yield* Ref.set(subjects, [subject()]);
      const first = yield* watcher.fetchChanges(null);

      yield* TestClock.adjust("48 hours");
      const second = yield* watcher.fetchChanges(first.nextCursor);

      assert.deepStrictEqual(first.changes, []);
      assert.deepStrictEqual(upsertedItems(second.changes).map((item) => [item.title, item.holds]), [["s1 の返事を催促する", true]]);
    }));

  it.effect("次回のカーソルには、成り立っている条件だけを入れる", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup([brokenCondition, waitingTooLong]);
      yield* Ref.set(subjects, [subject({ id: "s1", broken: true }), subject({ id: "s2", broken: false })]);

      const { nextCursor } = yield* watcher.fetchChanges(null);

      assert.deepStrictEqual(nextCursor, { holding: ["s1#broken"] });
    }));
});
