import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { DecisionModel } from "effect/ai";
import { interpretRuleActions, type RuleActionsInterpretation, ruleActionsOf } from "./rule-actions.js";

function deciding(answers: Record<string, DecisionModel.ProviderAnswer>) {
  const calls: DecisionModel.ProviderOptions[] = [];
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: (options) =>
        Effect.sync(() => {
          calls.push(options);
          return { answers, usage: { inputTokens: 1, outputTokens: 0 } };
        }),
    }),
  );
  return { calls, layer };
}

const p = (probability: number) => ({ _tag: "Probability" as const, probability });
const choose = (label: string, labels: string[]) => ({
  _tag: "Classify" as const,
  label,
  probabilities: Object.fromEntries(labels.map((key) => [key, key === label ? 0.9 : 0.1 / (labels.length - 1)])),
});
const TASK_LABELS = ["done", "dismissed", "todo", "none", "unclear"];

describe("interpretRuleActions", () => {
  it.effect("Task の操作・条件の混入・メールの操作・できない操作を、Decisions の 1 回の呼び出しで読み取る", () => {
    const { calls, layer } = deciding({
      taskAction: choose("done", TASK_LABELS),
      hasCondition: p(0.02),
      markRead: p(0.95),
      archive: p(0.05),
      addLabel: p(0.9),
      label: choose("l0", ["l0", "l1", "none"]),
      unsupported: p(0.01),
    });
    return Effect.gen(function* () {
      const result = yield* interpretRuleActions({ then: "レシート ラベルを付けて既読にし、完了にする", labels: ["レシート", "仕事"] });

      assert.lengthOf(calls, 1);
      assert.include(JSON.stringify(calls[0]?.state), "レシート ラベルを付けて既読にし、完了にする");
      assert.deepStrictEqual(result.taskAction?.label, "done");
      assert.strictEqual(result.label, "レシート");
      assert.closeTo(result.markRead ?? 0, 0.95, 1e-9);
    }).pipe(Effect.provide(layer));
  });

  it.effect("「はっきりしない」を選んだら、Task の操作は読み取れなかったものにする", () =>
    Effect.gen(function* () {
      const result = yield* interpretRuleActions({ then: "いい感じにしておいて", labels: [] });

      assert.isUndefined(result.taskAction);
    }).pipe(
      Effect.provide(
        deciding({ taskAction: choose("unclear", TASK_LABELS), hasCondition: p(0), markRead: p(0), archive: p(0), addLabel: p(0), unsupported: p(0) }).layer,
      ),
    ));
});

describe("ruleActionsOf", () => {
  const base: RuleActionsInterpretation = {
    taskAction: undefined,
    hasCondition: 0.02,
    markRead: 0.05,
    archive: 0.05,
    addLabel: 0.05,
    label: undefined,
    unsupported: 0.02,
  };

  it("Task の操作だけなら、メールの操作なしで保存できる（Gmail のアカウントは要らない）", () => {
    assert.deepStrictEqual(ruleActionsOf({ ...base, taskAction: { label: "done", probability: 0.95 } }), { ok: true, actions: { task: "done" } });
  });

  it("確かな（0.7 以上の）メールの操作だけを取り出す", () => {
    assert.deepStrictEqual(ruleActionsOf({ ...base, taskAction: { label: "none", probability: 0.9 }, markRead: 0.95, addLabel: 0.9, label: "レシート" }), {
      ok: true,
      actions: { gmail: { labels: ["レシート"], markRead: true, archive: false } },
    });
  });

  it("Task の操作とメールの操作を一緒に持てる", () => {
    assert.deepStrictEqual(ruleActionsOf({ ...base, taskAction: { label: "dismissed", probability: 0.9 }, archive: 0.95 }), {
      ok: true,
      actions: { task: "dismissed", gmail: { labels: [], markRead: false, archive: true } },
    });
  });

  it("条件が混ざっていたら保存させず、「どういう時」に書くよう案内する", () => {
    const result = ruleActionsOf({ ...base, taskAction: { label: "done", probability: 0.99 }, hasCondition: 0.99 });

    assert.isFalse(result.ok);
    assert.include(result.ok ? "" : result.reason, "どういう時");
  });

  it("アプリにできない操作（返信・削除など）を求めていたら、保存させない", () => {
    const result = ruleActionsOf({ ...base, taskAction: { label: "done", probability: 0.9 }, unsupported: 0.8 });

    assert.include(result.ok ? "" : result.reason, "できない");
  });

  it("メールにラベルを付けるのに、どのラベルか分からなければ保存させない", () => {
    const result = ruleActionsOf({ ...base, taskAction: { label: "none", probability: 0.9 }, addLabel: 0.9 });

    assert.include(result.ok ? "" : result.reason, "ラベル");
  });

  it("Task の操作が確かでなければ（0.7 未満・読み取れない）、保存させない", () => {
    assert.isFalse(ruleActionsOf({ ...base, taskAction: { label: "todo", probability: 0.6 } }).ok);
    assert.isFalse(ruleActionsOf(base).ok);
  });

  it("Task を変えず、メールの操作もないなら、保存させない", () => {
    assert.isFalse(ruleActionsOf({ ...base, taskAction: { label: "none", probability: 0.95 } }).ok);
  });

  it("答えが返らなかった判定（条件の混入・できない操作）は、保存させない側に倒す", () => {
    assert.isFalse(ruleActionsOf({ ...base, taskAction: { label: "done", probability: 0.9 }, hasCondition: undefined }).ok);
    assert.isFalse(ruleActionsOf({ ...base, taskAction: { label: "done", probability: 0.9 }, unsupported: undefined }).ok);
  });
});
