import { assert, describe, it } from "@effect/vitest";
import { mentionedIds, slackTitleLine } from "./slack-text.js";

const names = { users: new Map([["U037XCSBSUS", "yutaura"], ["U2", "hanako"]]) };

describe("slackTitleLine", () => {
  it("メンション・チャンネル・グループ・特別なメンション・リンクを、読める形に直す", () => {
    assert.strictEqual(
      slackTitleLine("<@U037XCSBSUS> <#C1|general> で <!subteam^S1|@dev> と <!here> に <https://example.com|資料> を共有", names),
      "@yutaura #general で @dev と @here に 資料 を共有",
    );
  });

  it("1 行目がメンションや絵文字だけなら、中身のある次の行を使う", () => {
    assert.strictEqual(slackTitleLine("<@U037XCSBSUS>\n11月分の請求書から倍に増やす", names), "11月分の請求書から倍に増やす");
    assert.strictEqual(slackTitleLine(":memo:\n\n週次の振り返りを書く :pencil:", names), "週次の振り返りを書く :pencil:");
  });

  it("中身のある行がなければ、直した 1 行目を使う。名前が分からないメンションは ID のまま @ を付ける", () => {
    assert.strictEqual(slackTitleLine("<@U999>", names), "@U999");
    assert.strictEqual(slackTitleLine(":memo:", names), ":memo:");
  });

  it("長すぎる行は切り詰める", () => {
    assert.strictEqual(slackTitleLine("あ".repeat(100), names), `${"あ".repeat(80)}…`);
  });
});

describe("mentionedIds", () => {
  it("名前を調べる必要のあるユーザーの ID を集める（ラベルつきのメンションは除く）", () => {
    assert.deepStrictEqual(mentionedIds("<@U1> と <@U2|hanako> と <@U1>"), ["U1"]);
  });
});
