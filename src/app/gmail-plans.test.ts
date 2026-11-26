import { assert, describe, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { Database } from "../core/db/database.js";
import { gmailMessages, tasks } from "../core/db/schema.js";
import { TestDatabase } from "../core/db/test-database.js";
import { syncSource } from "../core/sync/sync-source.js";
import { decodePlan } from "../core/task/next-actions.js";
import { makeGmailSendersBinding } from "../sources/gmail/gmail-bindings.js";
import { applyGmailSenderPlans } from "./gmail-plans.js";

const NOW = Date.UTC(2026, 10, 26);
const insertMail = (messageId: string, overrides: Partial<typeof gmailMessages.$inferInsert> = {}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db
      .insert(gmailMessages)
      .values({ accountId: "me", messageId, threadId: messageId, senderKey: "news@shop.example", senderName: "Shop", subject: "x", receivedAt: NOW - 1000, kind: "newsletter", inInbox: true, unread: true, trashed: false, updatedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW)), ...overrides })
      .pipe(Effect.orDie);
  });
const planOfOnlyTask = Effect.gen(function* () {
  const db = yield* Database;
  const [row] = yield* db.select({ id: tasks.id, nextActions: tasks.nextActions }).from(tasks).pipe(Effect.orDie);
  return { id: row!.id, plan: Option.getOrThrow(decodePlan(row!.nextActions)) };
});

describe("applyGmailSenderPlans", () => {
  it.effect("次にやることのない送り主の Task に、確認済みにするかゴミ箱に入れる手順を入れる", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* insertMail("b");
      yield* syncSource(yield* makeGmailSendersBinding({ accountId: "me" }));

      yield* applyGmailSenderPlans("me");

      const { plan } = yield* planOfOnlyTask;
      assert.deepStrictEqual(plan.steps.map((step) => step.kind), ["process_mail"]);
      assert.include(plan.steps[0]!.title, "2 通");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("届いたメールの 8 割以上を片付けている送り主になったら、配信を続けるかの分かれ道を足す（手を付けた手順があれば触らない）", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      for (const id of ["b", "c", "d", "e"]) yield* insertMail(id, { trashed: true, inInbox: false });
      yield* syncSource(yield* makeGmailSendersBinding({ accountId: "me" }));
      yield* applyGmailSenderPlans("me");
      assert.deepStrictEqual((yield* planOfOnlyTask).plan.steps.map((step) => step.kind), ["process_mail", "decision"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("通数が変わったら手順のタイトルも合わせる", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* insertMail("b");
      const binding = yield* makeGmailSendersBinding({ accountId: "me" });
      yield* syncSource(binding);
      yield* applyGmailSenderPlans("me");
      const db = yield* Database;
      yield* db.update(gmailMessages).set({ trashed: true, inInbox: false }).where(eq(gmailMessages.messageId, "a")).pipe(Effect.orDie);
      yield* syncSource(binding);
      yield* applyGmailSenderPlans("me");
      assert.include((yield* planOfOnlyTask).plan.steps[0]!.title, "1 通");
    }).pipe(Effect.provide(TestDatabase)));
});
