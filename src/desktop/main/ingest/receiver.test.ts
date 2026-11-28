import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import * as TaskSpec from "../../../../specs/task.spec.ts";
import { arrivalImpactQuestion, priorityLevelQuestion } from "../../../llm/decision/questions/index.js";
import { classified, decisionsTest } from "../../../llm/decision/test-double.js";
import { rewriteTaskWriting } from "../../../llm/generation/writings/index.js";
import { generationTest } from "../../../llm/generation/test-double.js";
import { answered, unanswered } from "../../../llm/shared/answer.js";
import { capture, update } from "../../../domain/source-item/source-item.js";
import { route, startRouting } from "../../../domain/routing/routing.js";
import { complete, create } from "../../../domain/task/task.js";
import { StoreDatabase } from "../../../store/database.js";
import { DocumentStore } from "../../../store/document-store.js";
import { PrioritizationStore } from "../../../store/prioritization-store.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { TaskStore } from "../../../store/task-store.js";
import { AiServices } from "../ai/ai-services.js";
import { Planner } from "../plan/planner.js";
import { Calendar, Prioritizer } from "../prioritizer.js";
import { sequentialIds } from "../task-service.js";
import { Receiver } from "./receiver.js";
import { routings } from "./router.js";

type Scripts = { impact?: () => ReturnType<typeof classified> | ReturnType<typeof unanswered>; rewrite?: () => ReturnType<typeof answered> | ReturnType<typeof unanswered> };
const layerWith = (scripts: Scripts) => {
  const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer, SourceItemStore.layer, DocumentStore.layer).pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));
  const d = decisionsTest({
    ...(scripts.impact ? { [arrivalImpactQuestion.purpose]: () => ({ impact: scripts.impact!() }) } : {}),
    [priorityLevelQuestion.purpose]: () => ({ level: unanswered("Refused") }),
  });
  const g = generationTest(scripts.rewrite ? { [rewriteTaskWriting.purpose]: () => scripts.rewrite!() } : {});
  const ai = AiServices.fromContext.pipe(Layer.provide(Layer.merge(d.layer, g.layer)));
  const prioritizer = Prioritizer.layer.pipe(Layer.provideMerge(ai), Layer.provide(Calendar.fixed({ today: "2026-11-28", timeZone: "Asia/Tokyo" })));
  const core = Layer.mergeAll(prioritizer, sequentialIds("x")).pipe(Layer.provideMerge(stores));
  return Receiver.layer.pipe(Layer.provideMerge(Layer.mergeAll(core, Planner.layer.pipe(Layer.provide(core)))));
};

const snapshot = (state: string) => ({ title: "Fix login", author: "alice", fact: { trusted: [{ key: "状態", value: state }], body: "" }, sourceUpdatedAt: null });
const seed = (taskOpen = true) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
    const item = yield* capture({ id: "s1", uri: "github://me@github.com/acme/app/pull/42", url: null, stream: "通知", snapshot: snapshot("開いている") }, { kind: "sync" });
    yield* (yield* SourceItemStore).save(item, { accountId: "a", externalId: "pr42" });
    const task = yield* create({ id: "t1", title: "PR #42 をレビューする", actor: { kind: "agent" }, origin: "事実から自動で作った", sourceItemIds: ["s1"] });
    yield* (yield* TaskStore).save(taskOpen ? task : yield* complete(task, { kind: "user" }, "自分で完了にした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" }));
    yield* routings.save({ ...(yield* route(yield* startRouting("s1", { kind: "sync" }), { kind: "agent" }, "既存の Task の事実にする", "j")), id: "s1" });
    yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T01:00:00Z").epochMilliseconds);
    return yield* update(item, { kind: "sync" }, snapshot("マージ済み"));
  });
const task = Effect.gen(function* () {
  return Option.getOrThrow(yield* (yield* TaskStore).find("t1"));
});

describe(specOf(TaskSpec.receive) + "（事実が変わったのを、持ち主の Task が受け取る）", () => {
  it.effect("関係ないと判定したら、Task は変えない", () =>
    Effect.gen(function* () {
      const item = yield* seed();
      const before = yield* task;
      yield* (yield* Receiver).receive(item);
      assert.strictEqual((yield* task).history.length, before.history.length);
    }).pipe(Effect.provide(layerWith({ impact: () => classified({ 関係ない: 0.9, "列・終わり方が変わる": 0.05, "文章・計画が変わる": 0.05 }) }))));

  it.effect("文章・計画が変わるなら、Generation が今の状況を書き直し、どの出来事から来たかを残す", () =>
    Effect.gen(function* () {
      yield* (yield* Receiver).receive(yield* seed());
      const after = yield* task;
      assert.strictEqual(after.brief, "PR が merge された。確かめて閉じる");
      // 受け取ったあとに優先度も決め直すので、最後の出来事とは限らない
      assert.isTrue(after.history.some((activity) => activity.cause === "activity:s1:1"));
    }).pipe(
      Effect.provide(
        layerWith({
          impact: () => classified({ 関係ない: 0.05, "列・終わり方が変わる": 0.05, "文章・計画が変わる": 0.9 }),
          rewrite: () => answered({ title: null, brief: "PR が merge された。確かめて閉じる", plan: null }),
        }),
      ),
    ));

  it.effect("迷ったら、黙って変えずに、今の状況に「確かめる」を書く（fail closed）", () =>
    Effect.gen(function* () {
      yield* (yield* Receiver).receive(yield* seed());
      assert.strictEqual((yield* task).brief, "判定できなかった事実の変化がある。確かめる");
    }).pipe(Effect.provide(layerWith({ impact: () => classified({ 関係ない: 0.4, "列・終わり方が変わる": 0.2, "文章・計画が変わる": 0.4 }) }))));

  it.effect("Generation が書けなかったら、今の状況に「確かめる」を書く", () =>
    Effect.gen(function* () {
      yield* (yield* Receiver).receive(yield* seed());
      assert.strictEqual((yield* task).brief, "判定できなかった事実の変化がある。確かめる");
    }).pipe(Effect.provide(layerWith({ impact: () => classified({ 関係ない: 0.05, "列・終わり方が変わる": 0.05, "文章・計画が変わる": 0.9 }), rewrite: () => unanswered("Invalid") }))));

  it.effect("持ち主の Task がすべて終わっていたら、振り分けをやり直す（未振り分けに戻す）", () =>
    Effect.gen(function* () {
      const result = yield* (yield* Receiver).receive(yield* seed(false));
      assert.deepStrictEqual(Option.map(yield* routings.find("s1"), (r) => r.status), Option.some("未振り分け"));
      assert.isTrue(result.reroute);
    }).pipe(Effect.provide(layerWith({}))));

  it.effect("同じ出来事が 2 度届いても、反映は 1 回にする", () =>
    Effect.gen(function* () {
      const item = yield* seed();
      yield* (yield* Receiver).receive(item);
      const once = (yield* task).history.length;
      yield* (yield* Receiver).receive(item);
      assert.strictEqual((yield* task).history.length, once);
    }).pipe(
      Effect.provide(
        layerWith({
          impact: () => classified({ 関係ない: 0.05, "列・終わり方が変わる": 0.05, "文章・計画が変わる": 0.9 }),
          rewrite: () => answered({ title: null, brief: "merge された", plan: null }),
        }),
      ),
    ));
});
