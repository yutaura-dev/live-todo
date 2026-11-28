import { assert, describe, it } from "@effect/vitest";
import { rulerOf } from "./ruler.js";

describe("時の物差しの目盛り", () => {
  it("今すぐがいちばん近く、それより先でよいがいちばん遠い", () => {
    assert.strictEqual(rulerOf("今すぐ").depth, 0);
    assert.strictEqual(rulerOf("それより先でよい").depth, 5);
  });

  it("近い順に、深さが 1 つずつ増える", () => {
    const depths = (["今すぐ", "今日中", "3 日以内", "10 日以内", "30 日以内", "それより先でよい"] as const).map((level) => rulerOf(level).depth);
    assert.deepStrictEqual(depths, [0, 1, 2, 3, 4, 5]);
  });

  it("ラベル未定は、自分が決めないと進まないので、今すぐと同じ近さで「決める」目盛りにする", () => {
    assert.deepStrictEqual(rulerOf("ラベル未定"), { depth: 0, label: "未定", tone: "decide" });
  });

  it("未判定は、アプリが決めている途中なので、いちばん遠い「決めている」目盛りにする", () => {
    assert.deepStrictEqual(rulerOf("未判定"), { depth: 5, label: "判定中", tone: "pending" });
  });

  it("それより先でよいは、物差しの幅に収まるよう短く書く", () => {
    assert.strictEqual(rulerOf("それより先でよい").label, "それより先");
  });
});
