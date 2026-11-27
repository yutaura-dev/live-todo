import { assert, describe, it } from "@effect/vitest";
import { labelCandidatesOf } from "./interpret.js";

describe("labelCandidatesOf（「何をする」の文から、付けるラベルの名前の候補を取り出す）", () => {
  it.each([
    ["レシート ラベルをつけて既読にする", ["レシート"]],
    ["レシートラベルを付ける", ["レシート"]],
    ["「経費」というラベルを付ける", ["経費"]],
    ["ラベル「税金/2026」を付けてアーカイブ", ["税金/2026"]],
    ["既読にする", []],
  ])("%s → %j", (text, expected) => {
    assert.deepStrictEqual(labelCandidatesOf(text), expected);
  });
});
