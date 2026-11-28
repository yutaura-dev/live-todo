import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { itemEffortQuestion, priorityLevelQuestion } from "../../../llm/decision/questions/index.js";
import { classified, decisionsTest } from "../../../llm/decision/test-double.js";
import { planWriting } from "../../../llm/generation/writings/index.js";
import { generationTest } from "../../../llm/generation/test-double.js";
import { answered, unanswered } from "../../../llm/shared/answer.js";
import { create, type Task } from "../../../domain/task/task.js";
import { itemsOf } from "../../../domain/plan/plan.js";
import { StoreDatabase } from "../../../store/database.js";
import { PrioritizationStore } from "../../../store/prioritization-store.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { TaskStore } from "../../../store/task-store.js";
import { AiServices } from "../ai/ai-services.js";
import { Calendar, Prioritizer } from "../prioritizer.js";
import { sequentialIds } from "../task-service.js";
import { Planner } from "./planner.js";

const draft = {
  plan: {
    type: "serial" as const,
    items: [
      { type: "item" as const, title: "PR を読む", due: null, completes: false, how: { type: "human" as const, place: null } },
      {
        type: "item" as const,
        title: "merge するか決める",
        due: null,
        completes: false,
        how: {
          type: "decision" as const,
          kind: "選ぶ" as const,
          question: "merge するか",
          howToCheck: null,
          options: [
            { label: "merge する", then: { type: "planned" as const, plan: { type: "serial" as const, items: [{ type: "item" as const, title: "merge する", due: null, completes: true, how: { type: "human" as const, place: null } }] } } },
            { label: "調べる", then: { type: "planLater" as const, direction: "原因を調べる" } },
          ],
        },
      },
    ],
  },
};

const layerWith = (plan: () => ReturnType<typeof answered> | ReturnType<typeof unanswered>, effort = classified({ easy: 0.9, normal: 0.05, hard: 0.03, tedious: 0.02 })) => {
  const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer, SourceItemStore.layer).pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));
  const d = decisionsTest({ [itemEffortQuestion.purpose]: () => ({ effort }), [priorityLevelQuestion.purpose]: () => ({ level: unanswered("Refused") }) });
  const g = generationTest({ [planWriting.purpose]: () => plan() });
  const ai = AiServices.fromContext.pipe(Layer.provide(Layer.merge(d.layer, g.layer)));
  const prioritizer = Prioritizer.layer.pipe(Layer.provideMerge(ai), Layer.provide(Calendar.fixed({ today: "2026-11-28", timeZone: "Asia/Tokyo" })));
  return Planner.layer.pipe(Layer.provideMerge(Layer.mergeAll(prioritizer, sequentialIds("a")).pipe(Layer.provideMerge(stores))));
};

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
  const task = yield* create({ id: "t1", title: "PR #42 をレビューする", actor: { kind: "agent" }, origin: "事実から自動で作った" });
  yield* (yield* TaskStore).save(task);
  return task;
});
const reload = Effect.gen(function* () {
  return Option.getOrThrow(yield* (yield* TaskStore).find("t1"));
});
const idOf = (task: Task, title: string) => itemsOf(task.plan!).find((item) => item.definition.title === title)!.id;

describe("Planner（計画を立て、Action Item を進め、完了条件を満たしたら終える）", () => {
  it.effect("Generation の下書きから計画を立て、手間は Action Item ごとに Decisions に聞く", () =>
    Effect.gen(function* () {
      const result = yield* (yield* Planner).revise(yield* seed);
      assert.isTrue(result.ok);
      const task = yield* reload;
      assert.deepStrictEqual(itemsOf(task.plan!).map((item) => [item.definition.title, item.definition.effort]), [
        ["PR を読む", "easy"],
        ["merge するか決める", "easy"],
      ]);
      assert.strictEqual(task.completion, "未定");
    }).pipe(Effect.provide(layerWith(() => answered(draft)))));

  it.effect("手間が決まらなければ、重いほうに倒す（優先度を低く見積もらないため）", () =>
    Effect.gen(function* () {
      yield* (yield* Planner).revise(yield* seed);
      // 分かれ道は手間を数えないので、聞かない（priority.value.ts）
      assert.deepStrictEqual(itemsOf((yield* reload).plan!).map((item) => item.definition.effort), ["hard", "easy"]);
    }).pipe(Effect.provide(layerWith(() => answered(draft), classified({ easy: 0.3, normal: 0.3, hard: 0.2, tedious: 0.2 })))));

  it.effect("計画が書けなければ、計画は変えずに、今の状況に「確かめる」を書く", () =>
    Effect.gen(function* () {
      const result = yield* (yield* Planner).revise(yield* seed);
      assert.deepStrictEqual(result, { ok: false, reason: "計画を立てられませんでした。もう一度試すか、確かめてください" });
      const task = yield* reload;
      assert.strictEqual(task.plan, null);
      assert.strictEqual(task.brief, "計画を立てられなかった。確かめる");
    }).pipe(Effect.provide(layerWith(() => unanswered("Invalid")))));

  it.effect("済ませる・分かれ道を選ぶと、枝が差し込まれ、完了条件をすべて満たしたら Task を終える", () =>
    Effect.gen(function* () {
      const planner = yield* Planner;
      yield* planner.revise(yield* seed);
      yield* planner.act("t1", { _tag: "CompleteItem", itemId: idOf(yield* reload, "PR を読む") });
      yield* planner.act("t1", { _tag: "ChooseOption", itemId: idOf(yield* reload, "merge するか決める"), option: 0 });
      assert.strictEqual((yield* reload).completion, "まだ");
      yield* planner.act("t1", { _tag: "CompleteItem", itemId: idOf(yield* reload, "merge する") });
      const done = yield* reload;
      assert.deepStrictEqual({ status: done.status, closure: done.closure }, { status: "終わった", closure: { outcome: "done", reason: "完了条件を満たした" } });
    }).pipe(Effect.provide(layerWith(() => answered(draft)))));

  it.effect("番が来ていない Action Item は済ませられない（spec の理由で断る）", () =>
    Effect.gen(function* () {
      const planner = yield* Planner;
      yield* planner.revise(yield* seed);
      assert.deepStrictEqual(yield* planner.act("t1", { _tag: "ChooseOption", itemId: idOf(yield* reload, "merge するか決める"), option: 0 }), { ok: false, reason: "番が来ているときだけ" });
    }).pipe(Effect.provide(layerWith(() => answered(draft)))));

  it.effect("選んでから考える選択肢を選んだら、その方針で枝の先の計画を書く", () =>
    Effect.gen(function* () {
      const planner = yield* Planner;
      yield* planner.revise(yield* seed);
      yield* planner.act("t1", { _tag: "CompleteItem", itemId: idOf(yield* reload, "PR を読む") });
      yield* planner.act("t1", { _tag: "ChooseOption", itemId: idOf(yield* reload, "merge するか決める"), option: 1 });
      const branch = (yield* reload).plan!.nodes.find((node) => node.type === "branch");
      assert.isTrue(branch?.type === "branch" && branch.option === "調べる" && branch.plan !== null);
    }).pipe(Effect.provide(layerWith(() => answered(draft)))));
});
