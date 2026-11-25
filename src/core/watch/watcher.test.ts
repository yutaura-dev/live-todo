import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { SourceChange } from "../sync/source-change.js";
import { type Condition, type ConditionItem, makeWatcher, type WatchCursor, type WatchProvider } from "./watcher.js";

type Subject = { id: string; broken: boolean | null; waitingSince: string; revision?: string };

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
  revisitAt: (subject) => Option.some(DateTime.makeUnsafe(Date.parse(subject.waitingSince) + WAIT_LIMIT_MS)),
};

const START = Date.parse("2026-11-25T00:00:00Z");
const MINUTE = 60 * 1000;

const subject = (overrides: Partial<Subject> = {}): Subject => ({
  id: "s1",
  broken: false,
  waitingSince: "2026-11-25T00:00:00Z",
  ...overrides,
});

const setup = (conditions: Condition<Subject>[] = [brokenCondition]) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const subjects = yield* Ref.make<Subject[]>([]);
    const loads = yield* Ref.make<string[]>([]);
    const provider: WatchProvider<Subject, never> = {
      source: "test",
      listSubjects: Ref.get(subjects).pipe(
        Effect.map((all) =>
          all.map((value) => ({
            id: value.id,
            url: `https://example.com/${value.id}`,
            ...(value.revision === undefined ? {} : { revision: value.revision }),
          })),
        ),
      ),
      loadSubject: (ref) =>
        Effect.gen(function* () {
          yield* Ref.update(loads, (ids) => [...ids, ref.id]);
          return Option.fromNullishOr((yield* Ref.get(subjects)).find((value) => value.id === ref.id));
        }),
      fingerprint: (value) => JSON.stringify([value.broken]),
    };
    const watcher = makeWatcher(provider, conditions, { initial: "5 minutes", max: "1 day" });
    return { subjects, loads, watcher };
  });

const upsertedItems = (changes: readonly SourceChange<ConditionItem>[]) =>
  changes.flatMap((change) => (change.kind === "upserted" ? [change.item] : []));

const intervalMinutes = (cursor: WatchCursor, id = "s1") => (cursor.subjects[id]?.intervalMs ?? 0) / MINUTE;

describe("条件の判定", () => {
  it.effect("条件が成り立った対象を、成り立っている Condition Item として返す", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);

      const { changes } = yield* watcher.fetchChanges(null);

      assert.deepStrictEqual(upsertedItems(changes), [
        { externalId: "s1#broken", subjectId: "s1", conditionId: "broken", title: "s1 を直す", url: "https://example.com/s1", holds: true },
      ]);
    }));

  it.effect("条件が成り立っていない対象は Item として返さない", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: false })]);

      assert.deepStrictEqual((yield* watcher.fetchChanges(null)).changes, []);
    }));

  it.effect("成り立っていた条件が解消したら、解消した Item として返す", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);
      const first = yield* watcher.fetchChanges(null);
      yield* Ref.set(subjects, [subject({ broken: false })]);

      yield* TestClock.adjust("5 minutes");
      const second = yield* watcher.fetchChanges(first.nextCursor);

      assert.deepStrictEqual(upsertedItems(second.changes).map((item) => [item.externalId, item.holds]), [["s1#broken", false]]);
    }));

  it.effect("判定が unknown のときは、前回成り立っていれば成り立ったままにする", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);
      const first = yield* watcher.fetchChanges(null);
      yield* Ref.set(subjects, [subject({ broken: null })]);

      yield* TestClock.adjust("5 minutes");
      const second = yield* watcher.fetchChanges(first.nextCursor);

      assert.deepStrictEqual(second.changes, []);
      assert.deepStrictEqual(second.nextCursor.holding, ["s1#broken"]);
    }));

  it.effect("前回の記録がない unknown は、成り立っていない扱いにする", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: null })]);

      assert.deepStrictEqual((yield* watcher.fetchChanges(null)).changes, []);
    }));

  it.effect("条件が成り立っていた対象が一覧から消えたら removed として返す", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);
      const first = yield* watcher.fetchChanges(null);
      yield* Ref.set(subjects, []);

      const second = yield* watcher.fetchChanges(first.nextCursor);

      assert.deepStrictEqual(second.changes, [{ kind: "removed", externalId: "s1#broken" }]);
      assert.isUndefined(second.nextCursor.subjects["s1"]);
    }));
});

describe("見張る頻度", () => {
  it.effect("初めて見た対象は、最初の間隔で次の確認を予定する", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject()]);

      const { nextCursor } = yield* watcher.fetchChanges(null);

      assert.strictEqual(intervalMinutes(nextCursor), 5);
      assert.strictEqual(nextCursor.subjects["s1"]?.nextCheckAt, "2026-11-25T00:05:00.000Z");
    }));

  it.effect("次に確認する時刻より前は、詳細を取りに行かず、成り立っている条件をそのまま引き継ぐ", () =>
    Effect.gen(function* () {
      const { subjects, loads, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: true })]);
      const first = yield* watcher.fetchChanges(null);
      yield* Ref.set(subjects, [subject({ broken: false })]);

      yield* TestClock.adjust("4 minutes");
      const second = yield* watcher.fetchChanges(first.nextCursor);

      assert.deepStrictEqual(yield* Ref.get(loads), ["s1"]);
      assert.deepStrictEqual(second.changes, []);
      assert.deepStrictEqual(second.nextCursor.holding, ["s1#broken"]);
    }));

  it.effect("確認しても状態が変わらなければ、確認するたびに間隔を倍にする", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject()]);

      let cursor = (yield* watcher.fetchChanges(null)).nextCursor;
      const intervals = [intervalMinutes(cursor)];
      for (let index = 0; index < 3; index++) {
        yield* TestClock.adjust(intervals.at(-1)! * MINUTE);
        cursor = (yield* watcher.fetchChanges(cursor)).nextCursor;
        intervals.push(intervalMinutes(cursor));
      }

      assert.deepStrictEqual(intervals, [5, 10, 20, 40]);
    }));

  it.effect("間隔は上限（1 日）を超えない", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject()]);

      let cursor = (yield* watcher.fetchChanges(null)).nextCursor;
      for (let index = 0; index < 12; index++) {
        yield* TestClock.adjust(intervalMinutes(cursor) * MINUTE);
        cursor = (yield* watcher.fetchChanges(cursor)).nextCursor;
      }

      assert.strictEqual(intervalMinutes(cursor), 24 * 60);
    }));

  it.effect("状態が変わったら、間隔を最初に戻す", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject()]);
      let cursor = (yield* watcher.fetchChanges(null)).nextCursor;
      yield* TestClock.adjust("5 minutes");
      cursor = (yield* watcher.fetchChanges(cursor)).nextCursor;
      yield* Ref.set(subjects, [subject({ broken: true })]);

      yield* TestClock.adjust("10 minutes");
      cursor = (yield* watcher.fetchChanges(cursor)).nextCursor;

      assert.strictEqual(intervalMinutes(cursor), 5);
    }));

  it.effect("一覧の revision が変わったら、予定の時刻より前でも確認し、間隔を最初に戻す", () =>
    Effect.gen(function* () {
      const { subjects, loads, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ revision: "r1" })]);
      let cursor = (yield* watcher.fetchChanges(null)).nextCursor;
      yield* TestClock.adjust("5 minutes");
      cursor = (yield* watcher.fetchChanges(cursor)).nextCursor;
      yield* Ref.set(subjects, [subject({ revision: "r2", broken: true })]);

      yield* TestClock.adjust("1 minute");
      const result = yield* watcher.fetchChanges(cursor);

      assert.strictEqual((yield* Ref.get(loads)).length, 3);
      assert.deepStrictEqual(upsertedItems(result.changes).map((item) => item.holds), [true]);
      assert.strictEqual(intervalMinutes(result.nextCursor), 5);
    }));

  it.effect("判定が unknown の条件があるうちは、間隔を延ばさない", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup();
      yield* Ref.set(subjects, [subject({ broken: null })]);
      let cursor = (yield* watcher.fetchChanges(null)).nextCursor;

      yield* TestClock.adjust("5 minutes");
      cursor = (yield* watcher.fetchChanges(cursor)).nextCursor;

      assert.strictEqual(intervalMinutes(cursor), 5);
    }));

  it.effect("時間の条件が成り立つかもしれない時刻には、間隔に関係なく確認する", () =>
    Effect.gen(function* () {
      const { subjects, watcher } = yield* setup([waitingTooLong]);
      yield* Ref.set(subjects, [subject({ waitingSince: "2026-11-24T00:30:00Z" })]);
      let cursor = (yield* watcher.fetchChanges(null)).nextCursor;
      // 5, 10, 20, … と延びた間隔が 8 回目で 1280 分になり、成り立つかもしれない時刻（24.5 時間後）を越える
      for (let index = 0; index < 8; index++) {
        yield* TestClock.adjust(intervalMinutes(cursor) * MINUTE);
        cursor = (yield* watcher.fetchChanges(cursor)).nextCursor;
      }

      assert.strictEqual(cursor.subjects["s1"]?.nextCheckAt, "2026-11-26T00:30:00.000Z");
      yield* TestClock.setTime(Date.parse("2026-11-26T00:30:00Z"));
      const result = yield* watcher.fetchChanges(cursor);

      assert.deepStrictEqual(upsertedItems(result.changes).map((item) => [item.title, item.holds]), [["s1 の返事を催促する", true]]);
    }));
});
