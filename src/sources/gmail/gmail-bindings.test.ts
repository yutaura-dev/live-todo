import { assert, describe, it } from "@effect/vitest";
import { and, eq } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { Database } from "../../core/db/database.js";
import { gmailMessages, sourceItems, taskLinks, tasks } from "../../core/db/schema.js";
import { TestDatabase } from "../../core/db/test-database.js";
import { SourceItemRepository } from "../../core/source/source-item-repository.js";
import { syncSource } from "../../core/sync/sync-source.js";
import { gmailSendersSource, gmailThreadsSource, makeGmailSendersBinding, makeGmailThreadsBinding, refreshSenderBriefs } from "./gmail-bindings.js";

const NOW = Date.UTC(2026, 10, 26);
const DAY = 24 * 60 * 60 * 1000;

const insertMail = (overrides: Partial<typeof gmailMessages.$inferInsert> & { messageId: string }) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db
      .insert(gmailMessages)
      .values({
        accountId: "me",
        threadId: `t-${overrides.messageId}`,
        senderKey: "news@shop.example",
        senderName: "Shop",
        subject: "件名",
        receivedAt: NOW - DAY,
        kind: "newsletter",
        inInbox: true,
        unread: true,
        trashed: false,
        updatedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW)),
        ...overrides,
      })
      .pipe(Effect.orDie);
  });

const setTrashed = (messageId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db.update(gmailMessages).set({ trashed: true, inInbox: false }).where(eq(gmailMessages.messageId, messageId)).pipe(Effect.orDie);
  });

const taskOf = (source: string, externalId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({ title: tasks.title, status: tasks.status })
      .from(tasks)
      .innerJoin(taskLinks, eq(taskLinks.taskId, tasks.id))
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(and(eq(sourceItems.source, source), eq(sourceItems.externalId, externalId)))
      .pipe(Effect.orDie);
    return Option.fromNullishOr(row);
  });

describe("makeGmailSendersBinding（メルマガ・お知らせを送り主ごとの Task にする）", () => {
  it.effect("未処理のメールがある送り主ごとに 1 つの Task を作り、タイトルに最新の件名とほかの通数を出す", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail({ messageId: "a", subject: "冬のセール", receivedAt: NOW - 2 * DAY });
      yield* insertMail({ messageId: "b", subject: "新商品のご案内", receivedAt: NOW - DAY });
      yield* insertMail({ messageId: "c", senderKey: "info@bank.example", senderName: "銀行", kind: "notification", subject: "お取引のお知らせ" });

      yield* syncSource(yield* makeGmailSendersBinding({ accountId: "me" }));

      assert.deepStrictEqual(Option.getOrThrow(yield* taskOf(gmailSendersSource("me"), "news@shop.example")), { title: "Shop のメルマガ: 新商品のご案内（ほか 1 通）", status: "todo" });
      assert.deepStrictEqual(Option.getOrThrow(yield* taskOf(gmailSendersSource("me"), "info@bank.example")), { title: "銀行 のお知らせ: お取引のお知らせ", status: "todo" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("長い件名は切り詰める", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail({ messageId: "a", subject: "あ".repeat(100) });
      yield* syncSource(yield* makeGmailSendersBinding({ accountId: "me" }));
      const title = Option.getOrThrow(yield* taskOf(gmailSendersSource("me"), "news@shop.example")).title;
      assert.isAtMost(title.length, 80);
      assert.isTrue(title.endsWith("…"));
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("Task の状況に、受信トレイに残っているメールの件名を新しい順に並べ、変われば書き直す", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail({ messageId: "a", subject: "冬のセール", receivedAt: NOW - 2 * DAY });
      yield* insertMail({ messageId: "b", subject: "新商品のご案内", receivedAt: NOW - DAY });
      yield* syncSource(yield* makeGmailSendersBinding({ accountId: "me" }));
      yield* refreshSenderBriefs("me");
      const briefOf = Effect.gen(function* () {
        const db = yield* Database;
        const [row] = yield* db.select({ brief: tasks.brief }).from(tasks).pipe(Effect.orDie);
        return row?.brief;
      });
      assert.strictEqual(yield* briefOf, "受信トレイに残っているメール（新しい順）:\n- 11/25 新商品のご案内\n- 11/24 冬のセール");

      yield* setTrashed("b");
      yield* refreshSenderBriefs("me");
      assert.strictEqual(yield* briefOf, "受信トレイに残っているメール（新しい順）:\n- 11/24 冬のセール");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("未処理が減るとタイトルが変わり、なくなると Task は済みになる", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail({ messageId: "a", receivedAt: NOW - 2 * DAY });
      yield* insertMail({ messageId: "b", receivedAt: NOW - DAY });
      const binding = yield* makeGmailSendersBinding({ accountId: "me" });
      yield* syncSource(binding);

      yield* setTrashed("a");
      yield* syncSource(binding);
      assert.strictEqual(Option.getOrThrow(yield* taskOf(gmailSendersSource("me"), "news@shop.example")).title, "Shop のメルマガ: 件名");

      yield* setTrashed("b");
      yield* syncSource(binding);
      assert.strictEqual(Option.getOrThrow(yield* taskOf(gmailSendersSource("me"), "news@shop.example")).status, "done");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("人からのメールや、ほかのアカウントのメールはまとめない", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail({ messageId: "a", kind: "personal" });
      yield* insertMail({ messageId: "b", accountId: "other" });
      yield* syncSource(yield* makeGmailSendersBinding({ accountId: "me" }));
      const items = yield* SourceItemRepository;
      assert.isTrue(Option.isNone(yield* items.findItem(gmailSendersSource("me"), "news@shop.example")));
    }).pipe(Effect.provide(TestDatabase)));
});

describe("makeGmailThreadsBinding（人からのメールをスレッドごとに取り込む）", () => {
  it.effect("人からのメールのスレッドを、Task にせず仕分けを保留にして取り込む（あとで Claude Code が読む）", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail({ messageId: "a", threadId: "t1", kind: "personal", subject: "打ち合わせの件" });
      yield* syncSource(yield* makeGmailThreadsBinding({ accountId: "me" }));

      const items = yield* SourceItemRepository;
      const item = Option.getOrThrow(yield* items.findItem(gmailThreadsSource("me"), "t1"));
      assert.deepInclude(item, { title: "打ち合わせの件", state: "open", triage: "pending" });
      assert.include(item.url, "t1");
      assert.isTrue(Option.isNone(yield* taskOf(gmailThreadsSource("me"), "t1")));
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("自分が返信したスレッドは済みにする", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail({ messageId: "a", threadId: "t1", kind: "personal", receivedAt: NOW - 2 * DAY });
      yield* insertMail({ messageId: "b", threadId: "t1", kind: "mine", inInbox: false });
      yield* syncSource(yield* makeGmailThreadsBinding({ accountId: "me" }));
      const items = yield* SourceItemRepository;
      assert.strictEqual(Option.getOrThrow(yield* items.findItem(gmailThreadsSource("me"), "t1")).state, "resolved");
    }).pipe(Effect.provide(TestDatabase)));
});
