import { assert, describe, it } from "@effect/vitest";
import { attentionOf, densityOf, groupByHorizon } from "./horizon.js";
import type { WireTask } from "./model.js";

const task = (overrides: Partial<WireTask>): WireTask => ({
  id: 1,
  title: "依存更新の PR を確かめて merge する",
  brief: null,
  status: "todo",
  work: "なし",
  priority: { status: "アプリが決めた", level: "今日中", reason: "PR のレビューを待たれている" },
  blocksOthers: false,
  sources: ["github"],
  now: [],
  lastSeenAt: "2026-11-28T00:00:00Z",
  history: [],
  ...overrides,
});

describe("groupByHorizon（優先度ごとのまとまり）", () => {
  it("近い順（今すぐ → それより先でよい）に並べる", () => {
    const groups = groupByHorizon([
      task({ id: 1, priority: { status: "アプリが決めた", level: "30 日以内", reason: "期日まで 20 日" } }),
      task({ id: 2, priority: { status: "アプリが決めた", level: "今すぐ", reason: "期日まで 1 日で、手間が 2 日" } }),
      task({ id: 3, priority: { status: "アプリが決めた", level: "3 日以内", reason: "期日まで 5 日" } }),
    ]);
    assert.deepStrictEqual(
      groups.map((group) => group.level),
      ["今すぐ", "今日中", "3 日以内", "30 日以内"],
    );
  });

  it("今すぐと今日中は、Task がなくてもまとまりを出す（何もないことが分かるように）", () => {
    const groups = groupByHorizon([task({ priority: { status: "アプリが決めた", level: "10 日以内", reason: "期日まで 8 日" } })]);
    assert.deepStrictEqual(
      groups.map((group) => [group.level, group.tasks.length]),
      [
        ["今すぐ", 0],
        ["今日中", 0],
        ["10 日以内", 1],
      ],
    );
  });

  it("まとまりの中では、更新マークか新着のある Task を先にし、その次に他の人を止めている Task を出す", () => {
    const groups = groupByHorizon([
      task({ id: 1 }),
      task({ id: 2, blocksOthers: true }),
      task({ id: 3, lastSeenAt: null }),
    ]);
    assert.deepStrictEqual(
      groups.find((group) => group.level === "今日中")?.tasks.map((t) => t.id),
      [3, 2, 1],
    );
  });

  it("開いていない Task（完了待ち・終わった）と優先度のない Task は入れない", () => {
    const groups = groupByHorizon([
      task({ id: 1, priority: null }),
      task({ id: 2, status: "完了待ち" }),
      task({ id: 3, status: "closed" }),
      task({ id: 4 }),
    ]);
    assert.deepStrictEqual(
      groups.flatMap((group) => group.tasks.map((t) => t.id)),
      [4],
    );
  });
});

// specs/task.spec.ts の判断表「更新マークと新着」
describe("groupByHorizon（ラベル未定と未判定）", () => {
  it("ラベル未定の Task は、今すぐの上にまとめる（ユーザーに決めてもらうため）", () => {
    const groups = groupByHorizon([task({ id: 1 }), task({ id: 2, priority: { status: "ラベル未定" } })]);
    assert.deepStrictEqual(
      groups.map((group) => group.level),
      ["ラベル未定", "今すぐ", "今日中"],
    );
  });

  it("まだ一度も優先度を決めていない Task は、いちばん下にまとめる", () => {
    const groups = groupByHorizon([task({ id: 1, priority: { status: "未判定" } })]);
    assert.deepStrictEqual(
      groups.map((group) => [group.level, group.tasks.length]),
      [
        ["今すぐ", 0],
        ["今日中", 0],
        ["未判定", 1],
      ],
    );
  });

  it("ユーザーが決めたラベルも、そのラベルのまとまりに入る", () => {
    const groups = groupByHorizon([task({ id: 1, priority: { status: "ユーザーが決めた", level: "今すぐ", reason: "自分で決めた" } })]);
    assert.deepStrictEqual(groups.find((group) => group.level === "今すぐ")?.tasks.map((t) => t.id), [1]);
  });
});

describe("attentionOf（更新マークと新着）", () => {
  it("まだ一度も見ていない Task は新着", () => {
    assert.deepStrictEqual(attentionOf(task({ lastSeenAt: null })), { kind: "新着" });
  });

  it("最後に見たあとに、ユーザー以外が最後に変えた項目があれば更新マーク", () => {
    const result = attentionOf(
      task({
        lastSeenAt: "2026-11-28T01:00:00Z",
        history: [
          { by: "AI", field: "計画", occurredAt: "2026-11-28T02:00:00Z", summary: "計画を立てた" },
          { by: "ユーザー", field: "期日", occurredAt: "2026-11-28T02:10:00Z", summary: "期日を直した" },
        ],
      }),
    );
    assert.deepStrictEqual(result, { kind: "更新" });
  });

  it("AI が変えた項目でも、そのあとユーザーが同じ項目を変えたなら印を付けない", () => {
    const result = attentionOf(
      task({
        lastSeenAt: "2026-11-28T01:00:00Z",
        history: [
          { by: "AI", field: "期日", occurredAt: "2026-11-28T02:00:00Z", summary: "期日を読み取った" },
          { by: "ユーザー", field: "期日", occurredAt: "2026-11-28T02:10:00Z", summary: "期日を直した" },
        ],
      }),
    );
    assert.deepStrictEqual(result, { kind: "なし" });
  });

  it("最後に見る前の変化は数えない", () => {
    const result = attentionOf(task({ lastSeenAt: "2026-11-28T01:00:00Z", history: [{ by: "同期", field: "列", occurredAt: "2026-11-28T00:30:00Z", summary: "完了待ちから todo へ" }] }));
    assert.deepStrictEqual(result, { kind: "なし" });
  });
});

describe("densityOf（遠いほど小さく見せる）", () => {
  it("今すぐは全部を見せ、今日中・3 日以内は 1 行に次の一手まで、それより遠いものは題だけにする", () => {
    assert.deepStrictEqual(
      (["今すぐ", "今日中", "3 日以内", "10 日以内", "30 日以内", "それより先でよい"] as const).map(densityOf),
      ["full", "row", "row", "line", "line", "line"],
    );
  });

  it("ラベル未定は 1 行に次の一手まで出し、未判定は題だけにする", () => {
    assert.deepStrictEqual(
      (["ラベル未定", "未判定"] as const).map(densityOf),
      ["row", "line"],
    );
  });
});
