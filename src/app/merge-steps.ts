import { and, eq, inArray, isNotNull, like } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Database } from "../core/db/database.js";
import { sourceItems, taskLinks, tasks } from "../core/db/schema.js";
import { decodePlan, type Step } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";

// merge するだけの手順に限る（「指摘に対応して merge する」のような、ほかの作業を含む手順は変えない）
const MERGE_ONLY = /^(この )?PR( #\d+)? を merge する$/i;

function upgrade(steps: ReadonlyArray<Step>): { steps: Step[]; changed: boolean } {
  let changed = false;
  const next = steps.map((step): Step => {
    if (step.kind === "decision") {
      const options = step.options.map((option) => {
        const inner = upgrade(option.steps);
        changed ||= inner.changed;
        return { ...option, steps: inner.steps };
      });
      return { ...step, options };
    }
    if (step.kind === "manual" && step.status === "todo" && MERGE_ONLY.test(step.title)) {
      changed = true;
      return { ...step, kind: "merge_pull_request" };
    }
    return step;
  });
  return { steps: next, changed };
}

/**
 * AI が手作業として作った「PR を merge する」手順を、アプリから merge できる手順にする
 * （merge の手順を AI が選べるようにする前に作った次にやることのため）。変えた Task の数を返す
 */
export const upgradeMergeSteps = Effect.gen(function* () {
  const db = yield* Database;
  const taskRepository = yield* TaskRepository;
  const rows = yield* db
    .selectDistinct({ id: tasks.id, nextActions: tasks.nextActions })
    .from(taskLinks)
    .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(
      and(
        eq(taskLinks.role, "tracks"),
        like(sourceItems.url, "https://github.com/%/pull/%"),
        isNotNull(tasks.nextActions),
        inArray(tasks.status, ["needs_review", "todo", "in_progress"]),
      ),
    )
    .pipe(Effect.orDie);
  let upgraded = 0;
  for (const row of rows) {
    const plan = decodePlan(row.nextActions);
    if (Option.isNone(plan)) continue;
    const result = upgrade(plan.value.steps);
    if (!result.changed) continue;
    yield* taskRepository.updateTask(row.id, { nextActions: { steps: result.steps } });
    upgraded++;
  }
  return upgraded;
});
