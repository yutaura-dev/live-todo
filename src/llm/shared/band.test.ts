import { assert, describe, it } from "@effect/vitest";
import { answered, unanswered } from "./answer.js";
import { bandOf, bandOfAnswer, makeThresholds } from "./band.js";

const thresholds = makeThresholds({ highAtLeast: 0.8, lowBelow: 0.3 });

describe("確率を、判断表が読む「高い・中間・低い・判断できなかった」に分ける", () => {
  it("高い側の閾値ちょうどは高い", () => {
    assert.strictEqual(bandOf(0.8, thresholds), "高い");
  });

  it("低い側の閾値ちょうどは中間（低いは閾値より下だけ）", () => {
    assert.strictEqual(bandOf(0.3, thresholds), "中間");
  });

  it("低い側の閾値より下は低い", () => {
    assert.strictEqual(bandOf(0.29, thresholds), "低い");
  });

  it("答えなかったら、否定ではなく判断できなかったにする（fail closed）", () => {
    assert.strictEqual(bandOfAnswer(unanswered("Refused"), thresholds), "判断できなかった");
  });

  it("答えたら、その確率で分ける", () => {
    assert.strictEqual(bandOfAnswer(answered({ probability: 0.9 }), thresholds), "高い");
  });

  it("高い側の閾値が低い側より小さい閾値は作れない", () => {
    assert.throws(() => makeThresholds({ highAtLeast: 0.2, lowBelow: 0.5 }));
  });
});
