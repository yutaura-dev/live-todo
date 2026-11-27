import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { AiError, DecisionModel } from "effect/ai";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../core/db/test-database.js";
import type { Rule } from "../core/rules/rule.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { applyTaskRules } from "./task-rules.js";

const RULE_CREATED = Date.parse("2026-11-27T00:00:00Z");

const rule: Rule = {
  id: "r1",
  name: "他人の PR は完了",
  enabled: true,
  createdAt: new Date(RULE_CREATED).toISOString(),
  when: "他人の PR",
  condition: { combine: "all", clauses: [{ question: "紐づく事実に、他人が作った PR があるか", expect: true, about: "metadata" }] },
  conditionFrom: "他人の PR",
  then: "完了にする",
  actions: { task: "done" },
  interpretedFrom: "完了にする",
};

function deciding(probability: () => number | "fail") {
  let calls = 0;
  const layer = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: (options) =>
        Effect.suspend(() => {
          calls++;
          const p = probability();
          if (p === "fail") return Effect.fail(AiError.make({ module: "Test", method: "decide", reason: new AiError.RateLimitError({}) }));
          return Effect.succeed({
            answers: Object.fromEntries(Object.keys(options.decisions).map((key) => [key, { _tag: "Probability" as const, probability: p }])),
            usage: { inputTokens: 1, outputTokens: 0 },
          });
        }),
    }),
  );
  return { layer, calls: () => calls };
}

/** ルールを作ったあとに届いた PR の Task（同期が作るのと同じく、作ったことを Task の変化に残す） */
const taskFromPr = (at: number, externalId = "pr-1") =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const item = yield* items.upsertItem({ source: "github:work", externalId, title: "README", url: `https://github.com/acme/app/pull/${externalId}`, state: "open", fingerprint: "1", fact: { trusted: ["作成者: @alice"], body: "タイトル: README" } });
    const task = yield* tasks.createTask({ title: "README の PR", status: "needs_review" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    yield* tasks.recordChange(task.id, { kind: "created", unread: false });
    return { task, item };
  });

const statusOf = (taskId: number) =>
  Effect.gen(function* () {
    const task = yield* (yield* TaskRepository).findTask(taskId);
    return task._tag === "Some" ? task.value.status : undefined;
  });

describe("applyTaskRules", () => {
  it.effect("条件に当てはまる（0.8 以上の）Task に、ルールの操作をして、ルールがしたこととして残す", () => {
    const model = deciding(() => 0.95);
    return Effect.gen(function* () {
      const { task } = yield* taskFromPr(RULE_CREATED + 1000);

      const summary = yield* applyTaskRules([rule]);

      assert.strictEqual(yield* statusOf(task.id), "done");
      assert.deepInclude(summary, { applied: 1, notMatched: 0 });
      const changes = yield* (yield* TaskRepository).listChanges(task.id);
      assert.isTrue(changes.some((change) => change.field === "status" && change.after === "done" && change.actor === "rule"));
    }).pipe(Effect.provide(Layer.merge(TestDatabase, model.layer)));
  });

  it.effect("当てはまらない Task は変えず、同じきっかけでは判定し直さない", () => {
    const model = deciding(() => 0.3);
    return Effect.gen(function* () {
      const { task } = yield* taskFromPr(RULE_CREATED + 1000);

      yield* applyTaskRules([rule]);
      const second = yield* applyTaskRules([rule]);

      assert.strictEqual(yield* statusOf(task.id), "needs_review");
      assert.strictEqual(model.calls(), 1);
      assert.deepInclude(second, { applied: 0, notMatched: 0, alreadyJudged: 1 });
    }).pipe(Effect.provide(Layer.merge(TestDatabase, model.layer)));
  });

  it.effect("紐づく事実に新しい出来事があれば、新しいきっかけとして判定し直す", () => {
    const model = deciding(() => 0.3);
    return Effect.gen(function* () {
      const { item } = yield* taskFromPr(RULE_CREATED + 1000);
      yield* applyTaskRules([rule]);

      yield* TestClock.setTime(RULE_CREATED + 2000);
      yield* (yield* SourceItemRepository).recordActivity(item.id, "changed");
      yield* applyTaskRules([rule]);

      assert.strictEqual(model.calls(), 2);
    }).pipe(Effect.provide(Layer.merge(TestDatabase, model.layer)));
  });

  it.effect("ルールを作る前にできた Task には当てない", () => {
    const model = deciding(() => 0.95);
    return Effect.gen(function* () {
      const { task } = yield* taskFromPr(RULE_CREATED - 1000);

      yield* applyTaskRules([rule]);

      assert.strictEqual(yield* statusOf(task.id), "needs_review");
      assert.strictEqual(model.calls(), 0);
    }).pipe(Effect.provide(Layer.merge(TestDatabase, model.layer)));
  });

  it.effect("Decisions を呼べなければ記録せず、次の回に判定し直す（呼べなかったのを「当てはまらない」と残さない）", () => {
    let failing = true;
    const model = deciding(() => (failing ? "fail" : 0.95));
    return Effect.gen(function* () {
      const { task } = yield* taskFromPr(RULE_CREATED + 1000);

      yield* applyTaskRules([rule]);
      failing = false;
      yield* applyTaskRules([rule]);

      assert.strictEqual(yield* statusOf(task.id), "done");
    }).pipe(Effect.provide(Layer.merge(TestDatabase, model.layer)));
  });

  it.effect("片付いた Task（完了・対象外）には当てない", () => {
    const model = deciding(() => 0.95);
    return Effect.gen(function* () {
      const { task } = yield* taskFromPr(RULE_CREATED + 1000);
      yield* (yield* TaskRepository).updateTask(task.id, { status: "dismissed" }, "user");

      yield* applyTaskRules([{ ...rule, actions: { task: "todo" } }]);

      assert.strictEqual(yield* statusOf(task.id), "dismissed");
      assert.strictEqual(model.calls(), 0);
    }).pipe(Effect.provide(Layer.merge(TestDatabase, model.layer)));
  });

  it.effect("無効なルール・Task への操作がないルール・分け直していないルールは当てない", () => {
    const model = deciding(() => 0.95);
    return Effect.gen(function* () {
      yield* taskFromPr(RULE_CREATED + 1000);

      yield* applyTaskRules([
        { ...rule, enabled: false },
        { ...rule, id: "r2", actions: { gmail: { markRead: true } } },
        { ...rule, id: "r3", when: "書き換えた条件" },
      ]);

      assert.strictEqual(model.calls(), 0);
    }).pipe(Effect.provide(Layer.merge(TestDatabase, model.layer)));
  });
});
