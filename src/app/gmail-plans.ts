import { and, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";
import { Database } from "../core/db/database.js";
import { sourceItems, taskLinks, tasks } from "../core/db/schema.js";
import { decodePlan, type NextActionPlan, senderPlan, type Step } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { gmailSendersSource, loadMails } from "../sources/gmail/gmail-bindings.js";
import { senderGroups } from "../sources/gmail/gmail-mailbox.js";

const OPEN = ["todo", "in_progress", "needs_review"] as const;

const touched = (steps: ReadonlyArray<Step>): boolean =>
  steps.some((step) => step.status === "done" || (step.kind === "decision" && (step.chosen !== undefined || step.options.some((option) => touched(option.steps)))));

/**
 * 送り主の Task の次にやることを、アプリで決めた手順（確認済みにするかゴミ箱に入れる・配信を続けるか）にそろえる。
 * 分かれ道を選んだなど手を付けていれば、通数のタイトルだけを合わせる。ほかの手順（手で考え直したもの）は触らない。
 * 通数が変わるたびに書くので、Task の履歴には残さない
 */
export const applyGmailSenderPlans = Effect.fnUntraced(function* (accountId: string) {
  const db = yield* Database;
  const taskRepository = yield* TaskRepository;
  const rows = yield* db
    .select({ taskId: tasks.id, nextActions: tasks.nextActions, senderKey: sourceItems.externalId })
    .from(taskLinks)
    .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(sourceItems.source, gmailSendersSource(accountId)), inArray(tasks.status, [...OPEN])))
    .pipe(Effect.orDie);
  if (rows.length === 0) return 0;
  const groups = new Map(senderGroups(yield* loadMails(accountId), DateTime.toEpochMillis(yield* DateTime.now)).map((group) => [group.senderKey, group]));

  let applied = 0;
  for (const row of rows) {
    const group = groups.get(row.senderKey);
    if (group === undefined || group.pending.length === 0) continue;
    const desired = senderPlan({ senderName: group.senderName, pending: group.pending.length, pastInvites: group.pastInvites.length, suggestUnsubscribe: group.suggestUnsubscribe });
    const current = decodePlan(row.nextActions);
    let next: NextActionPlan | undefined;
    if (Option.isNone(current)) next = desired;
    else if (!current.value.steps.some((step) => step.kind === "process_mail")) continue;
    else if (touched(current.value.steps)) {
      const title = desired.steps.find((step) => step.kind === "process_mail")!.title;
      const changed = current.value.steps.map((step) => (step.kind === "process_mail" ? { ...step, title } : step));
      if (JSON.stringify(changed) !== JSON.stringify(current.value.steps)) next = { steps: changed };
    } else if (JSON.stringify(current.value) !== JSON.stringify(desired)) next = desired;
    if (next === undefined) continue;
    yield* taskRepository.updateTask(row.taskId, { nextActions: next });
    applied++;
  }
  return applied;
});
