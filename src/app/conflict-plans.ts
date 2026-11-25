import { and, eq, inArray, like } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Database } from "../core/db/database.js";
import { sourceItems, taskLinks, tasks } from "../core/db/schema.js";
import { conflictPlan, decodePlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";

// 見張り（ADR-0008）の conflict の Condition Item は、externalId の末尾が #pr-conflict になる
const CONFLICT_SUFFIX = "#pr-conflict";

/**
 * PR の conflict を追う Task の次にやることを、アプリで直させる手順にする。
 * AI が考えた手作業の手順（手元で fetch して直す、など）は置き換える。手を付けた手順があれば触らない。置き換えた数を返す
 */
export const applyConflictPlans = Effect.gen(function* () {
  const db = yield* Database;
  const taskRepository = yield* TaskRepository;
  const rows = yield* db
    .selectDistinct({ taskId: tasks.id, nextActions: tasks.nextActions })
    .from(taskLinks)
    .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(
      and(
        eq(taskLinks.role, "tracks"),
        eq(sourceItems.state, "open"),
        like(sourceItems.externalId, `%${CONFLICT_SUFFIX}`),
        inArray(tasks.status, ["needs_review", "todo", "in_progress"]),
      ),
    )
    .pipe(Effect.orDie);

  let applied = 0;
  for (const row of rows) {
    const current = decodePlan(row.nextActions);
    if (Option.isSome(current)) {
      const steps = current.value.steps;
      if (steps.some((step) => step.kind === "resolve_conflicts" || step.status === "done")) continue;
    }
    const plan = conflictPlan();
    yield* taskRepository.updateTask(row.taskId, { nextActions: plan });
    yield* taskRepository.recordChange(row.taskId, {
      kind: "field_changed",
      field: "next_actions",
      before: null,
      after: plan.steps.map((step) => step.title).join(" / "),
      unread: true,
      actor: "agent",
    });
    applied++;
  }
  return applied;
});
