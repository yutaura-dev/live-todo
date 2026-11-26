import { assert, describe, it } from "@effect/vitest";
import { personalThreads, senderGroups, senderKeyOf, senderNameOf, type StoredMail } from "./gmail-mailbox.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 26);
const mail = (overrides: Partial<StoredMail>): StoredMail => ({
  messageId: "m",
  threadId: "t",
  senderKey: "news@shop.example",
  senderName: "Shop",
  subject: "件名",
  receivedAt: NOW - DAY,
  kind: "newsletter",
  inInbox: true,
  unread: true,
  trashed: false,
  ...overrides,
});

describe("senderKeyOf / senderNameOf（送り主の見分け方）", () => {
  it("List-Id があればそれで、なければ差出人のアドレスで見分ける（小文字にそろえる）", () => {
    assert.strictEqual(senderKeyOf({ from: "Shop <News@Shop.example>", "list-id": "Shop News <news.shop.example>" }), "news.shop.example");
    assert.strictEqual(senderKeyOf({ from: "Shop <News@Shop.example>" }), "news@shop.example");
    assert.strictEqual(senderKeyOf({ from: "news@shop.example" }), "news@shop.example");
  });

  it("名前は差出人の表示名、なければアドレス", () => {
    assert.strictEqual(senderNameOf({ from: '"Shop 公式" <news@shop.example>' }), "Shop 公式");
    assert.strictEqual(senderNameOf({ from: "news@shop.example" }), "news@shop.example");
    assert.strictEqual(senderNameOf({}), "（差出人なし）");
  });
});

describe("senderGroups（メルマガ・お知らせを送り主ごとにまとめる）", () => {
  it("受信トレイに残っていてゴミ箱に入っていないものを、未処理として数える", () => {
    const [group] = senderGroups(
      [mail({ messageId: "a" }), mail({ messageId: "b", inInbox: false, unread: false }), mail({ messageId: "c", trashed: true })],
      NOW,
    );
    assert.deepInclude(group, { senderKey: "news@shop.example", senderName: "Shop", kind: "newsletter", pending: ["a"] });
  });

  it("人からのメール・自分のメールはまとめない", () => {
    assert.deepStrictEqual(senderGroups([mail({ kind: "personal" }), mail({ kind: "mine" })], NOW), []);
  });

  it("直近 60 日に届いた数と、削除した（ゴミ箱）・読まずにアーカイブした数を数える", () => {
    const [group] = senderGroups(
      [
        mail({ messageId: "a", trashed: true }),
        mail({ messageId: "b", inInbox: false, unread: true }),
        mail({ messageId: "c", inInbox: false, unread: false }),
        mail({ messageId: "d" }),
        mail({ messageId: "old", trashed: true, receivedAt: NOW - 61 * DAY }),
      ],
      NOW,
    );
    assert.deepInclude(group, { received: 4, discarded: 2 });
  });

  it("5 通以上届き、8 割以上を削除・読まずにアーカイブした送り主には、配信の解除を勧める", () => {
    const five = (discarded: number) =>
      Array.from({ length: 5 }, (_, index) => mail({ messageId: String(index), trashed: index < discarded, inInbox: index >= discarded }));
    assert.isTrue(senderGroups(five(4), NOW)[0]!.suggestUnsubscribe);
    assert.isFalse(senderGroups(five(3), NOW)[0]!.suggestUnsubscribe);
    assert.isFalse(senderGroups(five(4).slice(0, 4), NOW)[0]!.suggestUnsubscribe);
  });

  it("名前は最新のメールのものを使い、お知らせとメルマガが混ざるなら多い方にする", () => {
    const [group] = senderGroups(
      [mail({ messageId: "a", kind: "notification", senderName: "旧名", receivedAt: NOW - 3 * DAY }), mail({ messageId: "b", kind: "notification", receivedAt: NOW - 2 * DAY }), mail({ messageId: "c", senderName: "新名" })],
      NOW,
    );
    assert.deepInclude(group, { senderName: "新名", kind: "notification" });
  });
});

describe("personalThreads（人からのメールをスレッドごとにまとめる）", () => {
  it("人からのメールがあるスレッドだけを、最新の件名でまとめる", () => {
    const threads = personalThreads([
      mail({ messageId: "a", threadId: "t1", kind: "personal", subject: "相談", receivedAt: NOW - 2 * DAY }),
      mail({ messageId: "b", threadId: "t1", kind: "personal", subject: "Re: 相談" }),
      mail({ messageId: "c", threadId: "t2", kind: "newsletter" }),
    ]);
    assert.deepStrictEqual(
      threads.map((thread) => [thread.threadId, thread.subject, thread.messageIds]),
      [["t1", "Re: 相談", ["a", "b"]]],
    );
  });

  it("受信トレイに残っていて、最後のメールが自分のものでなければ未対応（open）", () => {
    const [open] = personalThreads([mail({ threadId: "t1", kind: "personal" })]);
    assert.isTrue(open!.open);
  });

  it("自分が最後に返信した、アーカイブした、ゴミ箱に入れたスレッドは済み", () => {
    const replied = personalThreads([mail({ messageId: "a", kind: "personal", receivedAt: NOW - DAY }), mail({ messageId: "b", kind: "mine", receivedAt: NOW, inInbox: false })]);
    const archived = personalThreads([mail({ kind: "personal", inInbox: false })]);
    const trashed = personalThreads([mail({ kind: "personal", trashed: true })]);
    assert.deepStrictEqual([replied[0]!.open, archived[0]!.open, trashed[0]!.open], [false, false, false]);
  });
});
