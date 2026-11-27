import { assert, describe, it } from "@effect/vitest";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Database } from "../../core/db/database.js";
import { gmailMessages, gmailRuleRuns } from "../../core/db/schema.js";
import { TestDatabase } from "../../core/db/test-database.js";
import { MailClassifier } from "../../core/judge/mail-classifier.js";
import type { Rule } from "../../core/rules/rule.js";
import { GmailClient, GmailRequestError } from "./gmail-client.js";
import { applyGmailRules } from "./gmail-rule-runner.js";
import { gmailMessage, makeTestGmail } from "./test-client.js";

const NOW = Date.UTC(2026, 10, 26, 12);
const rule: Rule = {
  id: "r1",
  name: "請求書にレシートのラベル",
  enabled: true,
  createdAt: "2026-11-26T00:00:00.000Z",
  when: "請求書に関するメール",
  then: "レシート ラベルをつけて既読にする",
  actions: { gmail: { labels: ["レシート"], markRead: true } },
  interpretedFrom: "レシート ラベルをつけて既読にする",
};

const insertMail = (messageId: string, overrides: Partial<typeof gmailMessages.$inferInsert> = {}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db
      .insert(gmailMessages)
      .values({ accountId: "me", messageId, threadId: messageId, senderKey: "billing@shop.example", senderName: "Shop", subject: "ご請求", receivedAt: NOW - 1000, kind: "notification", topic: "billing", inInbox: true, unread: true, trashed: false, updatedAt: "2026-11-26T00:00:00.000Z", ...overrides })
      .pipe(Effect.orDie);
  });

const setup = (probabilityOf: (input: string) => number | undefined = (input) => (input.includes("請求") ? 0.95 : 0.1)) => {
  const gmail = makeTestGmail([gmailMessage({ id: "a" }), gmailMessage({ id: "b" })]);
  const asked: Array<{ input: string; condition: string }> = [];
  const classifier = MailClassifier.of({
    classify: () => Effect.die(new Error("使わない")),
    needsAction: () => Effect.die(new Error("使わない")),
    matchesCondition: (request) => Effect.sync(() => (asked.push(request), { probability: probabilityOf(request.input) })),
  });
  const layer = Layer.mergeAll(TestDatabase, Layer.succeed(GmailClient, gmail.client), Layer.succeed(MailClassifier, classifier));
  return { gmail, asked, layer };
};

const runs = Effect.gen(function* () {
  const db = yield* Database;
  return yield* db.select().from(gmailRuleRuns).orderBy(asc(gmailRuleRuns.messageId)).pipe(Effect.orDie);
});

describe("applyGmailRules（利用者が決めたルールをメールに当てる）", () => {
  it.effect("言葉で書いた条件に当てはまるかを判定し、当てはまるメールにだけラベル（なければ作る）を付けて既読にする", () => {
    const { gmail, asked, layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* insertMail("b", { subject: "新機能のお知らせ", topic: "product" });

      yield* applyGmailRules("me", [rule]);

      assert.deepStrictEqual(asked.map((request) => request.condition), ["請求書に関するメール", "請求書に関するメール"]);
      assert.deepStrictEqual(gmail.state.labels, [{ id: "Label_1", name: "レシート" }]);
      assert.deepStrictEqual(gmail.state.modified, [{ id: "a", add: ["Label_1"], remove: ["UNREAD"] }]);
      assert.deepStrictEqual((yield* runs).map((run) => [run.messageId, run.status, run.probability]), [["a", "executed", 0.95], ["b", "skipped", 0.1]]);
      const db = yield* Database;
      const [row] = yield* db.select().from(gmailMessages).where(eq(gmailMessages.messageId, "a")).pipe(Effect.orDie);
      assert.isFalse(row!.unread);
    }).pipe(Effect.provide(layer));
  });

  it.effect("判定に件名と差出人のアドレスを渡す", () => {
    const { asked, layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* applyGmailRules("me", [rule]);
      assert.include(asked[0]!.input, "ご請求");
      assert.include(asked[0]!.input, "billing@shop.example");
    }).pipe(Effect.provide(layer));
  });

  it.effect("同じメールを同じルールで二度判定しない（当てはまらなかったものも）。あるラベルは作り直さない", () => {
    const { gmail, asked, layer } = setup();
    gmail.state.labels.push({ id: "Label_9", name: "レシート" });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* insertMail("b", { subject: "新機能", topic: "product" });
      yield* applyGmailRules("me", [rule]);
      yield* applyGmailRules("me", [rule]);
      assert.lengthOf(asked, 2);
      assert.deepStrictEqual(gmail.state.modified, [{ id: "a", add: ["Label_9"], remove: ["UNREAD"] }]);
      assert.lengthOf(gmail.state.labels, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("判定が返らなければ当てない（自動で書き込むので、迷うものには当てない）", () => {
    const { gmail, layer } = setup(() => undefined);
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* applyGmailRules("me", [rule]);
      assert.lengthOf(gmail.state.modified, 0);
      assert.deepStrictEqual((yield* runs).map((run) => [run.status, run.probability]), [["skipped", null]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("今あるメールにも当てると決めたときは、ルールを作る前に届いたメールでも、受信トレイに残っているものだけ判定する", () => {
    const { gmail, asked, layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a", { receivedAt: Date.UTC(2026, 10, 22) });
      yield* insertMail("b", { receivedAt: Date.UTC(2026, 10, 22), inInbox: false });

      const result = yield* applyGmailRules("me", [rule], { includeExisting: rule.id });

      assert.strictEqual(result.applied, 1);
      assert.lengthOf(asked, 1);
      assert.deepStrictEqual(gmail.state.modified.map((entry) => entry.id), ["a"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("ルールの中身（どういう時・操作）を書き換えたら、前に判定したメールも判定し直す", () => {
    const { gmail, asked, layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* applyGmailRules("me", [rule]);
      const withArchive = { ...rule, then: "レシート ラベルをつけて既読にし、アーカイブする", interpretedFrom: "レシート ラベルをつけて既読にし、アーカイブする", actions: { gmail: { labels: ["レシート"], markRead: true, archive: true } } };
      yield* applyGmailRules("me", [withArchive]);
      assert.lengthOf(asked, 2);
      assert.deepStrictEqual(gmail.state.modified.map((entry) => entry.remove), [["UNREAD"], ["UNREAD", "INBOX"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("当てた結果の内訳（新しく当てた・すでに当ててある・当てはまらなかった）を返す", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* insertMail("b", { subject: "新機能", topic: "product" });
      assert.deepStrictEqual(yield* applyGmailRules("me", [rule], { includeExisting: rule.id }), { applied: 1, alreadyApplied: 0, notMatched: 1 });
      assert.deepStrictEqual(yield* applyGmailRules("me", [rule], { includeExisting: rule.id }), { applied: 0, alreadyApplied: 1, notMatched: 1 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("ルールを作る前に届いたメールは判定しない", () => {
    const { asked, layer } = setup();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a", { receivedAt: Date.UTC(2026, 10, 25) });
      yield* applyGmailRules("me", [rule]);
      assert.lengthOf(asked, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Gmail に書き込めなかったら失敗として記録し、ほかのメールは続ける（やり直さない）", () => {
    const { gmail, asked } = setup();
    const failing = { ...gmail.client, modifyLabels: (id: string, change: { add: ReadonlyArray<string>; remove: ReadonlyArray<string> }) => (id === "a" ? Effect.fail(new GmailRequestError({ message: "権限がない", status: 403 })) : gmail.client.modifyLabels(id, change)) };
    const classifier = MailClassifier.of({ classify: () => Effect.die(new Error("x")), needsAction: () => Effect.die(new Error("x")), matchesCondition: (request) => Effect.sync(() => (asked.push(request), { probability: 0.95 })) });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* insertMail("a");
      yield* insertMail("b");
      yield* applyGmailRules("me", [rule]);
      yield* applyGmailRules("me", [rule]);
      assert.deepStrictEqual((yield* runs).map((run) => [run.messageId, run.status]), [["a", "failed"], ["b", "executed"]]);
      assert.deepStrictEqual(gmail.state.modified.map((entry) => entry.id), ["b"]);
    }).pipe(Effect.provide(Layer.mergeAll(TestDatabase, Layer.succeed(GmailClient, failing), Layer.succeed(MailClassifier, classifier))));
  });
});
