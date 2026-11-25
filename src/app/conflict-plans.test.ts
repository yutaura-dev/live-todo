import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { decodePlan, type NextActionPlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { applyConflictPlans } from "./conflict-plans.js";

let n = 0;
const conflictTask = (plan: NextActionPlan | null, externalSuffix = "#pr-conflict") =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const number = n++;
    const item = yield* items.upsertItem({
      source: "github:personal:watch",
      externalId: `https://api.github.com/repos/acme/app/pulls/${number}${externalSuffix}`,
      title: "PR の conflict を解消する",
      url: `https://github.com/acme/app/pull/${number}`,
      state: "open",
      fingerprint: "v1",
    });
    const task = yield* tasks.createTask({ title: item.title, status: "todo" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    if (plan !== null) yield* tasks.updateTask(task.id, { nextActions: plan });
    return task.id;
  });

const kindsOf = (taskId: number) =>
  Effect.gen(function* () {
    const task = Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId));
    return Option.match(decodePlan(task.nextActions), { onNone: () => [], onSome: (plan) => plan.steps.map((step) => step.kind) });
  });

const manualPlan = (status: "todo" | "done"): NextActionPlan => ({
  steps: [{ id: "s1", kind: "manual", title: "手元で直す", effort: "hard", mode: "serial", status }],
});

describe("applyConflictPlans", () => {
  it("conflict を追う Task は、次にやることを「アプリで直させる → 確かめて push する」にする（手作業の手順を置き換える）", () =>
    Effect.gen(function* () {
      const empty = yield* conflictTask(null);
      const manual = yield* conflictTask(manualPlan("todo"));

      assert.strictEqual(yield* applyConflictPlans, 2);

      for (const id of [empty, manual]) assert.deepStrictEqual(yield* kindsOf(id), ["resolve_conflicts", "push_conflict_resolution"]);
    }).pipe(Effect.provide(TestDatabase)));

  it("手を付けた手順がある Task と、conflict 以外の Task はそのままにする", () =>
    Effect.gen(function* () {
      const started = yield* conflictTask(manualPlan("done"));
      const other = yield* conflictTask(manualPlan("todo"), "#pr-checks-failing");

      assert.strictEqual(yield* applyConflictPlans, 0);
      assert.deepStrictEqual(yield* kindsOf(started), ["manual"]);
      assert.deepStrictEqual(yield* kindsOf(other), ["manual"]);
    }).pipe(Effect.provide(TestDatabase)));

  it("もうコンフリクトの手順になっている Task は、作り直さない", () =>
    Effect.gen(function* () {
      yield* conflictTask(null);
      yield* applyConflictPlans;

      assert.strictEqual(yield* applyConflictPlans, 0);
    }).pipe(Effect.provide(TestDatabase)));
});
