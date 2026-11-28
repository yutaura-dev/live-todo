import { assert, describe, it } from "@effect/vitest";
import { aspectsOf, choose, complete, progressOf, rechoose, reopenItem, turnsOf, type PlanDecision, type PlanGroup, type PlanItem } from "./plan.js";

const item = (id: string, overrides: Partial<PlanItem> = {}): PlanItem => ({ type: "item", id, title: id, how: "human", status: "todo", ...overrides });
const serial = (...items: PlanGroup["items"]): PlanGroup => ({ type: "group", arrangement: "serial", items });
const parallel = (...items: PlanGroup["items"]): PlanGroup => ({ type: "group", arrangement: "parallel", items });

describe("turnsOf（番が来ているか・何を待っているか）", () => {
  it("直列では、最初のまだの項目にだけ番が来て、後ろの項目はその項目を待つ", () => {
    const turns = turnsOf(serial(item("読む"), item("直す"), item("push する")));
    assert.deepStrictEqual(turns.get("読む"), { state: "番が来ている", waitingOn: [] });
    assert.deepStrictEqual(turns.get("直す"), { state: "番待ち", waitingOn: ["読む"] });
    assert.deepStrictEqual(turns.get("push する"), { state: "番待ち", waitingOn: ["直す"] });
  });

  it("済んだ・やらなくなった項目は、後ろの項目を止めない", () => {
    const turns = turnsOf(serial(item("読む", { status: "done" }), item("試す", { status: "skipped" }), item("直す")));
    assert.strictEqual(turns.get("読む")?.state, "済んだ");
    assert.strictEqual(turns.get("試す")?.state, "やらない");
    assert.deepStrictEqual(turns.get("直す"), { state: "番が来ている", waitingOn: [] });
  });

  it("並列では、まとまりに番が来るとすべてに同時に番が来て、後ろの項目はまだのものすべてを待つ", () => {
    const turns = turnsOf(serial(parallel(item("A"), item("B", { status: "done" }), item("C")), item("まとめる")));
    assert.strictEqual(turns.get("A")?.state, "番が来ている");
    assert.strictEqual(turns.get("C")?.state, "番が来ている");
    assert.deepStrictEqual(turns.get("まとめる"), { state: "番待ち", waitingOn: ["A", "C"] });
  });

  it("番待ちのまとまりの中の項目は、まとまりの前の項目を待つ", () => {
    const turns = turnsOf(serial(item("申請する"), parallel(item("A"), item("B"))));
    assert.deepStrictEqual(turns.get("A"), { state: "番待ち", waitingOn: ["申請する"] });
  });

  it("まだ選んでいない分かれ道には番が来て、後ろの項目は分かれ道を待つ", () => {
    const plan = serial(
      { type: "decision", id: "選ぶ", title: "直し方を選ぶ", kind: "選ぶ",
      howToCheck: null,
      question: "",
      recommendation: null, status: "todo", options: [{ label: "すぐ直す", gains: [], costs: [], unclear: [], then: { type: "planned", plan: serial(item("直す")) } }], branches: [] },
      item("報告する"),
    );
    const turns = turnsOf(plan);
    assert.deepStrictEqual(turns.get("選ぶ"), { state: "番が来ている", waitingOn: [] });
    assert.deepStrictEqual(turns.get("報告する"), { state: "番待ち", waitingOn: ["直し方を選ぶ"] });
  });

  it("選んだ分かれ道は済んだになり、進めている枝の項目に番が来て、取りやめた枝の項目はやらない", () => {
    const plan = serial(
      {
        type: "decision",
        id: "選ぶ",
        title: "直し方を選ぶ",
        kind: "選ぶ",
      howToCheck: null,
      question: "",
      recommendation: null,
        status: "done",
        options: [],
        branches: [
          { option: "切り戻す", state: "取りやめた", plan: serial(item("切り戻す", { status: "skipped" })) },
          { option: "すぐ直す", state: "進めている", plan: serial(item("直す"), item("確かめる")) },
        ],
      },
      item("報告する"),
    );
    const turns = turnsOf(plan);
    assert.strictEqual(turns.get("選ぶ")?.state, "済んだ");
    assert.strictEqual(turns.get("切り戻す")?.state, "やらない");
    assert.deepStrictEqual(turns.get("直す"), { state: "番が来ている", waitingOn: [] });
    assert.deepStrictEqual(turns.get("確かめる"), { state: "番待ち", waitingOn: ["直す"] });
    assert.deepStrictEqual(turns.get("報告する"), { state: "番待ち", waitingOn: ["確かめる"] });
  });

  it("選んでから AI が計画を考える枝がまだ空なら、後ろの項目はその計画を待つ", () => {
    const plan = serial(
      { type: "decision", id: "選ぶ", title: "進め方を選ぶ", kind: "選ぶ",
      howToCheck: null,
      question: "",
      recommendation: null, status: "done", options: [], branches: [{ option: "ひとまず調べる", state: "進めている", plan: null }] },
      item("報告する"),
    );
    assert.deepStrictEqual(turnsOf(plan).get("報告する"), { state: "番待ち", waitingOn: ["「ひとまず調べる」の計画（AI が考えています）"] });
  });

  it("完了したときにすることは番に入らず、後ろの項目を止めない", () => {
    const plan = serial({ type: "effect", title: "メールをアーカイブする" }, item("直す"));
    assert.deepStrictEqual(turnsOf(plan).get("直す"), { state: "番が来ている", waitingOn: [] });
  });
});

describe("progressOf（計画の進み具合）", () => {
  it("済んだ・番が来ている・番待ちの数を数え、やらなくなった項目と完了したときにすることは数えない", () => {
    const plan = serial(item("a", { status: "done" }), item("b", { status: "skipped" }), parallel(item("c"), item("d")), item("e"), { type: "effect", title: "f" });
    assert.deepStrictEqual(progressOf(plan), { total: 4, done: 1, now: 2, waiting: 1 });
  });
});

const decision = (overrides: Partial<PlanDecision> = {}): PlanDecision => ({
  type: "decision",
  id: "選ぶ",
  title: "直し方を選ぶ",
  kind: "選ぶ",
      howToCheck: null,
      question: "",
      recommendation: null,
  status: "todo",
  options: [
    { label: "すぐ直す", gains: [], costs: [], unclear: [], then: { type: "planned", plan: serial(item("直す"), item("確かめる")) } },
    { label: "ひとまず調べる", gains: [], costs: [], unclear: [], then: { type: "planLater", direction: "原因を調べてから決める" } },
  ],
  branches: [],
  ...overrides,
});

describe("complete（済んだにする）", () => {
  it("済んだにすると、後ろの項目に番が来る", () => {
    const turns = turnsOf(complete(serial(item("読む"), item("直す")), "読む"));
    assert.strictEqual(turns.get("読む")?.state, "済んだ");
    assert.strictEqual(turns.get("直す")?.state, "番が来ている");
  });
});

describe("choose（分かれ道を選ぶ）", () => {
  it("先が決まっている選択肢を選ぶと、その計画を枝として差し込み、枝の最初の項目に番が来る", () => {
    const plan = choose(serial(decision(), item("報告する")), "選ぶ", "すぐ直す");
    const turns = turnsOf(plan);
    assert.strictEqual(turns.get("選ぶ")?.state, "済んだ");
    assert.strictEqual(turns.get("直す")?.state, "番が来ている");
    assert.deepStrictEqual(turns.get("報告する"), { state: "番待ち", waitingOn: ["確かめる"] });
  });

  it("選んでから考える選択肢を選ぶと、空の枝を差し込み、後ろの項目は AI の計画を待つ", () => {
    const turns = turnsOf(choose(serial(decision(), item("報告する")), "選ぶ", "ひとまず調べる"));
    assert.deepStrictEqual(turns.get("報告する")?.waitingOn, ["「ひとまず調べる」の計画（AI が考えています）"]);
  });
});

describe("rechoose（選び直す）", () => {
  it("選び直すと分かれ道にもう一度番が来て、進めていた枝は取りやめた枝として残り、済んだ項目は済んだのまま", () => {
    const chosen = complete(choose(serial(decision()), "選ぶ", "すぐ直す"), "直す");
    const plan = rechoose(chosen, "選ぶ");
    const turns = turnsOf(plan);
    assert.strictEqual(turns.get("選ぶ")?.state, "番が来ている");
    assert.strictEqual(turns.get("直す")?.state, "済んだ");
    assert.strictEqual(turns.get("確かめる")?.state, "やらない");
    const reopened = plan.items[0] as PlanDecision;
    assert.deepStrictEqual(
      reopened.branches.map((branch) => [branch.option, branch.state]),
      [["すぐ直す", "取りやめた"]],
    );
  });
});

describe("reopenItem（済んだ項目を戻す）", () => {
  it("戻すと、その項目にまた番が来て、後ろの項目は番待ちに戻る", () => {
    const turns = turnsOf(reopenItem(serial(item("読む", { status: "done" }), item("直す")), "読む"));
    assert.strictEqual(turns.get("読む")?.state, "番が来ている");
    assert.deepStrictEqual(turns.get("直す"), { state: "番待ち", waitingOn: ["読む"] });
  });

  it("待つ条件・書き込みで果たされた項目は、外で起きたことなので戻さない", () => {
    const plan = serial(item("待つ", { how: "condition", status: "done" }), item("書く", { how: "write", status: "done" }));
    const turns = turnsOf(reopenItem(reopenItem(plan, "待つ"), "書く"));
    assert.strictEqual(turns.get("待つ")?.state, "済んだ");
    assert.strictEqual(turns.get("書く")?.state, "済んだ");
  });
});

describe("turnsOf（並列の中の枝）", () => {
  it("並列の中の直列の枝は、枝ごとに進む（片方の枝が先に進んでも、もう片方の枝は止めない）", () => {
    const plan = serial(parallel(serial(item("A1", { status: "done" }), item("A2"), item("A3")), serial(item("B1"), item("B2"))), item("まとめる"));
    const turns = turnsOf(plan);
    assert.strictEqual(turns.get("A2")?.state, "番が来ている");
    assert.deepStrictEqual(turns.get("A3"), { state: "番待ち", waitingOn: ["A2"] });
    assert.strictEqual(turns.get("B1")?.state, "番が来ている");
    assert.deepStrictEqual(turns.get("B2"), { state: "番待ち", waitingOn: ["B1"] });
    // 並列の後ろは、枝それぞれの最後のまだの項目を待つ
    assert.deepStrictEqual(turns.get("まとめる"), { state: "番待ち", waitingOn: ["A3", "B2"] });
  });

  it("並列の中の分かれ道は、ほかの枝を止めない。並列の後ろは、選ぶ前なら分かれ道を待つ", () => {
    const fork: PlanDecision = {
      type: "decision",
      id: "選ぶ",
      title: "直し方を選ぶ",
      kind: "選ぶ",
      howToCheck: null,
      question: "",
      recommendation: null,
      status: "todo",
      options: [{ label: "すぐ直す", gains: [], costs: [], unclear: [], then: { type: "planned", plan: serial(item("直す"), item("確かめる")) } }],
      branches: [],
    };
    const plan = serial(parallel(serial(item("調べる", { status: "done" }), fork), item("連絡する")), item("報告する"));
    const turns = turnsOf(plan);
    assert.strictEqual(turns.get("選ぶ")?.state, "番が来ている");
    assert.strictEqual(turns.get("連絡する")?.state, "番が来ている");
    assert.deepStrictEqual(turns.get("報告する"), { state: "番待ち", waitingOn: ["直し方を選ぶ", "連絡する"] });
  });

  it("並列の中の分かれ道で選ぶと、その枝の中に差し込んだ項目が進み、並列の後ろはその最後を待つ", () => {
    const fork: PlanDecision = {
      type: "decision",
      id: "選ぶ",
      title: "直し方を選ぶ",
      kind: "選ぶ",
      howToCheck: null,
      question: "",
      recommendation: null,
      status: "todo",
      options: [{ label: "すぐ直す", gains: [], costs: [], unclear: [], then: { type: "planned", plan: serial(item("直す"), item("確かめる")) } }],
      branches: [],
    };
    const plan = choose(serial(parallel(fork, item("連絡する", { status: "done" })), item("報告する")), "選ぶ", "すぐ直す");
    const turns = turnsOf(plan);
    assert.strictEqual(turns.get("直す")?.state, "番が来ている");
    assert.deepStrictEqual(turns.get("確かめる"), { state: "番待ち", waitingOn: ["直す"] });
    assert.deepStrictEqual(turns.get("報告する"), { state: "番待ち", waitingOn: ["確かめる"] });
  });
});

describe("aspectsOf（分かれ道で比べている観点）", () => {
  it("得るもの・失うもの・判断できなかった観点に出てくる観点を、決め打ちの観点の順に重ねずに並べる", () => {
    const aspects = aspectsOf([
      { label: "すぐ直す", gains: [{ aspect: "期日", detail: "1 時間で戻る" }], costs: [{ aspect: "確実さ", detail: "外れたらもう一度障害" }], unclear: [], then: { type: "planLater", direction: "直す" } },
      { label: "切り戻す", gains: [{ aspect: "確実さ", detail: "確実に戻る" }], costs: [{ aspect: "取り返し", detail: "請求書の機能も消える" }], unclear: ["ほかの人"], then: { type: "planLater", direction: "戻す" } },
    ]);
    assert.deepStrictEqual(aspects, ["期日", "確実さ", "取り返し", "ほかの人"]);
  });
});
