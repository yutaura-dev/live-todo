import { assert, describe, it } from "@effect/vitest";
import { richTextToPlain, unwrapRecordMap } from "./notion-records.js";

describe("unwrapRecordMap", () => {
  it("レコードの古い入れ子（{ role, value }）と新しい入れ子（{ value: { value, role } }）の両方から中身を取り出す", () => {
    const map = unwrapRecordMap({
      block: {
        a: { role: "reader", value: { id: "a", type: "page" } },
        b: { spaceId: "s", value: { value: { id: "b", type: "text" }, role: "reader" } },
      },
    });

    assert.deepStrictEqual(map, { block: { a: { id: "a", type: "page" }, b: { id: "b", type: "text" } } });
  });

  it("中身のないレコード（見られないページなど）と、形の分からない値は捨てる", () => {
    const map = unwrapRecordMap({ block: { a: { role: "none" }, b: "x" }, other: 1 });

    assert.deepStrictEqual(map, { block: {} });
  });
});

describe("richTextToPlain", () => {
  const names = { users: new Map([["u1", "田中"]]), pages: new Map([["p1", "議事録"]]) };

  it("つなげた文字列にし、ユーザーのメンションは @名前、ページのメンションはページ名、日付は開始日にする", () => {
    const text = richTextToPlain(
      [["‣", [["u", "u1"]]], [" さん、"], ["‣", [["p", "p1"]]], [" を "], ["‣", [["d", { type: "date", start_date: "2026-11-28" }]]], ["までに", [["b"]]]],
      names,
    );

    assert.strictEqual(text, "@田中 さん、議事録 を 2026-11-28までに");
  });

  it("名前の分からないメンションは「@だれか」「ページ」にし、形の分からない要素は飛ばす", () => {
    assert.strictEqual(richTextToPlain([["‣", [["u", "u9"]]], ["‣", [["p", "p9"]]], [1], "x"], names), "@だれかページ");
    assert.strictEqual(richTextToPlain(undefined, names), "");
  });
});
