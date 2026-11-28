import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import {
  factBelongsToTaskQuestion,
  factRequestsWorkQuestion,
  priorityLevelQuestion,
  workNeedsNewActionQuestion,
  workOutlivesTaskQuestion,
} from "../../../llm/decision/questions/index.js";
import { decisionsTest, probability } from "../../../llm/decision/test-double.js";
import { extractWorkWriting, proposalReasonWriting, taskDraftWriting } from "../../../llm/generation/writings/index.js";
import { generationTest } from "../../../llm/generation/test-double.js";
import { answered, unanswered } from "../../../llm/shared/answer.js";
import { AiUnreachableError } from "../../../llm/shared/errors.js";
import { capture } from "../../../domain/source-item/source-item.js";
import { create, type Task } from "../../../domain/task/task.js";
import { StoreDatabase } from "../../../store/database.js";
import { DocumentStore } from "../../../store/document-store.js";
import { PrioritizationStore } from "../../../store/prioritization-store.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { TaskStore } from "../../../store/task-store.js";
import { AiServices } from "../ai/ai-services.js";
import { Calendar, Prioritizer } from "../prioritizer.js";
import { sequentialIds } from "../task-service.js";
import { proposals, Router, routings } from "./router.js";

type Scripts = { decisions?: Parameters<typeof decisionsTest>[0]; generation?: Parameters<typeof generationTest>[0]; ai?: boolean };

const layerWith = (scripts: Scripts) => {
  const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer, SourceItemStore.layer, DocumentStore.layer).pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));
  const fakeD = decisionsTest(scripts.decisions ?? {});
  const fakeG = generationTest(scripts.generation ?? {});
  const ai = scripts.ai === false ? AiServices.fromContext : AiServices.fromContext.pipe(Layer.provide(Layer.merge(fakeD.layer, fakeG.layer)));
  const prioritizer = Prioritizer.layer.pipe(Layer.provideMerge(ai), Layer.provide(Calendar.fixed({ today: "2026-11-28", timeZone: "Asia/Tokyo" })));
  return { decisions: fakeD, layer: Router.layer.pipe(Layer.provideMerge(Layer.mergeAll(prioritizer, sequentialIds("x")).pipe(Layer.provideMerge(stores)))) };
};

const work = { title: "PR #42 をレビューする", detail: "レビューを頼まれた", due: null };
const arrive = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
  const item = yield* capture(
    {
      id: "s1",
      uri: "github://me@github.com/acme/app/pull/42",
      url: "https://github.com/acme/app/pull/42",
      stream: "通知",
      snapshot: { title: "Fix login", author: "alice", fact: { trusted: [{ key: "種類", value: "PullRequest" }, { key: "あなたへのレビュー依頼", value: "あり" }], body: "見てください" }, sourceUpdatedAt: null },
    },
    { kind: "sync" },
  );
  yield* (yield* SourceItemStore).save(item, { accountId: "github-work", externalId: "pr42" });
  return item;
});
const existingTask = Effect.gen(function* () {
  const task = yield* create({ id: "t1", title: "ログインの不具合を直す", actor: { kind: "user" }, origin: "手で足した" });
  yield* (yield* TaskStore).save(task);
  return task;
});
const routingStatus = Effect.gen(function* () {
  return Option.map(yield* routings.find("s1"), (r) => r.status);
});
const allTasks = Effect.gen(function* () {
  return yield* (yield* TaskStore).listForBoard();
});

describe("Router（届いた事実を振り分ける）", () => {
  it.effect("AI 設定がまだなら、AI を呼ばずに未振り分けのまま置く", () =>
    Effect.gen(function* () {
      yield* (yield* Router).route(yield* arrive);
      assert.deepStrictEqual(yield* routingStatus, Option.some("未振り分け"));
    }).pipe(Effect.provide(layerWith({ ai: false }).layer)));

  it.effect("作業を求め、行動が要る確信が高ければ、事実を持った Task を自動で作る", () =>
    Effect.gen(function* () {
      yield* (yield* Router).route(yield* arrive);
      const [task] = (yield* allTasks) as Task[];
      assert.deepStrictEqual({ title: task?.title, facts: task?.sourceItemIds, origin: task?.history[0]?.cause, by: task?.history[0]?.by }, {
        title: "PR #42 をレビューする",
        facts: ["s1"],
        origin: "事実から自動で作った",
        by: "AI",
      });
      assert.deepStrictEqual(yield* routingStatus, Option.some("振り分けた"));
    }).pipe(
      Effect.provide(
        layerWith({
          decisions: {
            [factRequestsWorkQuestion.purpose]: () => ({ requestsWork: probability(0.9) }),
            [workNeedsNewActionQuestion.purpose]: () => ({ needsAction: probability(0.95) }),
            [priorityLevelQuestion.purpose]: () => ({ level: unanswered("Refused") }),
          },
          generation: {
            [extractWorkWriting.purpose]: () => answered({ works: [work] }),
            [taskDraftWriting.purpose]: () => answered({ title: "PR #42 をレビューする", brief: "alice さんからレビューを頼まれた", due: null }),
          },
        }).layer,
      ),
    ));

  it.effect("行動が要るか迷ったら、Task は作らず、新しい Task の提案にする", () =>
    Effect.gen(function* () {
      yield* (yield* Router).route(yield* arrive);
      assert.deepStrictEqual(yield* allTasks, []);
      const [proposal] = yield* proposals.all();
      assert.deepStrictEqual({ kind: proposal?.kind, title: proposal?.title, brief: proposal?.brief, facts: proposal?.sourceItemIds }, {
        kind: "新しい Task",
        title: "PR #42 をレビューする",
        brief: "頼まれたが、もう誰かが見ているかもしれない",
        facts: ["s1"],
      });
    }).pipe(
      Effect.provide(
        layerWith({
          decisions: { [factRequestsWorkQuestion.purpose]: () => ({ requestsWork: probability(0.9) }), [workNeedsNewActionQuestion.purpose]: () => ({ needsAction: probability(0.6) }) },
          generation: {
            [extractWorkWriting.purpose]: () => answered({ works: [work] }),
            [taskDraftWriting.purpose]: () => answered({ title: "PR #42 をレビューする", brief: "x", due: null }),
            [proposalReasonWriting.purpose]: () => answered({ brief: "頼まれたが、もう誰かが見ているかもしれない" }),
          },
        }).layer,
      ),
    ));

  it.effect("作業を求めず、どの Task にも関係しなければ、対象外にする（作業の切り出しは呼ばない）", () =>
    Effect.gen(function* () {
      yield* (yield* Router).route(yield* arrive);
      assert.deepStrictEqual(yield* routingStatus, Option.some("対象外"));
    }).pipe(Effect.provide(layerWith({ decisions: { [factRequestsWorkQuestion.purpose]: () => ({ requestsWork: probability(0.05) }) } }).layer)));

  it.effect("関係する開いた Task には緩めに紐づけ、作業を求めなければ事実として持たせる", () =>
    Effect.gen(function* () {
      yield* existingTask;
      yield* (yield* Router).route(yield* arrive);
      const [task] = (yield* allTasks) as Task[];
      assert.deepStrictEqual(task?.sourceItemIds, ["s1"]);
      assert.deepStrictEqual(yield* routingStatus, Option.some("振り分けた"));
    }).pipe(
      Effect.provide(
        layerWith({
          decisions: { [factBelongsToTaskQuestion.purpose]: () => ({ belongs: probability(0.5) }), [factRequestsWorkQuestion.purpose]: () => ({ requestsWork: probability(0.05) }) },
        }).layer,
      ),
    ));

  it.effect("紐づけた Task の完了条件が未定なら、作業を自動では足さず、足す提案にする", () =>
    Effect.gen(function* () {
      yield* existingTask;
      yield* (yield* Router).route(yield* arrive);
      const [proposal] = yield* proposals.all();
      assert.deepStrictEqual({ kind: proposal?.kind, target: proposal?.targetTaskId }, { kind: "既存の Task に足す", target: "t1" });
    }).pipe(
      Effect.provide(
        layerWith({
          decisions: {
            [factBelongsToTaskQuestion.purpose]: () => ({ belongs: probability(0.9) }),
            [factRequestsWorkQuestion.purpose]: () => ({ requestsWork: probability(0.9) }),
            [workOutlivesTaskQuestion.purpose]: () => ({ outlives: probability(0.1) }),
          },
          generation: { [extractWorkWriting.purpose]: () => answered({ works: [work] }), [proposalReasonWriting.purpose]: () => answered({ brief: "この Task の続きに見える" }) },
        }).layer,
      ),
    ));

  it.effect("AI が答えなかったら、黙って決めずにユーザー待ちにする（fail closed）", () =>
    Effect.gen(function* () {
      yield* (yield* Router).route(yield* arrive);
      assert.deepStrictEqual(yield* routingStatus, Option.some("ユーザー待ち"));
      assert.deepStrictEqual(yield* allTasks, []);
    }).pipe(
      Effect.provide(
        layerWith({
          decisions: { [factRequestsWorkQuestion.purpose]: () => ({ requestsWork: probability(0.9) }), [workNeedsNewActionQuestion.purpose]: () => ({ needsAction: unanswered("Refused") }) },
          generation: { [extractWorkWriting.purpose]: () => answered({ works: [work] }) },
        }).layer,
      ),
    ));

  it.effect("途中で AI に届かなかったら、何も書かずに未振り分けのまま次にやり直す", () =>
    Effect.gen(function* () {
      yield* (yield* Router).route(yield* arrive);
      assert.deepStrictEqual(yield* routingStatus, Option.some("未振り分け"));
      assert.deepStrictEqual(yield* allTasks, []);
      assert.deepStrictEqual(yield* proposals.all(), []);
    }).pipe(
      Effect.provide(
        layerWith({
          decisions: {
            [factRequestsWorkQuestion.purpose]: () => ({ requestsWork: probability(0.9) }),
            [workNeedsNewActionQuestion.purpose]: () => Effect.fail(new AiUnreachableError({ role: "Decisions", purpose: "x", reason: "Network" })),
          },
          generation: { [extractWorkWriting.purpose]: () => answered({ works: [work] }) },
        }).layer,
      ),
    ));
});
