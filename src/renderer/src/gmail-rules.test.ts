import { assert, describe, it } from "@effect/vitest";
import { describeRule, newGmailRule } from "./gmail-rules.js";

describe("newGmailRule", () => {
  it("作った時刻を持つ、有効なルールを作る（作る前に届いたメールには当てない）", () => {
    const rule = newGmailRule("2026-11-26T07:00:00.000Z", "r-1");
    assert.deepInclude(rule, { id: "r-1", enabled: true, createdAt: "2026-11-26T07:00:00.000Z" });
  });
});

describe("describeRule（ルールを一文で見せる）", () => {
  it("条件と操作を、読める文にする", () => {
    assert.strictEqual(
      describeRule({ id: "r", name: "x", createdAt: "", when: { topics: ["billing"], fromContains: "cloudflare" }, then: { labels: ["レシート"], markRead: true } }),
      "用件が「請求・支払い」で、差出人のアドレスに「cloudflare」を含むメールに、ラベル「レシート」を付けて既読にする",
    );
  });
});
