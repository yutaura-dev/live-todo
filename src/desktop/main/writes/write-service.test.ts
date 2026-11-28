import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { fromDrafts } from "../../../domain/plan/plan.js";
import { complete, create, revisePlan } from "../../../domain/task/task.js";
import { capture } from "../../../domain/source-item/source-item.js";
import { effectsFact } from "../task-service.js";
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
import { checklistOf, WriteService, writes } from "./write-service.js";
import { effectsOf } from "../../../domain/plan/plan.js";

function layerWith(opts: { inspect?: () => Inspection; outcome?: WriteOutcome; outcomeOf?: () => WriteOutcome } = {}) {
  const executed: string[] = [];
  const provider = Layer.succeed(
    WriteProvider,
    WriteProvider.of({
      inspect: () => Effect.succeed(opts.inspect?.() ?? { ready: "書き込める", version: "abc", summary: "squash で merge する", reason: null }),
      execute: (uri) =>
        Effect.sync(() => {
          executed.push(uri);
          return opts.outcomeOf?.() ?? opts.outcome ?? { ok: true };
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
const shownNow = Effect.gen(function* () {
  return checklistOf(effectsOf(Option.getOrThrow(yield* (yield* TaskStore).find("t1")).plan!));
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

  describe("完了したときにすること", () => {
    const seedWaiting = Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
      let n = 0;
      const { plan } = fromDrafts(
        {
          type: "serial",
          items: [
            { title: "直す", effort: "easy", due: null, completes: true, how: { type: "human" } },
            { kind: "completionEffect", title: "PR を merge する", subjectUri: "github://me@github.com/acme/app/pull/42", operation: "github.merge", paramsJson: "{}" },
            { kind: "completionEffect", title: "別の PR を merge する", subjectUri: "github://me@github.com/acme/app/pull/43", operation: "github.merge", paramsJson: "{}" },
          ],
        },
        () => `n${++n}`,
      );
      const planned = yield* revisePlan(yield* create({ id: "t1", title: "直して merge する", actor: { kind: "user" }, origin: "手で足した" }), { kind: "agent" }, plan);
      const waiting = yield* complete(planned, { kind: "user" }, "自分で完了にした", { effects: effectsFact(planned), added: "足した項目はすべて済んだ" });
      yield* (yield* TaskStore).save(waiting);
      return waiting;
    });

    it.effect("完了したときにすることがあれば、完了にすると完了待ちになり、まだ書き込まない", () => {
      const { executed, layer } = layerWith();
      return Effect.gen(function* () {
        assert.strictEqual((yield* seedWaiting).status, "完了待ち");
        assert.deepStrictEqual(executed, []);
      }).pipe(Effect.provide(layer));
    });

    it.effect("完了のボタンを押すと ☑ が付いているものだけ書き込み、すべて済んだら Task が終わる", () => {
      const { executed, layer } = layerWith();
      return Effect.gen(function* () {
        yield* seedWaiting;
        const service = yield* WriteService;
        yield* service.effectAction("t1", "n3", "uncheck");
        assert.deepStrictEqual(yield* service.confirmCompletion("t1", yield* shownNow), { ok: true, value: null });
        assert.deepStrictEqual(executed, ["github://me@github.com/acme/app/pull/42"]);
        const task = yield* taskOf;
        assert.deepStrictEqual({ status: task.status, closure: task.closure }, { status: "終わった", closure: { outcome: "done", reason: "自分で完了にした" } });
      }).pipe(Effect.provide(layer));
    });

    it.effect("見せたあとにチェックリストが変わっていたら、書き込まずに断る（見せ直す）", () => {
      const { executed, layer } = layerWith();
      return Effect.gen(function* () {
        yield* seedWaiting;
        const service = yield* WriteService;
        const shown = yield* shownNow;
        yield* service.effectAction("t1", "n3", "uncheck");
        assert.deepStrictEqual(yield* service.confirmCompletion("t1", shown), { ok: false, reason: "見せたチェックリストが今も同じときだけ（見せたあとに足された・取りやめたものがあれば、見せ直す）" });
        assert.deepStrictEqual(executed, []);
      }).pipe(Effect.provide(layer));
    });

    it.effect("書き込めなかったものは完了待ちに残り、もう一度頼んで書けたら終わる", () => {
      let ok = false;
      const { executed, layer } = layerWith({ outcomeOf: () => (ok ? { ok: true } : { ok: false, kind: "書き込み先のエラー", message: "GitHub が断った" }) });
      return Effect.gen(function* () {
        yield* seedWaiting;
        const service = yield* WriteService;
        yield* service.effectAction("t1", "n3", "uncheck");
        yield* service.confirmCompletion("t1", yield* shownNow);
        assert.strictEqual((yield* taskOf).status, "完了待ち");
        ok = true;
        yield* service.effectAction("t1", "n2", "retry");
        assert.strictEqual((yield* taskOf).status, "終わった");
        assert.strictEqual(executed.length, 2);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("自動でやってよい範囲", () => {
    const seedAuto = (subjectUri: string, ownFact = false) =>
      Effect.gen(function* () {
        if (ownFact) {
          const item = yield* capture({ id: "s1", uri: subjectUri, url: null, stream: "通知", snapshot: { title: "PR", author: "alice", fact: { trusted: [], body: "" }, sourceUpdatedAt: null } }, { kind: "sync" });
          yield* (yield* SourceItemStore).save(item, { accountId: "a", externalId: "pr42" });
        }
        yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
        const { plan } = fromDrafts(
          { type: "serial", items: [{ title: "merge する", effort: "easy", due: null, completes: true, how: { type: "write", subjectUri, operation: "github.merge", paramsJson: "{}", trigger: "auto" } }] },
          () => "a1",
        );
        const task = yield* revisePlan(yield* create({ id: "t1", title: "merge する", actor: { kind: "user" }, origin: "手で足した" }), { kind: "agent" }, plan);
        yield* (yield* TaskStore).save(ownFact ? { ...task, sourceItemIds: ["s1"] } : task);
      });

    it.effect("上限を決めていない操作は、外へは自動で書き込まない", () => {
      const { executed, layer } = layerWith({ inspect: () => ({ ready: "書き込める", version: null, summary: "merge", reason: null }) });
      return Effect.gen(function* () {
        yield* seedAuto("github://me@github.com/acme/app/pull/42");
        assert.deepStrictEqual(yield* (yield* WriteService).autoRun(), []);
        assert.deepStrictEqual(executed, []);
      }).pipe(Effect.provide(layer));
    });

    it.effect("上限を本番まで上げても、その Task の事実でない対象には自動で書き込まない", () => {
      const { executed, layer } = layerWith({ inspect: () => ({ ready: "書き込める", version: null, summary: "merge", reason: null }) });
      return Effect.gen(function* () {
        yield* seedAuto("github://me@github.com/acme/app/pull/42");
        const service = yield* WriteService;
        yield* service.setLimit("github.merge", "外への書き込み（本番）");
        assert.deepStrictEqual(yield* service.autoRun(), []);
        assert.deepStrictEqual(executed, []);
      }).pipe(Effect.provide(layer));
    });

    it.effect("版を持つ操作は、計画を立てたときの版を確かめられないので、自動では書き込まない（fail closed）", () => {
      const { executed, layer } = layerWith();
      return Effect.gen(function* () {
        yield* seedAuto("github://me@github.com/acme/app/pull/42");
        const service = yield* WriteService;
        yield* service.setLimit("github.merge", "外への書き込み（本番）");
        assert.deepStrictEqual(yield* service.autoRun(), []);
        assert.deepStrictEqual(executed, []);
      }).pipe(Effect.provide(layer));
    });

    it.effect("範囲に入り、その Task の事実そのもので、版を持たないなら、自動で 1 回だけ書き込み、そのときの上限を残す", () => {
      const { executed, layer } = layerWith({ inspect: () => ({ ready: "書き込める", version: null, summary: "merge", reason: null }) });
      return Effect.gen(function* () {
        yield* seedAuto("github://me@github.com/acme/app/pull/42", true);
        const service = yield* WriteService;
        yield* service.setLimit("github.merge", "外への書き込み（本番）");
        assert.deepStrictEqual(yield* service.autoRun(), ["t1"]);
        assert.deepStrictEqual(yield* service.autoRun(), []);
        assert.deepStrictEqual(executed, ["github://me@github.com/acme/app/pull/42"]);
        const [write] = yield* writes.all();
        assert.deepStrictEqual(write?.approval?.policy, { operation: "github.merge", limit: "外への書き込み（本番）" });
        assert.strictEqual((yield* taskOf).status, "終わった");
      }).pipe(Effect.provide(layer));
    });

    it.effect("ない操作の上限は決められない", () => {
      const { layer } = layerWith();
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* (yield* WriteService).setLimit("rm.rf", "調べる"), { ok: false, reason: "その操作はありません" });
      }).pipe(Effect.provide(layer));
    });

    it.effect("決めた上限を、操作ごとに見せる", () => {
      const { layer } = layerWith();
      return Effect.gen(function* () {
        const service = yield* WriteService;
        yield* service.setLimit("github.merge", "外への書き込み（下書き）");
        assert.deepStrictEqual((yield* service.autonomy()).map((row) => [row.operation, row.limit]), [
          ["github.merge", "外への書き込み（下書き）"],
          ["claude-code.read", null],
          ["claude-code.fix", null],
        ]);
      }).pipe(Effect.provide(layer));
    });
  });
});
