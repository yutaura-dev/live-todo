import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../db/test-database.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { syncSource } from "../sync/sync-source.js";
import { TaskRepository } from "../task/task-repository.js";
import { watchBinding } from "./watch-binding.js";
import type { Condition, WatchProvider } from "./watcher.js";

type Subject = { id: string; broken: boolean };

const broken: Condition<Subject> = {
  id: "broken",
  title: (subject) => `${subject.id} を直す`,
  evaluate: (subject) => (subject.broken ? "holds" : "clear"),
};

const setup = Effect.gen(function* () {
  const subjects = yield* Ref.make<Subject[]>([]);
  const provider: WatchProvider<Subject, never> = {
    source: "test",
    listSubjects: Ref.get(subjects).pipe(Effect.map((all) => all.map((value) => ({ id: value.id, url: `https://example.com/${value.id}` })))),
    loadSubject: (ref) => Ref.get(subjects).pipe(Effect.map((all) => Option.fromNullishOr(all.find((value) => value.id === ref.id)))),
    fingerprint: (value) => String(value.broken),
  };
  return { subjects, binding: watchBinding(provider, [broken]) };
});

const conditionTask = (binding: ReturnType<typeof watchBinding>) =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const item = yield* items.findItem(binding.source, "s1#broken");
    if (Option.isNone(item)) return undefined;
    const task = yield* tasks.findTaskByItem(item.value.id);
    if (Option.isNone(task)) return undefined;
    return (yield* tasks.listTasks).find((candidate) => candidate.id === task.value.id);
  });

describe("watchBinding", () => {
  it.effect("条件が成り立ったら、条件が示すやることを title にした todo の Task を作る", () =>
    Effect.gen(function* () {
      const { subjects, binding } = yield* setup;
      yield* Ref.set(subjects, [{ id: "s1", broken: true }]);

      yield* syncSource(binding);

      const task = yield* conditionTask(binding);
      assert.strictEqual(task?.title, "s1 を直す");
      assert.strictEqual(task?.status, "todo");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("条件が成り立った Item は、LLM を使わずに規則で todo と判定する", () =>
    Effect.gen(function* () {
      const { binding } = yield* setup;
      const item = { externalId: "s1#broken", subjectId: "s1", conditionId: "broken", title: "s1 を直す", url: "u", holds: true };

      assert.deepStrictEqual(yield* binding.judge(item), { verdict: "todo", method: "rule" });
    }));

  it.effect("条件が解消したら Task を done にし、再発したら todo に戻す", () =>
    Effect.gen(function* () {
      const { subjects, binding } = yield* setup;

      yield* Ref.set(subjects, [{ id: "s1", broken: true }]);
      yield* syncSource(binding);
      yield* Ref.set(subjects, [{ id: "s1", broken: false }]);
      yield* TestClock.adjust("5 minutes");
      yield* syncSource(binding);
      const afterResolved = yield* conditionTask(binding);
      yield* Ref.set(subjects, [{ id: "s1", broken: true }]);
      yield* TestClock.adjust("5 minutes");
      yield* syncSource(binding);

      assert.strictEqual(afterResolved?.status, "done");
      assert.strictEqual(afterResolved?.unreadChanges, 1);
      assert.strictEqual((yield* conditionTask(binding))?.status, "todo");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("見張りのカーソルは、通常の取得とは別の source 名で保存する", () =>
    Effect.gen(function* () {
      const { binding } = yield* setup;

      yield* syncSource(binding);

      assert.strictEqual(binding.source, "test:watch");
      assert.isTrue(Option.isSome(yield* (yield* SourceItemRepository).loadCursor("test:watch")));
    }).pipe(Effect.provide(TestDatabase)));
});
