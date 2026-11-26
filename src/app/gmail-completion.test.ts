import { assert, describe, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Database } from "../core/db/database.js";
import { approvals, gmailMessages } from "../core/db/schema.js";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { GmailClient } from "../sources/gmail/gmail-client.js";
import { gmailMessage, makeTestGmail } from "../sources/gmail/test-client.js";
import { archiveMailOfCompletedTasks } from "./gmail-completion.js";

const DAY = 24 * 60 * 60 * 1000;
const COMPLETED = Date.UTC(2026, 10, 25, 12);

const insertMail = (messageId: string, overrides: Partial<typeof gmailMessages.$inferInsert> = {}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db
      .insert(gmailMessages)
      .values({ accountId: "me", messageId, threadId: "t1", senderKey: "info@pia.example", senderName: "ぴあ", subject: "退会のご連絡", receivedAt: COMPLETED - DAY, kind: "notification", inInbox: true, unread: false, trashed: false, updatedAt: "2026-11-25T00:00:00.000Z", ...overrides })
      .pipe(Effect.orDie);
  });

const threadTask = (status: "todo" | "done") =>
  Effect.gen(function* () {
    const item = yield* (yield* SourceItemRepository).upsertItem({ source: "gmail:me:threads", externalId: "t1", title: "退会のご連絡", url: "https://mail.google.com/", state: "open", fingerprint: "v1" });
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: "ぴあ会員を続けるか決める", status: "todo" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    if (status === "done") {
      yield* TestClock.setTime(COMPLETED);
      yield* tasks.updateTask(task.id, { status: "done" });
      yield* tasks.recordChange(task.id, { kind: "field_changed", field: "status", before: "todo", after: "done", unread: false, actor: "user" });
    }
    return task.id;
  });

const setup = () => {
  const gmail = makeTestGmail([gmailMessage({ id: "a" }), gmailMessage({ id: "later" })]);
  return { gmail, layer: Layer.mergeAll(TestDatabase, Layer.succeed(GmailClient, gmail.client)) };
};

describe("archiveMailOfCompletedTasks（Gmail から作った Task を完了にしたら、メールも確認済みにする）", () => {
  it.effect("完了にした Task のスレッドで、受信トレイに残っているメールを確認済みにし、記録して手元も合わせる", () => {
    const { gmail, layer } = setup();
    return Effect.gen(function* () {
      yield* insertMail("a");
      const taskId = yield* threadTask("done");
      yield* TestClock.setTime(COMPLETED + DAY);

      yield* archiveMailOfCompletedTasks("me");

      assert.deepStrictEqual(gmail.state.archived, ["a"]);
      const db = yield* Database;
      const [record] = yield* db.select().from(approvals).pipe(Effect.orDie);
      assert.deepInclude(record, { taskId, action: "gmail_archive", status: "executed" });
      assert.deepInclude(record!.payload as object, { messageIds: ["a"], reason: "task_completed" });
      const [row] = yield* db.select().from(gmailMessages).where(eq(gmailMessages.messageId, "a")).pipe(Effect.orDie);
      assert.deepInclude(row, { inInbox: false, unread: false });
    }).pipe(Effect.provide(layer));
  });

  it.effect("完了にしたあとに届いたメールには触らない", () => {
    const { gmail, layer } = setup();
    return Effect.gen(function* () {
      yield* insertMail("later", { receivedAt: COMPLETED + 1000 });
      yield* threadTask("done");
      yield* TestClock.setTime(COMPLETED + DAY);
      yield* archiveMailOfCompletedTasks("me");
      assert.deepStrictEqual(gmail.state.archived, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("完了でない Task のメールには触らない。一度確認済みにしたら、次の回は何もしない", () => {
    const { gmail, layer } = setup();
    return Effect.gen(function* () {
      yield* insertMail("a");
      yield* threadTask("todo");
      yield* archiveMailOfCompletedTasks("me");
      assert.deepStrictEqual(gmail.state.archived, []);
    }).pipe(Effect.provide(layer));
  });
});
