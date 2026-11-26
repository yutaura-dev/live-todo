import { assert, describe, it } from "@effect/vitest";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Database } from "../../core/db/database.js";
import { gmailMessages, gmailRuleRuns } from "../../core/db/schema.js";
import { TestDatabase } from "../../core/db/test-database.js";
import { GmailClient, GmailRequestError } from "./gmail-client.js";
import { applyGmailRules } from "./gmail-rule-runner.js";
import type { GmailRule } from "./gmail-rules.js";
import { gmailMessage, makeTestGmail } from "./test-client.js";

const NOW = Date.UTC(2026, 10, 26, 12);
const rule: GmailRule = {
  id: "r1",
  name: "請求書にレシートのラベル",
  enabled: true,
  createdAt: "2026-11-26T00:00:00.000Z",
  when: { topics: ["billing"] },
  then: { labels: ["レシート"], markRead: true },
};

const insertMail = (messageId: string, overrides: Partial<typeof gmailMessages.$inferInsert> = {}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db
      .insert(gmailMessages)
      .values({ accountId: "me", messageId, threadId: messageId, senderKey: "billing@shop.example", senderName: "Shop", subject: "ご請求", receivedAt: NOW - 1000, kind: "notification", topic: "billing", inInbox: true, unread: true, trashed: false, updatedAt: "2026-11-26T00:00:00.000Z", ...overrides })
      .pipe(Effect.orDie);
  });

const setup = () => {
  const gmail = makeTestGmail([gmailMessage({ id: "a" }), gmailMessage({ id: "b" })]);
  return { gmail, layer: Layer.mergeAll(TestDatabase, Layer.succeed(GmailClient, gmail.client)) };
};

describe("applyGmailRules（利用者が決めたルールをメールに当てる）", () => {
  it.effect("条件に合うメールにラベル（なければ作る）を付けて既読にし、何をしたかを記録して、手元の状態も合わせる", () => {
    const { gmail, layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* insertMail("b", { topic: "product" });

      yield* applyGmailRules("me", [rule]);

      assert.deepStrictEqual(gmail.state.labels, [{ id: "Label_1", name: "レシート" }]);
      assert.deepStrictEqual(gmail.state.modified, [{ id: "a", add: ["Label_1"], remove: ["UNREAD"] }]);
      const db = yield* Database;
      const runs = yield* db.select().from(gmailRuleRuns).pipe(Effect.orDie);
      assert.deepInclude(runs[0], { messageId: "a", ruleId: "r1", ruleName: "請求書にレシートのラベル", status: "executed" });
      const [row] = yield* db.select().from(gmailMessages).where(eq(gmailMessages.messageId, "a")).pipe(Effect.orDie);
      assert.isFalse(row!.unread);
    }).pipe(Effect.provide(layer));
  });

  it.effect("同じメールに同じルールを二度当てない。あるラベルは作り直さない", () => {
    const { gmail, layer } = setup();
    gmail.state.labels.push({ id: "Label_9", name: "レシート" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* applyGmailRules("me", [rule]);
      yield* applyGmailRules("me", [rule]);
      assert.deepStrictEqual(gmail.state.modified, [{ id: "a", add: ["Label_9"], remove: ["UNREAD"] }]);
      assert.lengthOf(gmail.state.labels, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("アーカイブするルールでは受信トレイから外し、手元でも受信トレイにないものにする", () => {
    const { gmail, layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* applyGmailRules("me", [{ ...rule, then: { archive: true } }]);
      assert.deepStrictEqual(gmail.state.modified[0]!.remove, ["INBOX"]);
      const db = yield* Database;
      assert.isFalse((yield* db.select().from(gmailMessages).orderBy(asc(gmailMessages.id)).pipe(Effect.orDie))[0]!.inInbox);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Gmail に書き込めなかったら失敗として記録し、ほかのメールは続ける（次の回にやり直さない）", () => {
    const { gmail } = setup();
    const failing = { ...gmail.client, modifyLabels: (id: string, change: { add: ReadonlyArray<string>; remove: ReadonlyArray<string> }) => (id === "a" ? Effect.fail(new GmailRequestError({ message: "権限がない", status: 403 })) : gmail.client.modifyLabels(id, change)) };
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* insertMail("b");
      yield* applyGmailRules("me", [rule]);
      yield* applyGmailRules("me", [rule]);
      const db = yield* Database;
      const runs = yield* db.select().from(gmailRuleRuns).orderBy(asc(gmailRuleRuns.messageId)).pipe(Effect.orDie);
      assert.deepStrictEqual(runs.map((run) => [run.messageId, run.status]), [["a", "failed"], ["b", "executed"]]);
      assert.deepStrictEqual(gmail.state.modified.map((entry) => entry.id), ["b"]);
    }).pipe(Effect.provide(Layer.mergeAll(TestDatabase, Layer.succeed(GmailClient, failing))));
  });
});
