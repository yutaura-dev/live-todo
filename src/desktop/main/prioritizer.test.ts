import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { blockingNowQuestion, priorityLevelQuestion } from "../../llm/decision/questions/index.js";
import { classified, decisionsTest, probability } from "../../llm/decision/test-double.js";
import { unanswered } from "../../llm/shared/answer.js";
import { AiUnreachableError } from "../../llm/shared/errors.js";
import { complete, create, setDue, type Task } from "../../domain/task/task.js";
import { StoreDatabase } from "../../store/database.js";
import { PrioritizationStore } from "../../store/prioritization-store.js";
import { TaskStore } from "../../store/task-store.js";
import { AiServices } from "./ai/ai-services.js";
import { Calendar, Prioritizer } from "./prioritizer.js";

const user = { kind: "user" } as const;
const base = Layer.mergeAll(PrioritizationStore.layer, TaskStore.layer).pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));
const calendar = (today: string) => Calendar.fixed({ today, timeZone: "Asia/Tokyo" });
const withoutAi = (today = "2026-11-28") => Prioritizer.layer.pipe(Layer.provideMerge(base), Layer.provide(calendar(today)), Layer.provide(AiServices.fromContext));
const withAi = (script: Parameters<typeof decisionsTest>[0]) => {
  const fake = decisionsTest(script);
  return { fake, layer: Prioritizer.layer.pipe(Layer.provideMerge(base), Layer.provide(calendar("2026-11-28")), Layer.provide(AiServices.fromContext.pipe(Layer.provide(fake.layer)))) };
};

const saved = (task: Task) =>
  Effect.gen(function* () {
    yield* (yield* TaskStore).save(task);
    return task;
  });
const newTask = (due: string | null) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
    const task = yield* create({ id: "t1", title: "請求書を送る", actor: user, origin: "手で足した" });
    return yield* saved(due === null ? task : yield* setDue(task, user, { text: due, earliest: due, latest: due, precision: "日" }));
  });
const prioritizationOf = Effect.gen(function* () {
  return Option.getOrThrow(yield* (yield* PrioritizationStore).find("t1"));
});

describe("Prioritizer（Task の優先度を、規則か Decisions で決める）", () => {
  it.effect("期日が分かれば規則で決め、Decisions には聞かない。ラベルが変わったことを Task の出来事に残す", () => {
    const { fake, layer } = withAi({});
    return Effect.gen(function* () {
      const task = yield* (yield* Prioritizer).refresh(yield* newTask("2026-11-30T03:00:00.000Z"));
      assert.deepStrictEqual((yield* prioritizationOf).priority, { level: "3 日以内", reason: "期日まで 2 日" });
      assert.deepStrictEqual(task.history.at(-1)?.changes, [{ field: "優先度", before: null, after: "3 日以内", target: null }]);
      assert.deepStrictEqual(fake.calls, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("期日を過ぎていれば、規則で今すぐにする", () =>
    Effect.gen(function* () {
      yield* (yield* Prioritizer).refresh(yield* newTask("2026-11-26T03:00:00.000Z"));
      assert.deepStrictEqual((yield* prioritizationOf).priority, { level: "今すぐ", reason: "期日を過ぎている" });
    }).pipe(Effect.provide(withoutAi())));

  it.effect("期日がなければ、Decisions の答えのラベルにする", () => {
    const { layer } = withAi({
      [priorityLevelQuestion.purpose]: () => ({ level: classified({ それより先でよい: 0.05, "30 日以内": 0.05, "10 日以内": 0.8, "3 日以内": 0.05, 今日中: 0.05, 今すぐ: 0 }) }),
    });
    return Effect.gen(function* () {
      yield* (yield* Prioritizer).refresh(yield* newTask(null));
      assert.deepStrictEqual((yield* prioritizationOf).priority, { level: "10 日以内", reason: "判定した" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("Decisions に断られたら、低い優先度ではなくラベル未定にする（fail closed）", () => {
    const { layer } = withAi({ [priorityLevelQuestion.purpose]: () => ({ level: unanswered("Refused") }) });
    return Effect.gen(function* () {
      const task = yield* (yield* Prioritizer).refresh(yield* newTask(null));
      assert.strictEqual((yield* prioritizationOf).status, "ラベル未定");
      assert.deepStrictEqual(task.history.at(-1)?.changes, [{ field: "優先度", before: null, after: "ラベル未定", target: null }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("AI に届かなかったら、未判定のまま置いて次にやり直す", () => {
    const { layer } = withAi({
      [priorityLevelQuestion.purpose]: () => Effect.fail(new AiUnreachableError({ role: "Decisions", purpose: priorityLevelQuestion.purpose, reason: "Network" })),
    });
    return Effect.gen(function* () {
      yield* (yield* Prioritizer).refresh(yield* newTask(null));
      assert.strictEqual((yield* prioritizationOf).status, "未判定");
    }).pipe(Effect.provide(layer));
  });

  it.effect("AI 設定がまだなければ、Decisions には聞かずに未判定のまま置く", () =>
    Effect.gen(function* () {
      yield* (yield* Prioritizer).refresh(yield* newTask(null));
      assert.strictEqual((yield* prioritizationOf).status, "未判定");
    }).pipe(Effect.provide(withoutAi())));

  it.effect("他の人を止めている Task は、今すぐか今日中かだけを Decisions に聞く", () => {
    const { fake, layer } = withAi({ [blockingNowQuestion.purpose]: () => ({ now: probability(0.2) }) });
    return Effect.gen(function* () {
      const task = yield* newTask(null);
      yield* (yield* Prioritizer).refresh(yield* saved({ ...task, blocksOthers: true }));
      assert.deepStrictEqual((yield* prioritizationOf).priority, { level: "今日中", reason: "他の人を止めている" });
      assert.deepStrictEqual(fake.calls.map((call) => call.purpose), [blockingNowQuestion.purpose]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("ユーザーが決めたラベルは、期日が変わってもアプリが変えない", () =>
    Effect.gen(function* () {
      const prioritizer = yield* Prioritizer;
      const task = yield* prioritizer.setByUser(yield* newTask(null), "今すぐ");
      yield* prioritizer.refresh(yield* saved(yield* setDue(task, user, { text: "来月", earliest: "2026-12-28T00:00:00.000Z", latest: "2026-12-28T00:00:00.000Z", precision: "日" })));
      assert.deepStrictEqual((yield* prioritizationOf).priority, { level: "今すぐ", reason: "あなたが決めた" });
    }).pipe(Effect.provide(withoutAi())));

  it.effect("ユーザーが外すと、アプリが決め直す", () =>
    Effect.gen(function* () {
      const prioritizer = yield* Prioritizer;
      const task = yield* prioritizer.setByUser(yield* newTask("2026-11-30T03:00:00.000Z"), "今すぐ");
      yield* prioritizer.clearByUser(task);
      assert.deepStrictEqual((yield* prioritizationOf).priority, { level: "3 日以内", reason: "期日まで 2 日" });
    }).pipe(Effect.provide(withoutAi())));

  it.effect("Task が終わったら、決めるのをやめる", () =>
    Effect.gen(function* () {
      const prioritizer = yield* Prioritizer;
      const task = yield* prioritizer.refresh(yield* newTask("2026-11-30T03:00:00.000Z"));
      yield* prioritizer.refresh(yield* complete(task, user, "自分で完了にした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" }));
      assert.strictEqual((yield* prioritizationOf).status, "決めるのをやめた");
    }).pipe(Effect.provide(withoutAi())));

  it.effect("日が変わったら、期日までの日数で決め直す", () =>
    Effect.gen(function* () {
      const task = yield* newTask("2026-12-10T03:00:00.000Z");
      yield* (yield* Prioritizer).refresh(task);
      assert.strictEqual((yield* prioritizationOf).priority?.level, "30 日以内");
      yield* Effect.gen(function* () {
        yield* (yield* Prioritizer).refresh(task);
      }).pipe(Effect.provide(Layer.fresh(Prioritizer.layer).pipe(Layer.provide(calendar("2026-12-08")), Layer.provide(AiServices.fromContext))));
      assert.deepStrictEqual((yield* prioritizationOf).priority, { level: "3 日以内", reason: "期日まで 2 日" });
    }).pipe(Effect.provide(withoutAi())));
});
