import { assert, describe, it } from "@effect/vitest";
import { describeActions, describeCondition, existingTargetsOf, isConditionChecked, isInterpreted, needsCondition, newRule } from "./rules.js";

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

  it("Task への操作を、メールの操作より先に読める文にする", () => {
    assert.strictEqual(describeActions({ task: "done" }), "Task を完了にする");
    assert.strictEqual(describeActions({ task: "dismissed", gmail: { archive: true } }), "Task を対象外にする・Gmail でアーカイブする");
    assert.strictEqual(describeActions({ task: "todo" }), "Task を todo にする");
  });
});

describe("isInterpreted", () => {
  it("「何をする」を書き換えたら、読み取り直すまで false", () => {
    const rule = { ...newRule("", "r"), then: "既読にする", interpretedFrom: "既読にする" };
    assert.isTrue(isInterpreted(rule));
    assert.isFalse(isInterpreted({ ...rule, then: "アーカイブする" }));
  });
});

describe("条件を分けた問い", () => {
  const condition = {
    combine: "all" as const,
    clauses: [
      { question: "紐づく事実に GitHub の PR があるか", expect: true, about: "metadata" as const },
      { question: "その PR の作成者は YutaUra か", expect: false, about: "metadata" as const },
    ],
  };

  it("分けた問いと、条件に当てはまるときの答えを読める形にする", () => {
    assert.deepStrictEqual(describeCondition(condition), ["紐づく事実に GitHub の PR があるか → はい", "その PR の作成者は YutaUra か → いいえ"]);
  });

  it("どれか 1 つでよい条件は、そのことを添える", () => {
    assert.deepStrictEqual(describeCondition({ ...condition, combine: "any" }).at(-1), "（どれか 1 つに当てはまればよい）");
  });

  it("「どういう時」を書き換えたら、分け直すまで確かめていないものにする", () => {
    const rule = { ...newRule("", "r"), when: "他人の PR", condition, conditionFrom: "他人の PR" };
    assert.isTrue(isConditionChecked(rule));
    assert.isFalse(isConditionChecked({ ...rule, when: "bot の PR" }));
    const { condition: _condition, ...withoutCondition } = rule;
    assert.isFalse(isConditionChecked(withoutCondition));
  });

  it("Task への操作をするルールだけ、条件を分けて確かめる必要がある", () => {
    assert.isTrue(needsCondition({ ...newRule("", "r"), actions: { task: "done" } }));
    assert.isFalse(needsCondition({ ...newRule("", "r"), actions: { gmail: { markRead: true } } }));
  });
});

describe("existingTargetsOf（今あるものに当てるとき、何を判定するか）", () => {
  it("読み取った操作の Source から決める（Gmail の操作なら、Gmail の受信トレイに残っているメール）", () => {
    assert.deepStrictEqual(existingTargetsOf({ gmail: { markRead: true } }), ["Gmail の受信トレイに残っているメール"]);
    assert.deepStrictEqual(existingTargetsOf({}), []);
    // Task への操作は、ルールを作ったあとにできた・動いた Task にだけ当てる（今ある Task にまとめて当てない）
    assert.deepStrictEqual(existingTargetsOf({ task: "done" }), []);
  });
});
