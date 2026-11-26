import { assert, describe, it } from "@effect/vitest";
import { describeActions, existingTargetsOf, isInterpreted, newRule } from "./gmail-rules.js";

describe("newRule", () => {
  it("作った時刻を持つ、有効なルールを作る（作る前に届いたものには当てない）", () => {
    assert.deepInclude(newRule("2026-11-26T07:00:00.000Z", "r-1"), { id: "r-1", enabled: true, createdAt: "2026-11-26T07:00:00.000Z", when: "", then: "" });
  });
});

describe("describeActions（読み取った操作を見せる）", () => {
  it("ラベル・既読・アーカイブを読める文にする", () => {
    assert.strictEqual(describeActions({ gmail: { labels: ["レシート"], markRead: true } }), "Gmail でラベル「レシート」を付ける・既読にする");
    assert.strictEqual(describeActions({}), "（操作なし）");
  });
});

describe("isInterpreted", () => {
  it("「何をする」を書き換えたら、読み取り直すまで false", () => {
    const rule = { ...newRule("", "r"), then: "既読にする", interpretedFrom: "既読にする" };
    assert.isTrue(isInterpreted(rule));
    assert.isFalse(isInterpreted({ ...rule, then: "アーカイブする" }));
  });
});

describe("existingTargetsOf（今あるものに当てるとき、何を判定するか）", () => {
  it("読み取った操作の Source から決める（Gmail の操作なら、Gmail の受信トレイに残っているメール）", () => {
    assert.deepStrictEqual(existingTargetsOf({ gmail: { markRead: true } }), ["Gmail の受信トレイに残っているメール"]);
    assert.deepStrictEqual(existingTargetsOf({}), []);
  });
});
