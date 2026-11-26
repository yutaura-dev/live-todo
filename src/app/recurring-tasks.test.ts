import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestDatabase } from "../core/db/test-database.js";
import { currentSteps, decodePlan, type NextActionPlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { createRecurringFromTask, createRecurringTask, listRecurringTasks, runRecurringTasks, updateRecurringActive } from "./recurring-tasks.js";

const monthly = (day: number, leadDays = 0) => ({ kind: "monthly" as const, day, leadDays });
const template: NextActionPlan = {
  steps: [
    { id: "s1", kind: "manual", title: "請求書を作る", effort: "normal", mode: "serial", status: "todo" },
    { id: "s2", kind: "manual", title: "送る", effort: "easy", mode: "serial", status: "todo" },
  ],
};

const tasksOf = Effect.gen(function* () {
  return (yield* (yield* TaskRepository).listTasks).map((task) => ({ title: task.title, status: task.status, brief: task.brief, period: task.recurrencePeriod }));
});

describe("定期の Task", () => {
  it.effect("決めた日になったら、何月分かを付けたタイトルと、メモ・次にやることのひな形で Task を作る", () =>
    Effect.gen(function* () {
      yield* createRecurringTask({ title: "請求書を送る", note: "11月分から金額を倍にする", schedule: monthly(1), nextActions: template }, { year: 2026, month: 11, day: 26 });

      assert.strictEqual(yield* runRecurringTasks({ year: 2026, month: 11, day: 30 }), 0);
      assert.strictEqual(yield* runRecurringTasks({ year: 2026, month: 12, day: 1 }), 1);

      const [task] = yield* tasksOf;
      assert.deepStrictEqual(task, { title: "請求書を送る（12月分）", status: "todo", brief: "11月分から金額を倍にする", period: "2026-12" });
      const created = (yield* (yield* TaskRepository).listTasks)[0]!;
      assert.deepStrictEqual(Option.map(decodePlan(created.nextActions), (plan) => currentSteps(plan).map((step) => step.title)), Option.some(["請求書を作る"]));
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("同じ月の分は二度作らない（Task を消しても作り直さない）", () =>
    Effect.gen(function* () {
      yield* createRecurringTask({ title: "請求書を送る", note: "", schedule: monthly(1) }, { year: 2026, month: 11, day: 26 });

      yield* runRecurringTasks({ year: 2026, month: 12, day: 1 });
      const [task] = yield* (yield* TaskRepository).listTasks;
      yield* (yield* TaskRepository).updateTask(task!.id, { status: "dismissed" });

      assert.strictEqual(yield* runRecurringTasks({ year: 2026, month: 12, day: 2 }), 0);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("前の月の分が終わっていなければ、今月の分も作り、そのことを状況に書く", () =>
    Effect.gen(function* () {
      yield* createRecurringTask({ title: "請求書を送る", note: "メモ", schedule: monthly(1) }, { year: 2026, month: 10, day: 26 });
      yield* runRecurringTasks({ year: 2026, month: 11, day: 1 });

      yield* runRecurringTasks({ year: 2026, month: 12, day: 1 });

      const tasks = yield* tasksOf;
      assert.lengthOf(tasks, 2);
      assert.include(tasks.find((task) => task.period === "2026-12")?.brief ?? "", "11月分がまだ終わっていない");
      assert.include(tasks.find((task) => task.period === "2026-12")?.brief ?? "", "メモ");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("登録した時点で今月の時期を過ぎていても、今月の分は作らない。「今月の分も作る」なら作る", () =>
    Effect.gen(function* () {
      yield* createRecurringTask({ title: "A", note: "", schedule: monthly(1) }, { year: 2026, month: 11, day: 26 });
      yield* createRecurringTask({ title: "B", note: "", schedule: monthly(1), includeCurrent: true }, { year: 2026, month: 11, day: 26 });

      yield* runRecurringTasks({ year: 2026, month: 11, day: 26 });

      assert.deepStrictEqual((yield* tasksOf).map((task) => task.title), ["B（11月分）"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("止めた決まりからは作らない", () =>
    Effect.gen(function* () {
      const id = yield* createRecurringTask({ title: "A", note: "", schedule: monthly(1) }, { year: 2026, month: 11, day: 26 });
      yield* updateRecurringActive(id, false);

      assert.strictEqual(yield* runRecurringTasks({ year: 2026, month: 12, day: 1 }), 0);
    }).pipe(Effect.provide(TestDatabase)));
});

describe("Task から定期の Task を作る（AI の提案もこの入口を使う）", () => {
  it.effect("Task のタイトル（何月分は除く）と次にやること（すべて未着手に戻す）をひな形にする", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const task = yield* tasks.createTask({ title: "請求書を送る（11月分）", status: "done" });
      yield* tasks.updateTask(task.id, {
        nextActions: { steps: template.steps.map((step) => ({ ...step, status: "done" as const })) },
      });

      yield* createRecurringFromTask(task.id, { schedule: monthly(1), note: "" }, { year: 2026, month: 11, day: 26 });

      const [rule] = yield* listRecurringTasks;
      assert.strictEqual(rule?.title, "請求書を送る");
      assert.deepStrictEqual(
        Option.map(decodePlan(rule?.nextActions), (plan) => plan.steps.map((step) => step.status)),
        Option.some(["todo", "todo"]),
      );
    }).pipe(Effect.provide(TestDatabase)));
});
