import { and, inArray, isNotNull } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Database } from "../core/db/database.js";
import { tasks } from "../core/db/schema.js";
import { currentSteps, decodePlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";

/** 次にやることがすべて済んだのに終わっていない Task を完了にする（自動で完了にする前に済んだものを拾う）。数を返す */
export const completeFinishedPlans = Effect.gen(function* () {
  const db = yield* Database;
  const taskRepository = yield* TaskRepository;
  const rows = yield* db
    .select({ id: tasks.id, status: tasks.status, nextActions: tasks.nextActions })
    .from(tasks)
    .where(and(isNotNull(tasks.nextActions), inArray(tasks.status, ["todo", "in_progress"])))
    .pipe(Effect.orDie);
  let completed = 0;
  for (const row of rows) {
    const plan = decodePlan(row.nextActions);
    if (Option.isNone(plan) || plan.value.steps.length === 0 || currentSteps(plan.value).length > 0) continue;
    yield* taskRepository.updateTask(row.id, { status: "done" });
    yield* taskRepository.recordChange(row.id, { kind: "field_changed", field: "status", before: row.status, after: "done", unread: true, actor: "agent" });
    completed++;
  }
  return completed;
});
