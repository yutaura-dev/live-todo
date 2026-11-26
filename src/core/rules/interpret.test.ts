import { assert, describe, it } from "@effect/vitest";
import { actionsFromInterpretation, labelCandidatesOf } from "./interpret.js";

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

describe("actionsFromInterpretation（Decisions の答えを、アプリの操作にする）", () => {
  const base = { markRead: 0.05, archive: 0.05, addLabel: 0.05, label: undefined, unsupported: 0.02 };

  it("確かな（0.7 以上の）操作だけを取り出す", () => {
    assert.deepStrictEqual(actionsFromInterpretation({ ...base, markRead: 0.95, addLabel: 0.9, label: "レシート" }), {
      ok: true,
      actions: { gmail: { labels: ["レシート"], markRead: true, archive: false } },
    });
  });

  it("アプリにできない操作（ゴミ箱・返信など）を求めていたら、保存させない", () => {
    const result = actionsFromInterpretation({ ...base, markRead: 0.9, unsupported: 0.8 });
    assert.isFalse(result.ok);
    assert.include(result.ok ? "" : result.reason, "できない");
  });

  it("ラベルを付けるのに、どのラベルか分からなければ保存させない", () => {
    const result = actionsFromInterpretation({ ...base, addLabel: 0.9 });
    assert.include(result.ok ? "" : result.reason, "ラベル");
  });

  it("どの操作も読み取れなければ保存させない（答えが返らなかったものも含む）", () => {
    assert.isFalse(actionsFromInterpretation({ ...base, markRead: undefined }).ok);
  });
});
