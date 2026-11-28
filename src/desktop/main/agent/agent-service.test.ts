import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { DateTime, Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as RunSpec from "../../../../specs/agent-run.spec.ts";
import * as ItemSpec from "../../../../specs/action-item.spec.ts";
import { type Definition, fromDrafts, turnOf } from "../../../domain/plan/plan.js";
import { complete, create, revisePlan } from "../../../domain/task/task.js";
import { type AgentEvent, AgentRunner, type AgentRunRequest } from "../../../llm/agent/agent.js";
import { answered, unanswered } from "../../../llm/shared/answer.js";
import { generationTest } from "../../../llm/generation/test-double.js";
import { rewriteTaskWriting } from "../../../llm/generation/writings/index.js";
import { StoreDatabase } from "../../../store/database.js";
import { DocumentStore } from "../../../store/document-store.js";
import { PrioritizationStore } from "../../../store/prioritization-store.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { TaskStore } from "../../../store/task-store.js";
import { AiServices } from "../ai/ai-services.js";
import { Planner } from "../plan/planner.js";
import { Calendar, Prioritizer } from "../prioritizer.js";
import { sequentialIds } from "../task-service.js";
import { agentRuns, AgentService } from "./agent-service.js";

const finished = (text: string): AgentEvent => ({ type: "終わった", outcome: { type: "回答", text } });
const DEFAULT_EVENTS: ReadonlyArray<AgentEvent> = [{ type: "始まった", sessionId: "sess-1" }, { type: "進んだ", text: "CI のログを読んでいる" }, finished("型エラーで落ちている")];

function layerWith(opts: { events?: (request: AgentRunRequest) => Stream.Stream<AgentEvent>; rewrite?: () => ReturnType<typeof answered> | ReturnType<typeof unanswered>; inactive?: boolean } = {}) {
  const requests: AgentRunRequest[] = [];
  const runner = Layer.succeed(
    AgentRunner,
    AgentRunner.of({
      run: (request) =>
        Stream.suspend(() => {
          requests.push(request);
          return opts.events?.(request) ?? Stream.fromIterable(DEFAULT_EVENTS);
        }),
      askToStop: () => Effect.succeed(unanswered("Missing")),
    }),
  );
  const g = generationTest({ [rewriteTaskWriting.purpose]: () => opts.rewrite?.() ?? answered({ title: null, brief: "CI は型エラーで落ちている。直すか決める", plan: null }) });
  const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer, SourceItemStore.layer, DocumentStore.layer).pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));
  const ai = Layer.effect(
    AiServices,
    Effect.map(AiServices, (services) => AiServices.of({ ...services, active: Effect.succeed(!opts.inactive) })),
  ).pipe(Layer.provide(AiServices.fromContext), Layer.provide(g.layer));
  const prioritizer = Prioritizer.layer.pipe(Layer.provideMerge(ai), Layer.provide(Calendar.fixed({ today: "2026-11-28", timeZone: "Asia/Tokyo" })));
  const core = Layer.mergeAll(prioritizer, sequentialIds("r"), runner).pipe(Layer.provideMerge(stores));
  return { requests, layer: AgentService.layer.pipe(Layer.provideMerge(Layer.mergeAll(core, Planner.layer.pipe(Layer.provide(core))))) };
}

const claude = (title: string, opts: { trigger?: "auto" | "on_request"; tools?: "読むだけ" | "直す"; completes?: boolean } = {}): Definition => ({
  title,
  effort: "easy",
  due: null,
  completes: opts.completes ?? true,
  how: { type: "claude", tools: opts.tools ?? "読むだけ", trigger: opts.trigger ?? "on_request" },
});
const human = (title: string): Definition => ({ title, effort: "easy", due: null, completes: false, how: { type: "human" } });

const seed = (items: ReadonlyArray<Definition> = []) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
    let n = 0;
    const created = yield* create({ id: "t1", title: "CI を直す", actor: { kind: "user" }, origin: "手で足した" });
    const task = items.length === 0 ? created : yield* revisePlan(created, { kind: "agent" }, fromDrafts({ type: "serial", items: [...items] }, () => `a${++n}`).plan);
    yield* (yield* TaskStore).save(task);
  });
const taskOf = Effect.gen(function* () {
  return Option.getOrThrow(yield* (yield* TaskStore).find("t1"));
});
const runningNow = (n: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      if ((yield* agentRuns.all()).filter((r) => r.status === "やっている").length >= n) return;
      yield* Effect.yieldNow;
    }
    assert.fail("作業が始まらなかった");
  });
const drain = Effect.gen(function* () {
  yield* Fiber.joinAll(yield* (yield* AgentService).pump());
});

describe("AgentService（Task について Claude Code に頼む）", () => {
  it.effect("質問を頼むと、まだ Claude Code を起動せずに待ち行列に入れる", () => {
    const { requests, layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed();
      const reply = yield* (yield* AgentService).ask("t1", "なぜ CI が落ちている？");
      assert.deepStrictEqual(reply.ok ? [reply.value.status, reply.value.tools, reply.value.trigger] : reply, ["待ち行列", "読むだけ", "ユーザーが頼んだ"]);
      assert.deepStrictEqual(requests, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("順番が来たら読むだけの道具で起動し、成果を Generation が Task の言葉にする", () => {
    const { requests, layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      yield* service.ask("t1", "なぜ CI が落ちている？");
      yield* drain;
      assert.deepStrictEqual(requests.map((r) => [r.kind, r.tools, r.sessionId, r.request]), [["質問に答える", "読むだけ", null, "なぜ CI が落ちている？"]]);
      const [run] = yield* service.runsOf("t1");
      assert.deepStrictEqual([run?.status, run?.result, run?.progress], ["終わった", "型エラーで落ちている", ["CI のログを読んでいる"]]);
      const task = yield* taskOf;
      assert.strictEqual(task.brief, "CI は型エラーで落ちている。直すか決める");
      const work = task.history.flatMap((a) => a.changes.filter((c) => c.field === "AI の作業").map((c) => [c.after, a.cause]));
      assert.deepStrictEqual(work, [["始まった", `agent-run:${run?.id}`], ["終わった", `agent-run:${run?.id}`]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("AI 設定が使えないあいだは、Claude Code を起動せずに待ち行列のまま置く", () => {
    const { requests, layer } = layerWith({ inactive: true });
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      yield* service.ask("t1", "なぜ？");
      yield* drain;
      assert.deepStrictEqual([requests.length, (yield* service.runsOf("t1"))[0]?.status], [0, "待ち行列"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("作業が進んだ・終わったら、画面に知らせる", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      const changed: string[] = [];
      yield* service.onChanged((taskId) => changed.push(taskId));
      yield* service.ask("t1", "なぜ？");
      yield* drain;
      assert.isAtLeast(changed.length, 3);
      assert.deepStrictEqual([...new Set(changed)], ["t1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("次の作業は、同じ会話を続ける", () => {
    const { requests, layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      yield* service.ask("t1", "なぜ CI が落ちている？");
      yield* drain;
      yield* service.ask("t1", "どのファイル？");
      yield* drain;
      assert.deepStrictEqual(requests.map((r) => r.sessionId), [null, "sess-1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("成果を Task の言葉にできなかったら、黙って変えずに「確かめる」を書く", () => {
    const { layer } = layerWith({ rewrite: () => unanswered("Refused") });
    return Effect.gen(function* () {
      yield* seed();
      yield* (yield* AgentService).ask("t1", "なぜ CI が落ちている？");
      yield* drain;
      assert.strictEqual((yield* taskOf).brief, "AI の作業の成果が届いた。確かめる");
    }).pipe(Effect.provide(layer));
  });

  it.effect("うまくいかなかったら止まったにし、Task には作業をやめたことだけを残す", () => {
    const { layer } = layerWith({ events: () => Stream.fromIterable<AgentEvent>([{ type: "始まった", sessionId: "s" }, { type: "やめた", reason: "うまくいかなかった" }]) });
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      yield* service.ask("t1", "なぜ CI が落ちている？");
      yield* drain;
      const [run] = yield* service.runsOf("t1");
      assert.deepStrictEqual([run?.status, run?.stopReason], ["止まった", "うまくいかなかった"]);
      const task = yield* taskOf;
      assert.deepStrictEqual([task.brief, task.history.at(-1)?.changes[0]?.after], [null, "やめた"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("成果も、やめた知らせもなく終わったら、うまくいかなかったにする（黙って終わらせない）", () => {
    const { layer } = layerWith({ events: () => Stream.fromIterable<AgentEvent>([{ type: "始まった", sessionId: "s" }]) });
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      yield* service.ask("t1", "なぜ？");
      yield* drain;
      assert.deepStrictEqual((yield* service.runsOf("t1")).map((r) => [r.status, r.stopReason]), [["止まった", "うまくいかなかった"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("完了待ち・終わった Task には、作業を頼まない", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed();
      const tasks = yield* TaskStore;
      yield* tasks.save(yield* complete(yield* taskOf, { kind: "user" }, "自分で完了にした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" }));
      assert.deepStrictEqual(yield* (yield* AgentService).ask("t1", "なぜ？"), { ok: false, reason: "Task がやること のときだけ（完了待ち・終わった Task には頼まない）" });
    }).pipe(Effect.provide(layer));
  });

  it.effect(specOf(RunSpec.start, "この Task で、ほかに動いている作業がないときだけ（同時に動くのは 1 つまで）"), () => {
    const { requests, layer } = layerWith({ events: () => Stream.concat(Stream.make({ type: "始まった", sessionId: "s" } as AgentEvent), Stream.never) });
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      yield* service.ask("t1", "1 つめ");
      yield* service.ask("t1", "2 つめ");
      yield* service.pump();
      yield* runningNow(1);
      yield* service.pump();
      yield* Effect.yieldNow;
      assert.deepStrictEqual((yield* service.runsOf("t1")).map((r) => r.status), ["やっている", "待ち行列"]);
      assert.strictEqual(requests.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(specOf(RunSpec.stop, "やっている・判断中のときだけ") + "（ユーザーが止めたら、Claude Code を止めて止まったにする）", () => {
    const { layer } = layerWith({ events: () => Stream.concat(Stream.make({ type: "始まった", sessionId: "s" } as AgentEvent), Stream.never) });
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      const asked = yield* service.ask("t1", "なぜ？");
      const id = asked.ok ? asked.value.id : "";
      assert.deepStrictEqual(yield* service.stop(id), { ok: false, reason: "やっている・判断中のときだけ" });
      const fibers = yield* service.pump();
      yield* runningNow(1);
      assert.deepStrictEqual(yield* service.stop(id), { ok: true, value: null });
      yield* Fiber.joinAll(fibers);
      assert.deepStrictEqual((yield* service.runsOf("t1")).map((r) => [r.status, r.stopReason]), [["止まった", "ユーザーが止めた"]]);
      assert.strictEqual((yield* taskOf).history.at(-1)?.changes[0]?.after, "やめた");
    }).pipe(Effect.provide(layer));
  });

  it.effect(specOf(RunSpec.cancel, "待ち行列のときだけ") + "（待ち行列のうちなら取り消せる）", () => {
    const { requests, layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      const asked = yield* service.ask("t1", "なぜ？");
      const id = asked.ok ? asked.value.id : "";
      assert.deepStrictEqual(yield* service.cancel(id), { ok: true, value: null });
      yield* drain;
      assert.deepStrictEqual([(yield* service.runsOf("t1"))[0]?.status, requests.length], ["取り消した", 0]);
      assert.deepStrictEqual(yield* service.cancel(id), { ok: false, reason: "待ち行列のときだけ" });
    }).pipe(Effect.provide(layer));
  });

  it.effect(specOf(RunSpec.fail, "やっている・判断中のときだけ") + "（起動したとき、やっているまま残っていた作業は、アプリを閉じたので止まったにする）", () => {
    const { layer } = layerWith({ events: () => Stream.concat(Stream.make({ type: "始まった", sessionId: "s" } as AgentEvent), Stream.never) });
    return Effect.gen(function* () {
      yield* seed();
      const service = yield* AgentService;
      yield* service.ask("t1", "なぜ？");
      yield* service.pump();
      yield* runningNow(1);
      yield* service.recover();
      assert.deepStrictEqual((yield* agentRuns.all()).map((r) => [r.status, r.stopReason]), [["止まった", "アプリを閉じた"]]);
    }).pipe(Effect.provide(layer));
  });
});

describe("AgentService（計画の Claude Code の Action Item）", () => {
  it.effect("ボタンで頼んだ作業がやり遂げたら、番が来ている Action Item を果たし、完了条件を満たした Task を終える", () => {
    const { requests, layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed([claude("CI のログを読む")]);
      const service = yield* AgentService;
      const reply = yield* service.requestFromItem("t1", "a1");
      assert.deepStrictEqual(reply.ok ? [reply.value.trigger, reply.value.actionItemId] : reply, ["Action Item から", "a1"]);
      yield* drain;
      assert.deepStrictEqual(requests.map((r) => [r.kind, r.item?.id]), [["Action Item をやる（読むだけ）", "a1"]]);
      const task = yield* taskOf;
      assert.deepStrictEqual([turnOf(task.plan!, "a1"), task.status], ["済んだ", "終わった"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(specOf(ItemSpec.succeed, "番が来ているときだけ（番が来る前にやり遂げたら、番が来るまで待つ）") + "（番が来たら果たす）", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed([human("先に読む"), claude("CI のログを読む")]);
      const service = yield* AgentService;
      yield* service.requestFromItem("t1", "a2");
      yield* drain;
      assert.strictEqual(turnOf((yield* taskOf).plan!, "a2"), "番待ち");
      yield* (yield* Planner).act("t1", { _tag: "CompleteItem", itemId: "a1" });
      yield* service.settleFinished("t1");
      assert.strictEqual(turnOf((yield* taskOf).plan!, "a2"), "済んだ");
    }).pipe(Effect.provide(layer));
  });

  it.effect(specOf(ItemSpec.request, "この Action Item の作業が終わっているときだけ（待ち行列も含む）"), () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed([claude("CI のログを読む")]);
      const service = yield* AgentService;
      yield* service.requestFromItem("t1", "a1");
      assert.deepStrictEqual(yield* service.requestFromItem("t1", "a1"), { ok: false, reason: "この Action Item の作業が終わっているときだけ（待ち行列も含む）" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("直す作業は、作業場所を用意できるようになるまで頼まない（fail closed）", () => {
    const { requests, layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed([claude("型エラーを直す", { tools: "直す" })]);
      const reply = yield* (yield* AgentService).requestFromItem("t1", "a1");
      assert.deepStrictEqual([reply.ok, requests.length], [false, 0]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(specOf(ItemSpec.autoStart, "自動でやる Action Item だけ") + "（番が来た自動でやる Action Item は、一度だけ自動で頼む）", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed([claude("変更点を読む", { trigger: "auto", completes: false }), human("返事する")]);
      const service = yield* AgentService;
      assert.deepStrictEqual(yield* service.autoStart(), ["t1"]);
      assert.deepStrictEqual(yield* service.autoStart(), []);
      assert.deepStrictEqual((yield* service.runsOf("t1")).map((r) => [r.trigger, r.actionItemId]), [["Action Item から", "a1"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("ボタンで頼む Action Item は、自動では頼まない", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed([claude("CI のログを読む")]);
      assert.deepStrictEqual(yield* (yield* AgentService).autoStart(), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect(specOf(RunSpec.withdraw, "終わっていないときだけ") + "（ユーザーが Action Item を済ませたら、待ち行列の作業を取り消す）", () => {
    const { layer } = layerWith();
    return Effect.gen(function* () {
      yield* seed([claude("CI のログを読む")]);
      const service = yield* AgentService;
      yield* service.requestFromItem("t1", "a1");
      yield* (yield* Planner).act("t1", { _tag: "CompleteItem", itemId: "a1" });
      yield* service.settleFinished("t1");
      assert.deepStrictEqual((yield* service.runsOf("t1")).map((r) => [r.status, r.stopReason]), [["取り消した", "ユーザーが済ませた"]]);
    }).pipe(Effect.provide(layer));
  });
});
