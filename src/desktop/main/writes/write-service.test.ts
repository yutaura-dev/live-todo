import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { fromDrafts } from "../../../domain/plan/plan.js";
import { create, revisePlan } from "../../../domain/task/task.js";
import { StoreDatabase } from "../../../store/database.js";
import { DocumentStore } from "../../../store/document-store.js";
import { PrioritizationStore } from "../../../store/prioritization-store.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { TaskStore } from "../../../store/task-store.js";
import { AiServices } from "../ai/ai-services.js";
import { Planner } from "../plan/planner.js";
import { Calendar, Prioritizer } from "../prioritizer.js";
import { sequentialIds } from "../task-service.js";
import { type Inspection, WriteProvider, type WriteOutcome } from "./write-provider.js";
import { WriteService, writes } from "./write-service.js";

function layerWith(opts: { inspect?: () => Inspection; outcome?: WriteOutcome } = {}) {
  const executed: string[] = [];
  const provider = Layer.succeed(
    WriteProvider,
    WriteProvider.of({
      inspect: () => Effect.succeed(opts.inspect?.() ?? { ready: "書き込める", version: "abc", summary: "squash で merge する", reason: null }),
      execute: (uri) =>
        Effect.sync(() => {
          executed.push(uri);
          return opts.outcome ?? { ok: true };
        }),
    }),
  );
  const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer, SourceItemStore.layer, DocumentStore.layer).pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));
  const prioritizer = Prioritizer.layer.pipe(Layer.provideMerge(AiServices.fromContext), Layer.provide(Calendar.fixed({ today: "2026-11-28", timeZone: "Asia/Tokyo" })));
  const core = Layer.mergeAll(prioritizer, sequentialIds("w"), provider).pipe(Layer.provideMerge(stores));
  return { executed, layer: WriteService.layer.pipe(Layer.provideMerge(Layer.mergeAll(core, Planner.layer.pipe(Layer.provide(core))))) };
}

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
  const { plan } = fromDrafts(
    { type: "serial", items: [{ title: "merge する", effort: "easy", due: null, completes: true, how: { type: "write", subjectUri: "github://me@github.com/acme/app/pull/42", operation: "github.merge", paramsJson: '{"method":"squash"}', trigger: "on_request" } }] },
    () => "a1",
  );
  const task = yield* revisePlan(yield* create({ id: "t1", title: "PR を merge する", actor: { kind: "user" }, origin: "手で足した" }), { kind: "agent" }, plan);
  yield* (yield* TaskStore).save(task);
});
const taskOf = Effect.gen(function* () {
  return Option.getOrThrow(yield* (yield* TaskStore).find("t1"));
});

describe("WriteService（承認がなければ書き込まない）", () => {
  it.effect("Action Item から頼むと、書き込まずに中身を見せて承認待ちにする", () => {
    const { executed, layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed;
      const reply = yield* (yield* WriteService).requestFromItem("t1", "a1");
      assert.deepStrictEqual(reply.ok ? [reply.value.stage, reply.value.summary] : reply, ["承認待ち", "squash で merge する"]);
      assert.deepStrictEqual(executed, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("承認したら書き込み、書けたら Action Item を果たして、完了条件を満たした Task を終える", () => {
    const { executed, layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed;
      const service = yield* WriteService;
      const reply = yield* service.requestFromItem("t1", "a1");
      const done = yield* service.approve(reply.ok ? reply.value.id : "");
      assert.deepStrictEqual(done.ok ? done.value.stage : done, "書き込んだ");
      assert.deepStrictEqual(executed, ["github://me@github.com/acme/app/pull/42"]);
      const task = yield* taskOf;
      assert.deepStrictEqual({ status: task.status, closure: task.closure }, { status: "終わった", closure: { outcome: "done", reason: "完了条件を満たした" } });
    }).pipe(Effect.provide(layer));
  });

  it.effect("見せたあとに版が変わっていたら、承認できない（書き込まない）", () => {
    let version = "abc";
    const { executed, layer } = layerWith({ inspect: () => ({ ready: "書き込める", version, summary: "merge", reason: null }) });
    return Effect.gen(function* () {
      yield* seed;
      const service = yield* WriteService;
      const reply = yield* service.requestFromItem("t1", "a1");
      version = "def";
      assert.deepStrictEqual(yield* service.approve(reply.ok ? reply.value.id : ""), { ok: false, reason: "見せた版が今も同じときだけ" });
      assert.deepStrictEqual(executed, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("書き込めなかったら理由を残し、Task の今の状況に何をすればよいかを書く", () => {
    const { layer } = layerWith({ outcome: { ok: false, kind: "権限が足りない", message: "merge する権限がありません" } });
    return Effect.gen(function* () {
      yield* seed;
      const service = yield* WriteService;
      const reply = yield* service.requestFromItem("t1", "a1");
      const failed = yield* service.approve(reply.ok ? reply.value.id : "");
      assert.deepStrictEqual(failed.ok ? [failed.value.stage, failed.value.failure] : failed, ["失敗", "merge する権限がありません"]);
      assert.strictEqual((yield* taskOf).brief, "書き込めなかった（merge する権限がありません）。直してから、もう一度頼む");
    }).pipe(Effect.provide(layer));
  });

  it.effect("同じ Action Item に、終わっていない書き込みがあれば、もう頼めない", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed;
      const service = yield* WriteService;
      yield* service.requestFromItem("t1", "a1");
      assert.deepStrictEqual(yield* service.requestFromItem("t1", "a1"), { ok: false, reason: "その Action Item に、終わっていない書き込みがないときだけ" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("起動したとき書き込み中のまま残っていたら、やり直さずに、確かめられないとして失敗にする", () => {
    const { executed, layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed;
      const service = yield* WriteService;
      const reply = yield* service.requestFromItem("t1", "a1");
      const asked = Option.getOrThrow(yield* writes.find(reply.ok ? reply.value.id : ""));
      yield* writes.save({ ...asked, stage: "書き込み中" });
      yield* service.recover();
      assert.deepStrictEqual(Option.map(yield* writes.find(asked.id), (w): ReadonlyArray<string | undefined> => [w.stage, w.failure?.kind]), Option.some<ReadonlyArray<string | undefined>>(["失敗", "書けたか確かめられない"]));
      assert.deepStrictEqual(executed, []);
    }).pipe(Effect.provide(layer));
  });
});
