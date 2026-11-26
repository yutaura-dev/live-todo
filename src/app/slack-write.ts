import { and, eq } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { Database } from "../core/db/database.js";
import { approvals, sourceItems, taskLinks } from "../core/db/schema.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { TaskStatus } from "../core/task/task.js";
import type { SlackClient } from "../sources/slack/slack-client.js";

export class SlackWriteError extends Schema.TaggedError<SlackWriteError>()("SlackWriteError", { message: Schema.String }) {}

/** complete: To-do を完了にする / remove: To-do・Saved から外す */
export type SlackAction = "complete" | "remove";

const SOURCE = /^slack:([a-z0-9][a-z0-9-]*)$/;
const EXTERNAL_ID = /^([CDG][A-Z0-9]+):(\d+\.\d+)$/;
const ACTIONS: Record<SlackAction, { approval: string; status: TaskStatus }> = {
  complete: { approval: "slack_complete", status: "done" },
  // 外すのは「自分の todo ではない」という判断なので、完了ではなく片付けにする
  remove: { approval: "slack_remove", status: "dismissed" },
};

/** Task が追う Slack の To-do・Saved の項目 */
const trackedSavedItem = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const rows = yield* db
    .select({ source: sourceItems.source, externalId: sourceItems.externalId })
    .from(taskLinks)
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(taskLinks.taskId, taskId), eq(taskLinks.role, "tracks")))
    .pipe(Effect.orDie);
  for (const row of rows) {
    const account = SOURCE.exec(row.source);
    const target = EXTERNAL_ID.exec(row.externalId);
    if (account !== null && target !== null) return { accountId: account[1]!, channel: target[1]!, ts: target[2]!, source: row.source, externalId: row.externalId };
  }
  return yield* new SlackWriteError({ message: "Slack の To-do・Saved を追う Task ではない" });
});

/**
 * 外部への書き込み。ユーザーが確認で承認したときだけ呼ぶ。承認を記録してから Slack に送り、Task の状態も合わせる。
 * 失敗してもやり直さない（書き込みは二重に効くおそれがあるため。仕様書）
 */
export const slackWrite = Effect.fnUntraced(function* <E, R>(
  taskId: number,
  action: SlackAction,
  clientFor: (accountId: string) => Effect.Effect<SlackClient["Service"], E, R>,
) {
  const db = yield* Database;
  const tasks = yield* TaskRepository;
  const target = yield* trackedSavedItem(taskId);
  const client = yield* clientFor(target.accountId);
  const record = {
    taskId,
    action: ACTIONS[action].approval,
    target: `${target.source} ${target.externalId}`,
    payload: { channel: target.channel, ts: target.ts },
    approvedAt: DateTime.formatIso(yield* DateTime.now),
  };
  const result = yield* (action === "complete" ? client.completeSaved(target.channel, target.ts) : client.removeSaved(target.channel, target.ts)).pipe(Effect.result);
  const executedAt = DateTime.formatIso(yield* DateTime.now);
  if (result._tag === "Failure") {
    const message = result.failure._tag === "SlackRateLimitedError" ? "Slack のレート制限にかかった。少し待ってからもう一度押してください" : result.failure.message;
    yield* db.insert(approvals).values({ ...record, status: "failed", error: message, executedAt }).pipe(Effect.orDie);
    return yield* new SlackWriteError({ message });
  }
  yield* db.insert(approvals).values({ ...record, status: "executed", executedAt }).pipe(Effect.orDie);
  const task = Option.getOrThrow(yield* tasks.findTask(taskId));
  const next = ACTIONS[action].status;
  if (task.status !== next) {
    yield* tasks.updateTask(taskId, { status: next });
    yield* tasks.recordChange(taskId, { kind: "field_changed", field: "status", before: task.status, after: next, unread: false, actor: "user" });
  }
});
