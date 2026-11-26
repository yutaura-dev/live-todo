import { assert, describe, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { Database } from "../core/db/database.js";
import { approvals, gmailMessages } from "../core/db/schema.js";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { GmailRequestError } from "../sources/gmail/gmail-client.js";
import { makeTestGmail } from "../sources/gmail/test-client.js";
import { gmailMailTarget, gmailProcess, gmailRunStep } from "./gmail-write.js";

const insertMail = (messageId: string, overrides: Partial<typeof gmailMessages.$inferInsert> = {}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db
      .insert(gmailMessages)
      .values({
        accountId: "me",
        messageId,
        threadId: "t1",
        senderKey: "news@shop.example",
        senderName: "Shop",
        subject: "セール",
        receivedAt: 1,
        kind: "newsletter",
        inInbox: true,
        unread: true,
        trashed: false,
        updatedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
        ...overrides,
      })
      .pipe(Effect.orDie);
  });

const linkedTask = (source: string, externalId: string) =>
  Effect.gen(function* () {
    const item = yield* (yield* SourceItemRepository).upsertItem({ source, externalId, title: "Shop のメルマガ（未処理 2 通）", url: "https://mail.google.com/", state: "open", fingerprint: "v1" });
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: item.title, status: "todo" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    yield* (yield* SourceItemRepository).setTriage(item.id, "linked");
    return task.id;
  });

const trashedIds = Effect.gen(function* () {
  const db = yield* Database;
  return (yield* db.select().from(gmailMessages).where(eq(gmailMessages.trashed, true)).pipe(Effect.orDie)).map((row) => row.messageId).toSorted();
});

describe("gmailMailTarget（ゴミ箱に入れるメールを、承認の前に見せる）", () => {
  it.effect("日程が過ぎた招待には、その印を付ける", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 10, 26));
      yield* insertMail("past", { inviteChecked: true, inviteState: "ends", inviteEndsAt: 1 });
      yield* insertMail("future", { inviteChecked: true, inviteState: "ends", inviteEndsAt: Date.UTC(2099, 0, 1) });
      const taskId = yield* linkedTask("gmail:me:senders", "news@shop.example");

      const target = yield* gmailMailTarget(taskId);

      assert.sameDeepMembers(target.messages.map((message) => [message.messageId, message.pastInvite]), [["past", true], ["future", false]]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("送り主の Task なら、受信トレイに残っているそのメールを返す", () =>
    Effect.gen(function* () {
      yield* insertMail("a", { subject: "セール 1" });
      yield* insertMail("b", { subject: "セール 2" });
      yield* insertMail("done", { inInbox: false });
      yield* insertMail("other", { senderKey: "x@y.example" });
      const taskId = yield* linkedTask("gmail:me:senders", "news@shop.example");

      const target = yield* gmailMailTarget(taskId);

      assert.deepStrictEqual(target.messages.map((message) => [message.messageId, message.subject]), [["a", "セール 1"], ["b", "セール 2"]]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("スレッドの Task なら、そのスレッドのゴミ箱に入っていないメールを返す", () =>
    Effect.gen(function* () {
      yield* insertMail("a", { kind: "personal", threadId: "t1", inInbox: false });
      yield* insertMail("b", { kind: "mine", threadId: "t1" });
      yield* insertMail("c", { kind: "personal", threadId: "t2" });
      const taskId = yield* linkedTask("gmail:me:threads", "t1");

      assert.deepStrictEqual((yield* gmailMailTarget(taskId)).messages.map((message) => message.messageId), ["a", "b"]);
    }).pipe(Effect.provide(TestDatabase)));
});

describe("gmailProcess（承認したメールを確認済みにする・ゴミ箱に入れる）", () => {
  it.effect("確認済みにすると、アーカイブして既読にし（読んだメールとして数える）、残りがなければ Task を済みにする", () => {
    const gmail = makeTestGmail();
    return Effect.gen(function* () {
      yield* insertMail("a");
      const taskId = yield* linkedTask("gmail:me:senders", "news@shop.example");

      yield* gmailProcess(taskId, "archive", ["a"], () => Effect.succeed(gmail.client));

      assert.deepStrictEqual(gmail.state.archived, ["a"]);
      assert.deepStrictEqual(gmail.state.trashed, []);
      const db = yield* Database;
      const [row] = yield* db.select().from(gmailMessages).pipe(Effect.orDie);
      assert.deepInclude(row, { inInbox: false, unread: false, trashed: false });
      assert.deepInclude((yield* db.select().from(approvals).pipe(Effect.orDie))[0], { action: "gmail_archive", status: "executed" });
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "done");
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("スレッドの Task は、受信トレイに残っているメールがなくなれば済みにする", () => {
    const gmail = makeTestGmail();
    return Effect.gen(function* () {
      yield* insertMail("a", { kind: "personal", threadId: "t1" });
      yield* insertMail("b", { kind: "mine", threadId: "t1", inInbox: false });
      const taskId = yield* linkedTask("gmail:me:threads", "t1");
      yield* gmailProcess(taskId, "archive", ["a", "b"], () => Effect.succeed(gmail.client));
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "done");
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("承認したメールだけをゴミ箱に入れて記録し、残りがなければ Task を済みにする", () => {
    const gmail = makeTestGmail();
    return Effect.gen(function* () {
      yield* insertMail("a");
      yield* insertMail("b");
      const taskId = yield* linkedTask("gmail:me:senders", "news@shop.example");

      yield* gmailProcess(taskId, "trash", ["a", "b"], () => Effect.succeed(gmail.client));

      assert.deepStrictEqual(gmail.state.trashed, ["a", "b"]);
      assert.deepStrictEqual(yield* trashedIds, ["a", "b"]);
      const db = yield* Database;
      const [record] = yield* db.select().from(approvals).pipe(Effect.orDie);
      assert.deepInclude(record, { taskId, action: "gmail_trash", status: "executed" });
      assert.deepStrictEqual(record!.payload, { messageIds: ["a", "b"] });
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "done");
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("承認のあとに届いたメール（見せていないもの）はゴミ箱に入れず、Task は開いたままにする", () => {
    const gmail = makeTestGmail();
    return Effect.gen(function* () {
      yield* insertMail("a");
      yield* insertMail("new");
      const taskId = yield* linkedTask("gmail:me:senders", "news@shop.example");

      yield* gmailProcess(taskId, "trash", ["a", "elsewhere"], () => Effect.succeed(gmail.client));

      assert.deepStrictEqual(gmail.state.trashed, ["a"]);
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "todo");
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("途中で失敗したら、そこで止めて失敗を記録し、入れられた分だけを反映する（やり直さない）", () => {
    const gmail = makeTestGmail();
    const client = { ...gmail.client, trash: (id: string) => (id === "b" ? Effect.fail(new GmailRequestError({ message: "権限がない", status: 403 })) : gmail.client.trash(id)) };
    return Effect.gen(function* () {
      yield* insertMail("a");
      yield* insertMail("b");
      yield* insertMail("c");
      const taskId = yield* linkedTask("gmail:me:senders", "news@shop.example");

      const error = yield* gmailProcess(taskId, "trash", ["a", "b", "c"], () => Effect.succeed(client)).pipe(Effect.flip);

      assert.include(error.message, "権限");
      assert.deepStrictEqual(yield* trashedIds, ["a"]);
      const db = yield* Database;
      assert.strictEqual((yield* db.select().from(approvals).pipe(Effect.orDie))[0]?.status, "failed");
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("Gmail の Task でなければエラーにする", () =>
    Effect.gen(function* () {
      const taskId = yield* linkedTask("slack:home", "C1:1.1");
      const error = yield* gmailProcess(taskId, "trash", ["a"], () => Effect.succeed(makeTestGmail().client)).pipe(Effect.flip);
      assert.include(error.message, "Gmail");
    }).pipe(Effect.provide(TestDatabase)));
});
describe("gmailRunStep（Gmail の操作の手順を、押したときにアプリが行う）", () => {
  it.effect("手順の操作（ラベル・既読・アーカイブ）を承認したメールに行い、記録して、手順を済みにする", () => {
    const gmail = makeTestGmail();
    return Effect.gen(function* () {
      yield* insertMail("a");
      const taskId = yield* linkedTask("gmail:me:senders", "news@shop.example");
      const tasks = yield* TaskRepository;
      yield* tasks.updateTask(taskId, {
        nextActions: { steps: [{ id: "s1", kind: "gmail_action", title: "レシートを付けてアーカイブ", effort: "easy", mode: "serial", status: "todo", gmail: { labels: ["レシート"], markRead: true, archive: true } }] },
      });

      yield* gmailRunStep(taskId, "s1", ["a"], () => Effect.succeed(gmail.client));

      assert.deepStrictEqual(gmail.state.labels, [{ id: "Label_1", name: "レシート" }]);
      assert.deepStrictEqual(gmail.state.modified, [{ id: "a", add: ["Label_1"], remove: ["UNREAD", "INBOX"] }]);
      const db = yield* Database;
      assert.deepInclude((yield* db.select().from(approvals).pipe(Effect.orDie))[0], { action: "gmail_actions", status: "executed" });
      const task = Option.getOrThrow(yield* tasks.findTask(taskId));
      assert.strictEqual(task.status, "done");
    }).pipe(Effect.provide(TestDatabase));
  });

  it.effect("Gmail の操作の手順でなければ、何もしない", () =>
    Effect.gen(function* () {
      const taskId = yield* linkedTask("gmail:me:senders", "news@shop.example");
      yield* (yield* TaskRepository).updateTask(taskId, { nextActions: { steps: [{ id: "s1", kind: "manual", title: "x", effort: "easy", mode: "serial", status: "todo" }] } });
      const error = yield* gmailRunStep(taskId, "s1", [], () => Effect.succeed(makeTestGmail().client)).pipe(Effect.flip);
      assert.include(error.message, "Gmail の操作");
    }).pipe(Effect.provide(TestDatabase)));
});
