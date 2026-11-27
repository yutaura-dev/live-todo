import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { DecisionModel } from "effect/ai";
import { readRuleActions } from "./rule-settings.js";

const TASK_LABELS = ["done", "dismissed", "todo", "none", "unclear"];
const choose = (label: string, labels: string[]) => ({
  _tag: "Classify" as const,
  label,
  probabilities: Object.fromEntries(labels.map((key) => [key, key === label ? 0.9 : 0.1 / (labels.length - 1)])),
});
const p = (probability: number) => ({ _tag: "Probability" as const, probability });

function deciding(answers: (options: DecisionModel.ProviderOptions) => Record<string, DecisionModel.ProviderAnswer>) {
  const calls: DecisionModel.ProviderOptions[] = [];
  return {
    calls,
    layer: Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({ decide: (options) => Effect.sync(() => (calls.push(options), { answers: answers(options), usage: { inputTokens: 1, outputTokens: 0 } })) }),
    ),
  };
}

const completeOnly = () => ({ taskAction: choose("done", TASK_LABELS), hasCondition: p(0), markRead: p(0), archive: p(0), addLabel: p(0), unsupported: p(0) });
const markReadOnly = () => ({ taskAction: choose("none", TASK_LABELS), hasCondition: p(0), markRead: p(0.95), archive: p(0), addLabel: p(0), unsupported: p(0) });

describe("readRuleActions", () => {
  it.effect("Task への操作だけなら、Gmail のアカウントがなくても読み取れる", () =>
    Effect.gen(function* () {
      const result = yield* readRuleActions("完了にする", { available: false, labels: [] });

      assert.deepStrictEqual(result, { ok: true, actions: { task: "done" } });
    }).pipe(Effect.provide(deciding(completeOnly).layer)));

  it.effect("メールへの操作を読み取ったのに Gmail のアカウントがなければ、保存させずに理由を示す", () =>
    Effect.gen(function* () {
      const result = yield* readRuleActions("既読にする", { available: false, labels: [] });

      assert.isFalse(result.ok);
      assert.include(result.ok ? "" : result.reason, "Gmail のアカウント");
    }).pipe(Effect.provide(deciding(markReadOnly).layer)));

  it.effect("ラベルの候補は、文の中の名前と Gmail のラベルを合わせたものにする", () => {
    const model = deciding(completeOnly);
    return Effect.gen(function* () {
      yield* readRuleActions("「経費」ラベルを付けて完了にする", { available: true, labels: ["レシート"] });

      const labelCriteria = (model.calls[0]?.decisions["label"] as { criteria?: Record<string, string> } | undefined)?.criteria ?? {};
      assert.includeMembers(Object.values(labelCriteria), ["ラベル「経費」", "ラベル「レシート」"]);
    }).pipe(Effect.provide(model.layer));
  });
});
