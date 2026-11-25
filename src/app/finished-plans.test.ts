import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestDatabase } from "../core/db/test-database.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { Database } from "../core/db/database.js";
import { tasks as tasksTable } from "../core/db/schema.js";
import { eq } from "drizzle-orm";
import { completeFinishedPlans } from "./finished-plans.js";

const done = { steps: [{ id: "s1", kind: "manual", title: "push する", effort: "easy", mode: "serial", status: "done" }] };

describe("completeFinishedPlans", () => {
  it.effect("次にやることがすべて済んだのに残っている Task（自動で完了にする前に済んだもの）を完了にする", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const task = yield* tasks.createTask({ title: "#63", status: "todo" });
      // 自動で完了にする前の状態を作るため、状態を合わせずに書き込む
      yield* (yield* Database).update(tasksTable).set({ nextActions: done }).where(eq(tasksTable.id, task.id));

      assert.strictEqual(yield* completeFinishedPlans, 1);
      assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(task.id)).status, "done");
    }).pipe(Effect.provide(TestDatabase)));
});
