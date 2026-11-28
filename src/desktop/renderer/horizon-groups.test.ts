import { assert, describe, it } from "@effect/vitest";
import type { BoardCard } from "../shared/api.js";
import { groupForHorizon } from "./horizon-groups.js";

const card = (id: string, priority: BoardCard["priority"], extra: Partial<BoardCard> = {}): BoardCard => ({
  id,
  title: id,
  status: "やること",
  mark: "なし",
  due: null,
  blocksOthers: false,
  priority,
  sources: [],
  ...extra,
});
const app = (level: NonNullable<BoardCard["priority"]["level"]>) => ({ status: "アプリが決めた", level, reason: "x" }) as const;

describe("見通しのまとまり", () => {
  it("ラベル未定をいちばん上に、近い段から順に並べ、まだ決めていないものはいちばん下にまとめる", () => {
    const groups = groupForHorizon([
      card("later", app("10 日以内")),
      card("pending", { status: "未判定", level: null, reason: null }),
      card("undecided", { status: "ラベル未定", level: null, reason: null }),
      card("now", app("今すぐ")),
    ]);
    assert.deepStrictEqual(
      groups.map((group) => [group.key, group.cards.map((c) => c.id)]),
      [
        ["ラベル未定", ["undecided"]],
        ["今すぐ", ["now"]],
        ["今日中", []],
        ["10 日以内", ["later"]],
        ["未判定", ["pending"]],
      ],
    );
  });

  it("今すぐと今日中は、空でも見せる（今日やることがないと分かること自体が答えなので）", () => {
    assert.deepStrictEqual(groupForHorizon([]).map((group) => group.key), ["今すぐ", "今日中"]);
  });

  it("決め直している間は、前のラベルの段に置いたままにする", () => {
    const groups = groupForHorizon([card("t1", { status: "未判定", level: "3 日以内", reason: "期日まで 3 日" })]);
    assert.deepStrictEqual(groups.find((group) => group.key === "3 日以内")?.cards.map((c) => c.id), ["t1"]);
  });

  it("終わった Task は出さない", () => {
    const groups = groupForHorizon([card("done", app("今すぐ"), { status: "終わった" })]);
    assert.deepStrictEqual(groups.find((group) => group.key === "今すぐ")?.cards, []);
  });

  it("同じ段では、見ていない変化があるもの、他の人を止めているものを先にする", () => {
    const groups = groupForHorizon([
      card("plain", app("今日中")),
      card("blocking", app("今日中"), { blocksOthers: true }),
      card("new", app("今日中"), { mark: "新着" }),
    ]);
    assert.deepStrictEqual(groups.find((group) => group.key === "今日中")?.cards.map((c) => c.id), ["new", "blocking", "plain"]);
  });
});
