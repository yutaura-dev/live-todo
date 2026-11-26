import { assert, describe, it } from "@effect/vitest";
import { gmailLabelChangesOf, isRuleCandidate, RULE_MATCH_PROBABILITY, type Rule } from "./rule.js";

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  id: "r1",
  name: "請求書にレシートのラベル",
  enabled: true,
  createdAt: "2026-11-26T00:00:00.000Z",
  when: "請求書に関するメール",
  then: "レシート ラベルをつけて既読にする",
  actions: { gmail: { labels: ["レシート"], markRead: true } },
  interpretedFrom: "レシート ラベルをつけて既読にする",
  ...overrides,
});

describe("isRuleCandidate（ルールの条件を判定する対象か）", () => {
  it("有効なルールで、ルールを作ったあとに届いたメールだけを判定する（過去のメールにまとめて当てない）", () => {
    assert.isTrue(isRuleCandidate({ receivedAt: Date.parse("2026-11-26T03:00:00Z"), kind: "notification" }, rule()));
    assert.isFalse(isRuleCandidate({ receivedAt: Date.parse("2026-11-25T03:00:00Z"), kind: "notification" }, rule()));
    assert.isFalse(isRuleCandidate({ receivedAt: Date.parse("2026-11-26T03:00:00Z"), kind: "notification" }, rule({ enabled: false })));
  });

  it("自分が送ったメールや、Gmail の操作のないルールは対象にしない", () => {
    assert.isFalse(isRuleCandidate({ receivedAt: Date.parse("2026-11-26T03:00:00Z"), kind: "mine" }, rule()));
    assert.isFalse(isRuleCandidate({ receivedAt: Date.parse("2026-11-26T03:00:00Z"), kind: "notification" }, rule({ actions: {} })));
  });

  it("「何をする」を書き換えたのに読み取り直していないルールは当てない（前の操作のまま書き込まない）", () => {
    assert.isFalse(isRuleCandidate({ receivedAt: Date.parse("2026-11-26T03:00:00Z"), kind: "notification" }, rule({ then: "アーカイブする" })));
  });

  it("当てはまるとみなすのは、確率が 0.8 以上のときだけ", () => {
    assert.strictEqual(RULE_MATCH_PROBABILITY, 0.8);
  });
});

describe("gmailLabelChangesOf（ルールの Gmail の操作をラベルの付け外しにする）", () => {
  it("ラベルを付け、既読なら UNREAD を、アーカイブなら INBOX を外す", () => {
    assert.deepStrictEqual(gmailLabelChangesOf({ labels: ["レシート"], markRead: true, archive: true }, new Map([["レシート", "Label_1"]])), {
      add: ["Label_1"],
      remove: ["UNREAD", "INBOX"],
    });
  });
});
