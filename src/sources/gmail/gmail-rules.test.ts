import { assert, describe, it } from "@effect/vitest";
import { type GmailRule, labelChangesOf, matchesRule } from "./gmail-rules.js";

const rule = (overrides: Partial<GmailRule> = {}): GmailRule => ({
  id: "r1",
  name: "請求書にレシートのラベル",
  enabled: true,
  createdAt: "2026-11-26T00:00:00.000Z",
  when: { topics: ["billing"] },
  then: { labels: ["レシート"], markRead: true },
  ...overrides,
});
const mail = (overrides: Partial<Parameters<typeof matchesRule>[0]> = {}) => ({
  kind: "notification" as const,
  topic: "billing" as const,
  senderName: "Cloudflare",
  senderKey: "noreply@notify.cloudflare.com",
  subject: "Your invoice is attached",
  receivedAt: Date.parse("2026-11-26T03:00:00.000Z"),
  ...overrides,
});

describe("matchesRule（利用者が決めたルールの条件に合うか）", () => {
  it("用件が条件に入っていれば合う", () => {
    assert.isTrue(matchesRule(mail(), rule()));
    assert.isFalse(matchesRule(mail({ topic: "product" }), rule()));
  });

  it("条件はすべて満たしたときだけ合う（差出人・件名は大文字小文字を区別せずに含むか）", () => {
    const strict = rule({ when: { topics: ["billing"], fromContains: "CLOUDFLARE", subjectContains: "invoice" } });
    assert.isTrue(matchesRule(mail(), strict));
    assert.isFalse(matchesRule(mail({ subject: "Domains renewed" }), strict));
    assert.isFalse(matchesRule(mail({ senderKey: "billing@aws.example", senderName: "AWS" }), strict));
  });

  it("メルマガかお知らせか（kind）でも絞れる", () => {
    assert.isFalse(matchesRule(mail(), rule({ when: { kinds: ["newsletter"] } })));
    assert.isTrue(matchesRule(mail(), rule({ when: { kinds: ["notification"] } })));
  });

  it("ルールを作る前に届いたメールや、止めているルールには合わない（過去のメールにまとめて書き込まない）", () => {
    assert.isFalse(matchesRule(mail({ receivedAt: Date.parse("2026-11-25T00:00:00.000Z") }), rule()));
    assert.isFalse(matchesRule(mail(), rule({ enabled: false })));
  });

  it("用件を条件にするルールは、用件をまだ判定していないメールには合わない（判定のあとに当てる）", () => {
    assert.isFalse(matchesRule(mail({ topic: null }), rule()));
  });
});

describe("labelChangesOf（ルールの操作を Gmail のラベルの付け外しにする）", () => {
  it("ラベルを付け、既読なら UNREAD を、アーカイブなら INBOX を外す", () => {
    assert.deepStrictEqual(labelChangesOf({ labels: ["レシート"], markRead: true, archive: true }, new Map([["レシート", "Label_1"]])), {
      add: ["Label_1"],
      remove: ["UNREAD", "INBOX"],
    });
  });
});
