import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { propose } from "../../../domain/proposal/task-proposal.js";
import { route, startRouting } from "../../../domain/routing/routing.js";
import { capture } from "../../../domain/source-item/source-item.js";
import { create } from "../../../domain/task/task.js";
import { StoreDatabase } from "../../../store/database.js";
import { DocumentStore } from "../../../store/document-store.js";
import { PrioritizationStore } from "../../../store/prioritization-store.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { TaskStore } from "../../../store/task-store.js";
import { AiServices } from "../ai/ai-services.js";
import { proposals, routings } from "../ingest/router.js";
import { Calendar, Prioritizer } from "../prioritizer.js";
import { sequentialIds } from "../task-service.js";
import { ProposalService } from "./proposal-service.js";
import { Planner } from "../plan/planner.js";

const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer, SourceItemStore.layer, DocumentStore.layer).pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));
const prioritizer = Prioritizer.layer.pipe(Layer.provide(AiServices.fromContext), Layer.provide(Calendar.fixed({ today: "2026-11-28", timeZone: "Asia/Tokyo" })));
const core = Layer.mergeAll(prioritizer, sequentialIds("t"), AiServices.fromContext).pipe(Layer.provideMerge(stores));
const layer = ProposalService.layer.pipe(Layer.provideMerge(Layer.mergeAll(core, Planner.layer.pipe(Layer.provide(core)))));

const seed = (kind: "新しい Task" | "既存の Task に足す") =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
    const item = yield* capture(
      { id: "s1", uri: "github://me@github.com/acme/app/pull/42", url: "https://github.com/acme/app/pull/42", stream: "通知", snapshot: { title: "Fix login", author: "alice", fact: { trusted: [{ key: "状態", value: "開いている" }], body: "" }, sourceUpdatedAt: null } },
      { kind: "sync" },
    );
    yield* (yield* SourceItemStore).save(item, { accountId: "a", externalId: "pr42" });
    yield* (yield* TaskStore).save(yield* create({ id: "t0", title: "ログインを直す", actor: { kind: "user" }, origin: "手で足した" }));
    yield* proposals.save(
      yield* propose({ id: "p1", kind, title: "PR #42 をレビューする", brief: "頼まれた", targetTaskId: kind === "新しい Task" ? null : "t0", sourceItemId: "s1", judgment: "j" }, { kind: "agent" }),
    );
  });

describe("ProposalService（提案を受け入れる・見送る、決められなかった事実を振り分ける）", () => {
  it.effect("新しい Task の提案を受け入れると、事実を持った Task を「提案を受け入れた」で作る", () =>
    Effect.gen(function* () {
      yield* seed("新しい Task");
      const reply = yield* (yield* ProposalService).accept("p1");
      const task = Option.getOrThrow(yield* (yield* TaskStore).find(reply.ok ? reply.value.taskId : ""));
      assert.deepStrictEqual({ title: task.title, facts: task.sourceItemIds, origin: task.history[0]?.cause }, { title: "PR #42 をレビューする", facts: ["s1"], origin: "提案を受け入れた" });
      assert.deepStrictEqual(yield* (yield* ProposalService).list(), []);
    }).pipe(Effect.provide(layer)));

  it.effect("既存の Task に足す提案を受け入れると、寄せ先の Task に事実を持たせる", () =>
    Effect.gen(function* () {
      yield* seed("既存の Task に足す");
      yield* (yield* ProposalService).accept("p1");
      assert.deepStrictEqual(Option.getOrThrow(yield* (yield* TaskStore).find("t0")).sourceItemIds, ["s1"]);
    }).pipe(Effect.provide(layer)));

  it.effect("見送った提案は、閉じた一覧に残す（もとの事実が開いている間は消さない）", () =>
    Effect.gen(function* () {
      yield* seed("新しい Task");
      yield* (yield* ProposalService).decline("p1");
      assert.deepStrictEqual((yield* (yield* ProposalService).list()).map((p) => p.status), ["見送った"]);
      assert.deepStrictEqual(yield* (yield* ProposalService).accept("p1"), { ok: false, reason: "提案中のときだけ" });
    }).pipe(Effect.provide(layer)));

  it.effect("AI が決められなかった事実を、ユーザーが新しい Task にする", () =>
    Effect.gen(function* () {
      yield* seed("新しい Task");
      yield* routings.save({ ...(yield* route(yield* startRouting("s1", { kind: "sync" }), { kind: "agent" }, "判断できなかった", "j")), id: "s1" });
      assert.deepStrictEqual((yield* (yield* ProposalService).undecided()).map((f) => f.id), ["s1"]);
      const reply = yield* (yield* ProposalService).routeFact("s1", { _tag: "NewTask" });
      assert.isTrue(reply.ok && reply.value.taskId !== null);
      assert.deepStrictEqual(yield* (yield* ProposalService).undecided(), []);
    }).pipe(Effect.provide(layer)));
});
