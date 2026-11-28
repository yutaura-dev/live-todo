import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/action-item.spec.ts";
import { type Definition, appendItem, chooseOption, completeItem, completionOf, fromDrafts, type PlanGroup, reopenItem, skipItem, turnOf } from "./plan.js";

const user = { kind: "user" } as const;
const ai = { kind: "agent" } as const;
const human = (title: string, completes = false): Definition => ({ title, effort: "easy", due: null, completes, how: { type: "human" } });
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);

let n = 0;
const nextId = () => `a${++n}`;
const serial = (): PlanGroup => fromDrafts({ type: "serial", items: [human("PR を読む"), human("コメントを返す", true)] }, nextId).plan;
const ids = (plan: PlanGroup) => plan.nodes.flatMap((node) => (node.type === "item" ? [node.item.id] : []));
const decisionPlan = (): PlanGroup =>
  fromDrafts(
    {
      type: "serial",
      items: [
        {
          title: "merge するか決める",
          effort: "easy",
          due: null,
          completes: false,
          how: {
            type: "decision",
            kind: "選ぶ",
            question: "型エラーがあるが merge するか",
            howToCheck: null,
            options: [
              { label: "merge する", then: { type: "planned", plan: { type: "serial", items: [human("merge する", true)] } } },
              { label: "調べる", then: { type: "planLater", direction: "原因を調べる" } },
            ],
          },
        },
      ],
    },
    nextId,
  ).plan;

describe("計画の番", () => {
  it("前から順の並びは、まだのものの先頭にだけ番が来る", () => {
    const plan = serial();
    const [first, second] = ids(plan);
    assert.deepStrictEqual([turnOf(plan, first!), turnOf(plan, second!)], ["番が来ている", "番待ち"]);
  });

  it("同時の並びは、すべてに番が来る", () => {
    const plan = fromDrafts({ type: "parallel", items: [human("A"), human("B")] }, nextId).plan;
    assert.deepStrictEqual(ids(plan).map((id) => turnOf(plan, id)), ["番が来ている", "番が来ている"]);
  });
});

describe(specOf(Spec.complete), () => {
  it.effect("番が来ている Action Item を済ませると、次に番が来る", () =>
    Effect.gen(function* () {
      const plan = serial();
      const [first, second] = ids(plan);
      const next = yield* completeItem(plan, first!, user);
      assert.deepStrictEqual([turnOf(next, first!), turnOf(next, second!)], ["済んだ", "番が来ている"]);
    }));

  it.effect(specOf(Spec.complete, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(completeItem(plan, ids(plan)[0]!, ai)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.complete, "まだのときだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      const once = yield* completeItem(plan, ids(plan)[0]!, user);
      assert.strictEqual(yield* reasonOf(completeItem(once, ids(plan)[0]!, user)), "まだのときだけ");
    }));

  it.effect(specOf(Spec.complete, "番が来ているときだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(completeItem(plan, ids(plan)[1]!, user)), "番が来ているときだけ");
    }));

  it.effect(specOf(Spec.complete, "人か Claude Code が果たす Action Item だけ"), () =>
    Effect.gen(function* () {
      const plan = decisionPlan();
      assert.strictEqual(yield* reasonOf(completeItem(plan, ids(plan)[0]!, user)), "人か Claude Code が果たす Action Item だけ");
    }));
});

describe(specOf(Spec.reopen), () => {
  it.effect("済ませた Action Item を、まだに戻す", () =>
    Effect.gen(function* () {
      const plan = serial();
      const id = ids(plan)[0]!;
      const back = yield* reopenItem(yield* completeItem(plan, id, user), id, user);
      assert.strictEqual(turnOf(back, id), "番が来ている");
    }));

  it.effect(specOf(Spec.reopen, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      const id = ids(plan)[0]!;
      assert.strictEqual(yield* reasonOf(reopenItem(yield* completeItem(plan, id, user), id, ai)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.reopen, "済んだときだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(reopenItem(plan, ids(plan)[0]!, user)), "済んだときだけ");
    }));
});

describe(specOf(Spec.choose), () => {
  it.effect("先の計画が決まっている選択肢を選ぶと、その枝を差し込み、枝の中に番が来る", () =>
    Effect.gen(function* () {
      const plan = decisionPlan();
      const decisionId = ids(plan)[0]!;
      const chosen = yield* chooseOption(plan, decisionId, 0, user, nextId);
      const branch = chosen.nodes[1];
      assert.strictEqual(branch?.type, "branch");
      const inner = branch?.type === "branch" && branch.plan !== null ? ids(branch.plan)[0]! : "";
      assert.deepStrictEqual([turnOf(chosen, decisionId), turnOf(chosen, inner)], ["済んだ", "番が来ている"]);
    }));

  it.effect(specOf(Spec.choose, "分かれ道だけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(chooseOption(plan, ids(plan)[0]!, 0, user, nextId)), "分かれ道だけ");
    }));

  it.effect(specOf(Spec.choose, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      const plan = decisionPlan();
      assert.strictEqual(yield* reasonOf(chooseOption(plan, ids(plan)[0]!, 0, ai, nextId)), "ユーザーだけ");
    }));
});

describe(specOf(Spec.skip), () => {
  it.effect("やらなくした Action Item は、番を次に渡す", () =>
    Effect.gen(function* () {
      const plan = serial();
      const [first, second] = ids(plan);
      const next = yield* skipItem(plan, first!, user);
      assert.deepStrictEqual([turnOf(next, first!), turnOf(next, second!)], ["やらない", "番が来ている"]);
    }));

  it.effect(specOf(Spec.skip, "まだのときだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      const id = ids(plan)[0]!;
      assert.strictEqual(yield* reasonOf(skipItem(yield* skipItem(plan, id, user), id, user)), "まだのときだけ");
    }));
});

describe("完了条件の状態（計画から導く）", () => {
  it("計画がなければ未定", () => {
    assert.strictEqual(completionOf(null), "未定");
  });

  it.effect("完了条件の Action Item がすべて済めば、満たした", () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(completionOf(plan), "まだ");
      const done = yield* completeItem(yield* completeItem(plan, ids(plan)[0]!, user), ids(plan)[1]!, user);
      assert.strictEqual(completionOf(done), "満たした");
    }));

  it("まだ選んでいない分かれ道に、選んでから考える選択肢があれば未定", () => {
    assert.strictEqual(completionOf(decisionPlan()), "未定");
  });

  it.effect("選んでから考える選択肢を選んだら、先の計画ができるまで未定", () =>
    Effect.gen(function* () {
      const plan = decisionPlan();
      assert.strictEqual(completionOf(yield* chooseOption(plan, ids(plan)[0]!, 1, user, nextId)), "未定");
    }));

  it("完了条件の Action Item が 1 つもなければ未定（計画の書き損じ）", () => {
    assert.strictEqual(completionOf(fromDrafts({ type: "serial", items: [human("読む")] }, nextId).plan), "未定");
  });
});

describe("事実から計画に足す", () => {
  it("足した Action Item は、もとの事実を持ち、計画の最後に並ぶ", () => {
    const plan = appendItem(serial(), { id: "added", status: "まだ", definition: human("レビューに返事する"), addedFrom: "s1" });
    const last = plan.nodes.at(-1);
    assert.deepStrictEqual(last?.type === "item" ? [last.item.id, last.item.addedFrom] : null, ["added", "s1"]);
  });
});
