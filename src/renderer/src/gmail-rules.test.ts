import { assert, describe, it } from "@effect/vitest";
import { describeRule, newRule } from "./gmail-rules.js";

describe("newRule", () => {
  it("作った時刻を持つ、有効なルールを作る（作る前に届いたものには当てない）", () => {
    assert.deepInclude(newRule("2026-11-26T07:00:00.000Z", "r-1"), { id: "r-1", enabled: true, createdAt: "2026-11-26T07:00:00.000Z", when: "" });
  });
});

describe("describeRule（ルールを一文で見せる）", () => {
  it("言葉で書いた条件と操作を、読める文にする", () => {
    assert.strictEqual(
      describeRule({ id: "r", name: "x", createdAt: "", when: "請求書に関するメール", then: { gmail: { labels: ["レシート"], markRead: true } } }),
      "「請求書に関するメール」に当てはまるメールが届いたら、Gmail でラベル「レシート」を付けて既読にする",
    );
  });

  it("条件か操作が決まっていなければ、決めるよう促す", () => {
    assert.strictEqual(describeRule({ id: "r", name: "x", createdAt: "", when: "", then: { gmail: { markRead: true } } }), "条件と操作をそれぞれ決めてください");
  });
});
