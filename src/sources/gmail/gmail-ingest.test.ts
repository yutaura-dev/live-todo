import { assert, describe, it } from "@effect/vitest";
import { asc } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Database } from "../../core/db/database.js";
import { gmailMessages } from "../../core/db/schema.js";
import { TestDatabase } from "../../core/db/test-database.js";
import { type MailClassification, MailClassifier } from "../../core/judge/mail-classifier.js";
import { GmailClient, GmailRequestError } from "./gmail-client.js";
import { ingestGmail } from "./gmail-ingest.js";
import { gmailMessage, makeTestGmail } from "./test-client.js";

const NOW = Date.UTC(2026, 10, 26);

function setup(messages: Parameters<typeof makeTestGmail>[0], answer: (input: string) => MailClassification = () => ({ kind: "newsletter", probability: 0.9, method: "decisions" })) {
  const gmail = makeTestGmail(messages);
  const requests: Array<{ input: string; context: string }> = [];
  const classifier = Layer.succeed(MailClassifier, MailClassifier.of({ classify: (request) => Effect.sync(() => (requests.push(request), answer(request.input))) }));
  const layer = Layer.mergeAll(TestDatabase, classifier, Layer.succeed(GmailClient, gmail.client));
  return { gmail, requests, layer };
}

const stored = Effect.gen(function* () {
  const db = yield* Database;
  return yield* db.select().from(gmailMessages).orderBy(asc(gmailMessages.messageId)).pipe(Effect.orDie);
});

const run = ingestGmail({ accountId: "me" });

describe("ingestGmail（Gmail のメールを取り込んで仕分ける）", () => {
  it.effect("最初は直近のメールを取り込み、Decisions で仕分けた結果とラベルの状態を保存する", () => {
    const { layer } = setup([
      gmailMessage({ id: "a", labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], headers: { from: "Shop <news@shop.example>", subject: "セール", "list-unsubscribe": "<https://shop.example/u>" } }),
    ]);
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* run;

      const [row] = yield* stored;
      assert.deepInclude(row, {
        accountId: "me",
        messageId: "a",
        threadId: "t-a",
        senderKey: "news@shop.example",
        senderName: "Shop",
        subject: "セール",
        kind: "newsletter",
        probability: 0.9,
        method: "decisions",
        inInbox: true,
        unread: true,
        trashed: false,
        listUnsubscribe: "<https://shop.example/u>",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("最初の取り込みは直近 14 日に限る（送ったメールも含める）", () => {
    const { gmail, layer } = setup([]);
    return Effect.gen(function* () {
      yield* run;
      assert.deepStrictEqual(gmail.state.queries.filter((query) => query !== "in:inbox filename:ics"), ["newer_than:14d -in:drafts -in:chats"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("件名と差出人は評価対象に、Gmail のカテゴリや List-Unsubscribe の有無はアプリが書いた情報として渡す", () => {
    const { requests, layer } = setup([
      gmailMessage({ id: "a", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"], headers: { from: "Shop <news@shop.example>", subject: "セール", "list-unsubscribe": "<x>", precedence: "bulk" } }),
    ]);
    return Effect.gen(function* () {
      yield* run;
      const [request] = requests;
      assert.include(request!.input, "セール");
      assert.include(request!.input, "news@shop.example");
      assert.include(request!.context, "プロモーション");
      assert.include(request!.context, "List-Unsubscribe: あり");
      assert.include(request!.context, "Precedence: bulk");
    }).pipe(Effect.provide(layer));
  });

  it.effect("自分が送ったメールは仕分けずに mine として保存し、下書きは取り込まない", () => {
    const { requests, layer } = setup([gmailMessage({ id: "sent", labelIds: ["SENT"] }), gmailMessage({ id: "draft", labelIds: ["DRAFT"] })]);
    return Effect.gen(function* () {
      yield* run;
      const rows = yield* stored;
      assert.deepStrictEqual(rows.map((row) => [row.messageId, row.kind, row.probability]), [["sent", "mine", null]]);
      assert.lengthOf(requests, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("2 回目からは履歴の差分だけを見て、ラベルの変化（アーカイブ・既読・ゴミ箱）を反映し、仕分け直さない", () => {
    const { gmail, requests, layer } = setup([gmailMessage({ id: "a" }), gmailMessage({ id: "b" })]);
    return Effect.gen(function* () {
      yield* run;
      gmail.state.messages.set("a", gmailMessage({ id: "a", labelIds: ["TRASH"] }));
      gmail.state.messages.set("b", gmailMessage({ id: "b", labelIds: [] }));
      gmail.state.messages.set("c", gmailMessage({ id: "c" }));
      gmail.state.history = { historyId: "200", added: ["c"], labelsChanged: ["a", "b"], deleted: [] };
      gmail.state.fetched = [];

      yield* run;

      const rows = yield* stored;
      assert.deepStrictEqual(rows.map((row) => [row.messageId, row.inInbox, row.unread, row.trashed]), [
        ["a", false, false, true],
        ["b", false, false, false],
        ["c", true, true, false],
      ]);
      assert.sameMembers(gmail.state.fetched, ["a", "b", "c"]);
      assert.lengthOf(requests, 3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("完全に消えたメールは、ゴミ箱に入れたものとして扱う", () => {
    const { gmail, layer } = setup([gmailMessage({ id: "a" })]);
    return Effect.gen(function* () {
      yield* run;
      gmail.state.messages.delete("a");
      gmail.state.history = { historyId: "200", added: [], labelsChanged: [], deleted: ["a"] };
      yield* run;
      assert.isTrue((yield* stored)[0]!.trashed);
    }).pipe(Effect.provide(layer));
  });

  it.effect("履歴の起点が古すぎるときは、直近のメールを取り直す", () => {
    const { gmail, layer } = setup([gmailMessage({ id: "a" })]);
    return Effect.gen(function* () {
      yield* run;
      gmail.state.history = "expired";
      gmail.state.messages.set("b", gmailMessage({ id: "b" }));
      yield* run;
      assert.deepStrictEqual((yield* stored).map((row) => row.messageId), ["a", "b"]);
      assert.lengthOf(gmail.state.queries.filter((query) => query !== "in:inbox filename:ics"), 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("配信の解除の案内があるメールは、同じ送り主なら 1 回だけ仕分けて結果を使い回す（同じ回に届いた分も）", () => {
    const { requests, layer } = setup([gmailMessage({ id: "a", headers: { from: "Shop <news@shop.example>", subject: "セール", "list-unsubscribe": "<u>" } }), gmailMessage({ id: "b", headers: { from: "Shop <news@shop.example>", subject: "セール", "list-unsubscribe": "<u>" } }), gmailMessage({ id: "c", headers: { from: "Bank <info@bank.example>", subject: "お知らせ", "list-unsubscribe": "<u>" } })]);
    return Effect.gen(function* () {
      yield* run;
      assert.lengthOf(requests, 2);
      const rows = yield* stored;
      assert.deepStrictEqual(rows.map((row) => [row.messageId, row.kind]), [["a", "newsletter"], ["b", "newsletter"], ["c", "newsletter"]]);
      assert.sameMembers(rows.filter((row) => row.senderKey === "news@shop.example").map((row) => row.method), ["decisions", "sender"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("前に確かな確率で仕分けた送り主から新しく届いたメールは、仕分けずに前の結果を使う", () => {
    const { gmail, requests, layer } = setup([gmailMessage({ id: "a", headers: { from: "Shop <news@shop.example>", subject: "セール", "list-unsubscribe": "<u>" } })]);
    return Effect.gen(function* () {
      yield* run;
      gmail.state.messages.set("b", gmailMessage({ id: "b", headers: { from: "Shop <news@shop.example>", subject: "セール", "list-unsubscribe": "<u>" } }));
      gmail.state.history = { historyId: "200", added: ["b"], labelsChanged: [], deleted: [] };
      yield* run;
      assert.lengthOf(requests, 1);
      assert.deepInclude((yield* stored)[1], { messageId: "b", kind: "newsletter", method: "sender", probability: 0.9 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("前の判定の確率が低かった送り主は、仕分け直す", () => {
    const { gmail, requests, layer } = setup([gmailMessage({ id: "a" })], () => ({ kind: "personal", probability: undefined, method: "fallback" }));
    return Effect.gen(function* () {
      yield* run;
      gmail.state.messages.set("b", gmailMessage({ id: "b" }));
      gmail.state.history = { historyId: "200", added: ["b"], labelsChanged: [], deleted: [] };
      yield* run;
      assert.lengthOf(requests, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("同じ送り主でも、List-Unsubscribe の有無が前と違えば仕分け直す（代表アドレスから人のメールとお知らせが来るときなど）", () => {
    const { gmail, requests, layer } = setup([gmailMessage({ id: "a", headers: { from: "Shop <news@shop.example>", subject: "x", "list-unsubscribe": "<u>" } })]);
    return Effect.gen(function* () {
      yield* run;
      gmail.state.messages.set("b", gmailMessage({ id: "b", headers: { from: "Shop <news@shop.example>", subject: "ご注文について" } }));
      gmail.state.history = { historyId: "200", added: ["b"], labelsChanged: [], deleted: [] };
      yield* run;
      assert.lengthOf(requests, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("配信の解除の案内がないメールには、メルマガ・お知らせの結果を使い回さず 1 通ずつ仕分ける（同僚のカレンダー招待のあとの、人が書いたメールなど）", () => {
    const { gmail, requests, layer } = setup([gmailMessage({ id: "a" }), gmailMessage({ id: "b" })]);
    return Effect.gen(function* () {
      yield* run;
      assert.lengthOf(requests, 2);
      gmail.state.messages.set("c", gmailMessage({ id: "c" }));
      gmail.state.history = { historyId: "200", added: ["c"], labelsChanged: [], deleted: [] };
      yield* run;
      assert.lengthOf(requests, 3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("配信の解除の案内がないメールでも、前の結果が人からのメールなら使い回す（読む側に倒れるだけなので）", () => {
    const { gmail, requests, layer } = setup([gmailMessage({ id: "a" })], () => ({ kind: "personal", probability: 0.95, method: "decisions" }));
    return Effect.gen(function* () {
      yield* run;
      gmail.state.messages.set("b", gmailMessage({ id: "b" }));
      gmail.state.history = { historyId: "200", added: ["b"], labelsChanged: [], deleted: [] };
      yield* run;
      assert.lengthOf(requests, 1);
      assert.deepInclude((yield* stored)[1], { messageId: "b", kind: "personal", method: "sender" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("受信トレイの招待のメールは、予定のファイルを読んで、いつ終わるかを覚える（1 回だけ読む）", () => {
    const { gmail, layer } = setup([gmailMessage({ id: "invite" }), gmailMessage({ id: "plain" })]);
    gmail.state.calendars.set("invite", ["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "DTSTART:20261120T010000Z", "DTEND:20261120T020000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n"));
    return Effect.gen(function* () {
      yield* run;
      const rows = yield* stored;
      assert.deepStrictEqual(rows.map((row) => [row.messageId, row.inviteChecked, row.inviteState, row.inviteEndsAt]), [
        ["invite", true, "ends", Date.UTC(2026, 10, 20, 2)],
        ["plain", true, null, null],
      ]);
      assert.include(gmail.state.queries, "in:inbox filename:ics");
    }).pipe(Effect.provide(layer));
  });

  it.effect("招待の予定のファイルを読めなかったメールは、次の回にやり直し、ほかの取り込みは止めない", () => {
    const { gmail, layer } = setup([gmailMessage({ id: "a" })]);
    const failing = { ...gmail.client, calendar: () => Effect.fail(new GmailRequestError({ message: "x", status: 500 })) };
    return Effect.gen(function* () {
      yield* run.pipe(Effect.provideService(GmailClient, failing));
      assert.deepInclude((yield* stored)[0], { messageId: "a", inviteChecked: false });
    }).pipe(Effect.provide(layer));
  });

  it.effect("最初の取り込みの範囲より前に届いた招待でも、受信トレイに残っていれば取り込む（日程が過ぎたら片付けを勧めるため）", () => {
    const { gmail, layer } = setup([]);
    return Effect.gen(function* () {
      yield* run;
      gmail.state.messages.set("old-invite", gmailMessage({ id: "old-invite" }));
      const originalList = gmail.client.listMessages;
      const listing = { ...gmail.client, listMessages: (query: string, pageToken?: string) => (query === "in:inbox filename:ics" ? originalList(query, pageToken) : Effect.succeed({ ids: [], nextPageToken: undefined })) };
      yield* run.pipe(Effect.provideService(GmailClient, listing));
      assert.deepStrictEqual((yield* stored).map((row) => row.messageId), ["old-invite"]);
    }).pipe(Effect.provide(layer));
  });
});
