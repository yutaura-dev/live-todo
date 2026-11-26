import { and, desc, eq, inArray, like, lt } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { Database } from "../core/db/database.js";
import { approvals, gmailMessages, sourceItems, taskChanges, taskLinks, tasks } from "../core/db/schema.js";
import { GmailClient } from "../sources/gmail/gmail-client.js";

/**
 * Gmail から作った Task を完了にしたら、そのメールも Gmail で確認済み（アーカイブして既読）にする。
 * 完了にした操作を、そのメールを確認済みにする承認とみなす（ドロワーに書いてある）。完了にした手段（手順を済ませる・カードを
 * 動かす）を問わないよう、同期のたびに拾う。完了にしたあとに届いたメールは、まだ見ていないので触らない
 */
export const archiveMailOfCompletedTasks = Effect.fnUntraced(function* (accountId: string) {
  const db = yield* Database;
  const client = yield* GmailClient;
  const rows = yield* db
    .select({ taskId: tasks.id, threadId: sourceItems.externalId })
    .from(taskLinks)
    .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(tasks.status, "done"), eq(taskLinks.role, "tracks"), like(sourceItems.source, `gmail:${accountId}:threads`)))
    .pipe(Effect.orDie);

  let archived = 0;
  for (const row of rows) {
    const [completion] = yield* db
      .select({ at: taskChanges.occurredAt })
      .from(taskChanges)
      .where(and(eq(taskChanges.taskId, row.taskId), eq(taskChanges.field, "status"), eq(taskChanges.after, "done")))
      .orderBy(desc(taskChanges.id))
      .limit(1)
      .pipe(Effect.orDie);
    if (completion === undefined) continue;
    const completedAt = Date.parse(completion.at);
    const mails = yield* db
      .select({ messageId: gmailMessages.messageId })
      .from(gmailMessages)
      .where(
        and(
          eq(gmailMessages.accountId, accountId),
          eq(gmailMessages.threadId, row.threadId),
          eq(gmailMessages.inInbox, true),
          eq(gmailMessages.trashed, false),
          lt(gmailMessages.receivedAt, completedAt),
        ),
      )
      .pipe(Effect.orDie);
    if (mails.length === 0) continue;

    const done: string[] = [];
    let failure: string | undefined;
    for (const { messageId } of mails) {
      const result = yield* client.archive(messageId).pipe(Effect.result);
      if (result._tag === "Failure") {
        failure = result.failure._tag === "GmailRequestError" ? result.failure.message : "Gmail に書き込めなかった";
        break;
      }
      done.push(messageId);
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    if (done.length > 0) {
      yield* db
        .update(gmailMessages)
        .set({ inInbox: false, unread: false, updatedAt: now })
        .where(and(eq(gmailMessages.accountId, accountId), inArray(gmailMessages.messageId, done)))
        .pipe(Effect.orDie);
    }
    yield* db
      .insert(approvals)
      .values({
        taskId: row.taskId,
        action: "gmail_archive",
        target: `gmail:${accountId}:threads ${row.threadId}`,
        payload: { messageIds: done, reason: "task_completed" },
        status: failure === undefined ? "executed" : "failed",
        ...(failure === undefined ? {} : { error: failure }),
        approvedAt: completion.at,
        executedAt: now,
      })
      .pipe(Effect.orDie);
    archived += done.length;
  }
  return archived;
});
