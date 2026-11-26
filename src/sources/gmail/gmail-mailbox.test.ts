import { assert, describe, it } from "@effect/vitest";
import { effectiveKind, isPastInvite, personalThreads, senderGroups, senderKeyOf, senderNameOf, type StoredMail } from "./gmail-mailbox.js";

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
  pastInvite: false,
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

describe("senderGroups（メルマガ・お知らせを送り主と用件ごとにまとめる）", () => {
  it("同じ送り主でも、用件が違えば別のまとまりにする（判定していない用件は「その他」）", () => {
    const groups = senderGroups([mail({ messageId: "a", topic: "billing" }), mail({ messageId: "b", topic: "product" }), mail({ messageId: "c", topic: "billing" }), mail({ messageId: "d" })], NOW);
    assert.sameDeepMembers(
      groups.map((group) => [group.groupKey, group.topic, group.pending]),
      [
        ["news@shop.example#billing", "billing", ["a", "c"]],
        ["news@shop.example#product", "product", ["b"]],
        ["news@shop.example#other", "other", ["d"]],
      ],
    );
  });

  it("配信の解除を勧めるかは、用件ではなく送り主の全体で数える", () => {
    const mails = Array.from({ length: 5 }, (_, index) => mail({ messageId: String(index), topic: index === 0 ? "promotion" : "news", trashed: index < 4, inInbox: index >= 4 }));
    assert.isTrue(senderGroups(mails, NOW).every((group) => group.received === 5 && group.suggestUnsubscribe));
  });

  it("受信トレイに残っていてゴミ箱に入っていないものを、未処理として数える", () => {
    const [group] = senderGroups(
      [mail({ messageId: "a" }), mail({ messageId: "b", inInbox: false, unread: false }), mail({ messageId: "c", trashed: true })],
      NOW,
    );
    assert.deepInclude(group, { senderKey: "news@shop.example", senderName: "Shop", kind: "newsletter", pending: ["a"] });
  });

  it("受信トレイに残っているメールの件名を、新しい順に持つ", () => {
    const [group] = senderGroups(
      [mail({ messageId: "a", subject: "古い", receivedAt: NOW - 3 * DAY }), mail({ messageId: "b", subject: "新しい", receivedAt: NOW - DAY }), mail({ messageId: "c", subject: "片付けた", trashed: true })],
      NOW,
    );
    assert.deepStrictEqual(group!.pendingSubjects, ["新しい", "古い"]);
  });

  it("対応が要るとして人からのメールの側に移したメールは、送り主のまとまりを残したまま、未処理の数に入れない（まとまりが消えたり出てきたりしないように）", () => {
    const [group] = senderGroups([mail({ messageId: "a", kind: "personal", bulk: true })], NOW);
    assert.deepInclude(group, { senderKey: "news@shop.example", pending: [] });
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

describe("日程が過ぎた招待", () => {
  it("終わりが今より前か、取り消された予定なら過ぎた招待。終わりの決まっていない予定や、招待でないメールは違う", () => {
    assert.isTrue(isPastInvite({ inviteState: "ends", inviteEndsAt: NOW - 1 }, NOW));
    assert.isFalse(isPastInvite({ inviteState: "ends", inviteEndsAt: NOW + 1 }, NOW));
    assert.isTrue(isPastInvite({ inviteState: "cancelled", inviteEndsAt: null }, NOW));
    assert.isFalse(isPastInvite({ inviteState: "open", inviteEndsAt: null }, NOW));
    assert.isFalse(isPastInvite({ inviteState: null, inviteEndsAt: null }, NOW));
  });

  it("送り主ごと・スレッドごとに、受信トレイに残っている過ぎた招待を挙げる", () => {
    const mails = [mail({ messageId: "a", pastInvite: true }), mail({ messageId: "b" }), mail({ messageId: "c", pastInvite: true, inInbox: false })];
    assert.deepStrictEqual(senderGroups(mails, NOW)[0]!.pastInvites, ["a"]);
    assert.deepStrictEqual(personalThreads(mails.map((entry) => ({ ...entry, kind: "personal" as const })))[0]!.pastInvites, ["a"]);
  });
});

describe("effectiveKind（対応を求めるメルマガは、人からのメールとして扱う）", () => {
  it("対応を求めている確率が 0.5 以上か、判定できなかったメルマガ・お知らせは、人からのメールとして扱う", () => {
    assert.strictEqual(effectiveKind({ kind: "newsletter", actionChecked: true, actionProbability: 0.8 }), "personal");
    assert.strictEqual(effectiveKind({ kind: "notification", actionChecked: true, actionProbability: null }), "personal");
    assert.strictEqual(effectiveKind({ kind: "newsletter", actionChecked: true, actionProbability: 0.2 }), "newsletter");
    assert.strictEqual(effectiveKind({ kind: "newsletter", actionChecked: false, actionProbability: null }), "newsletter");
    assert.strictEqual(effectiveKind({ kind: "mine", actionChecked: false, actionProbability: null }), "mine");
  });
});
