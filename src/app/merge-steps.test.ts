import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { decodePlan, type NextActionPlan, type Step } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { upgradeMergeSteps } from "./merge-steps.js";

let n = 0;
const taskWith = (plan: NextActionPlan, url = `https://github.com/acme/app/pull/${700 + n}`) =>
  Effect.gen(function* () {
    const item = yield* (yield* SourceItemRepository).upsertItem({ source: "github:personal", externalId: `x${n++}`, title: "t", url, state: "open", fingerprint: "v1" });
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: "t", status: "todo" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    yield* tasks.updateTask(task.id, { nextActions: plan });
    return task.id;
  });

const manual = (id: string, title: string): Step => ({ id, kind: "manual", title, effort: "easy", mode: "serial", status: "todo" });
const kindsOf = (taskId: number) =>
  Effect.gen(function* () {
    const plan = Option.getOrThrow(decodePlan(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).nextActions));
    const flat = (steps: ReadonlyArray<Step>): string[] => steps.flatMap((step) => (step.kind === "decision" ? step.options.flatMap((option) => flat(option.steps)) : [step.kind]));
    return flat(plan.steps);
  });

describe("upgradeMergeSteps", () => {
  it.effect("PR を追う Task の「PR を merge する」だけの手作業の手順を、アプリから merge できる手順にする（分かれ道の中も）", () =>
    Effect.gen(function* () {
      const id = yield* taskWith({
        steps: [
          manual("a", "Storybook を見直す"),
          {
            id: "d",
            kind: "decision",
            title: "決める",
            effort: "easy",
            mode: "serial",
            status: "todo",
            options: [
              { key: "o1", label: "依頼する", steps: [manual("d.1", "指摘に対応して PR #733 を merge する")] },
              { key: "o2", label: "しない", steps: [manual("d.2", "PR #733 を merge する")] },
            ],
          },
        ],
      });

      assert.strictEqual(yield* upgradeMergeSteps, 1);
      assert.deepStrictEqual(yield* kindsOf(id), ["manual", "manual", "merge_pull_request"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("PR を追わない Task と、済んだ手順はそのままにする", () =>
    Effect.gen(function* () {
      const issue = yield* taskWith({ steps: [manual("a", "PR を merge する")] }, "https://github.com/acme/app/issues/1");
      const done = yield* taskWith({ steps: [{ ...manual("a", "PR を merge する"), status: "done" }, manual("b", "連絡する")] });

      assert.strictEqual(yield* upgradeMergeSteps, 0);
      assert.deepStrictEqual(yield* kindsOf(issue), ["manual"]);
      assert.deepStrictEqual(yield* kindsOf(done), ["manual", "manual"]);
    }).pipe(Effect.provide(TestDatabase)));
});
