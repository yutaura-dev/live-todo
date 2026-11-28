import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { StoreDatabase } from "../../../store/database.js";
import { DocumentStore } from "../../../store/document-store.js";
import { PrioritizationStore } from "../../../store/prioritization-store.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { TaskStore } from "../../../store/task-store.js";
import { AiServices } from "../ai/ai-services.js";
import { Ingestor, type ObservedChange } from "../ingest/ingestor.js";
import { Router, routings } from "../ingest/router.js";
import { Receiver } from "../ingest/receiver.js";
import { Calendar, Prioritizer } from "../prioritizer.js";
import { sequentialIds } from "../task-service.js";
import { Planner } from "../plan/planner.js";
import { AccountService, accounts, githubSecretOf } from "./account-service.js";
import { SourceFetchError, SourceGateway } from "./gateway.js";
import { backoffAfter, SyncRunner, syncs } from "./sync-runner.js";

const pr: ObservedChange = {
  kind: "upserted",
  item: {
    externalId: "pr42",
    uri: "github://me@github.com/acme/app/pull/42",
    url: null,
    stream: "通知",
    snapshot: { title: "Fix login", author: "alice", fact: { trusted: [{ key: "状態", value: "開いている" }], body: "" }, sourceUpdatedAt: null },
  },
};

function layerWith(fetch: () => Effect.Effect<{ changes: ReadonlyArray<ObservedChange>; nextCursor: unknown }, SourceFetchError>, viewer: Option.Option<{ login: string; teams: string[] }> = Option.some({ login: "me", teams: [] })) {
  const stores = Layer.mergeAll(TaskStore.layer, PrioritizationStore.layer, SourceItemStore.layer, DocumentStore.layer).pipe(Layer.provideMerge(StoreDatabase.layer({ filename: ":memory:" })));
  const gateway = Layer.succeed(SourceGateway, SourceGateway.of({ githubViewer: () => Effect.succeed(viewer), fetch: () => fetch() }));
  const ai = AiServices.fromContext;
  const prioritizer = Prioritizer.layer.pipe(Layer.provideMerge(ai), Layer.provide(Calendar.fixed({ today: "2026-11-28", timeZone: "Asia/Tokyo" })));
  const core = Layer.mergeAll(prioritizer, sequentialIds("x"), gateway).pipe(Layer.provideMerge(stores));
  const deps = Layer.mergeAll(core, Planner.layer.pipe(Layer.provide(core)));
  const router = Router.layer.pipe(Layer.provideMerge(deps));
  const ingestor = Ingestor.layer.pipe(Layer.provide(deps));
  const receiver = Receiver.layer.pipe(Layer.provide(deps));
  return Layer.mergeAll(SyncRunner.layer.pipe(Layer.provide(Layer.mergeAll(router, ingestor, receiver))), AccountService.layer.pipe(Layer.provide(deps))).pipe(Layer.provideMerge(router));
}

const start = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
  return yield* (yield* AccountService).addGitHub({ key: "work", label: "会社の GitHub" });
});

describe("アカウントを足してつなぐ", () => {
  it.effect("トークンの持ち主で origin を決め、つないでいるにする", () =>
    Effect.gen(function* () {
      const reply = yield* start;
      assert.deepStrictEqual(reply.ok ? { id: reply.value.id, origin: reply.value.origin, status: reply.value.status, secret: reply.value.secret } : reply, {
        id: "github-work",
        origin: "github://me@github.com",
        status: "つないでいる",
        secret: "LIVE_TODO_SECRET_GITHUB_WORK_TOKEN",
      });
    }).pipe(Effect.provide(layerWith(() => Effect.succeed({ changes: [], nextCursor: null })))));

  it.effect("トークンが通らなければ、どの名前を確かめればよいかを返す", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* start, { ok: false, reason: `トークンが通りません。.env.local の ${githubSecretOf("work")} を確かめてください` });
    }).pipe(Effect.provide(layerWith(() => Effect.succeed({ changes: [], nextCursor: null }), Option.none()))));

  it.effect("同じ GitHub のアカウントは、二度足せない", () =>
    Effect.gen(function* () {
      yield* start;
      assert.deepStrictEqual(yield* (yield* AccountService).addGitHub({ key: "work2", label: "x" }), { ok: false, reason: "同じ GitHub のアカウントを、もう足しています" });
    }).pipe(Effect.provide(layerWith(() => Effect.succeed({ changes: [], nextCursor: null })))));

  it.effect("外したアカウントと同じ GitHub を足し直すと、前の ID のまま戻す", () =>
    Effect.gen(function* () {
      yield* start;
      yield* (yield* AccountService).remove("github-work");
      const again = yield* (yield* AccountService).addGitHub({ key: "other", label: "戻した" });
      assert.deepStrictEqual(again.ok ? [again.value.id, again.value.status] : again, ["github-work", "つないでいる"]);
    }).pipe(Effect.provide(layerWith(() => Effect.succeed({ changes: [], nextCursor: null })))));
});

describe("SyncRunner（時刻が来たアカウントを取り込み、届いた事実を振り分ける）", () => {
  it.effect("取り込んだ事実は振り分けに回し、カーソルを進めて、次は 1 分後にする", () =>
    Effect.gen(function* () {
      yield* start;
      const [outcome] = yield* (yield* SyncRunner).runOnce();
      assert.strictEqual(outcome?.result, "取り込めた");
      const record = Option.getOrThrow(yield* syncs.find("github-work"));
      assert.deepStrictEqual({ cursor: record.cursor, nextRunAt: record.nextRunAt }, { cursor: { since: "x" }, nextRunAt: "2026-11-28T00:01:00.000Z" });
      assert.isTrue(Option.isSome(yield* routings.find("x1")));
    }).pipe(Effect.provide(layerWith(() => Effect.succeed({ changes: [pr], nextCursor: { since: "x" } })))));

  it.effect("次の時刻が来るまでは、取りに行かない", () =>
    Effect.gen(function* () {
      yield* start;
      yield* (yield* SyncRunner).runOnce();
      const [again] = yield* (yield* SyncRunner).runOnce();
      assert.strictEqual(again?.result, "まだ");
    }).pipe(Effect.provide(layerWith(() => Effect.succeed({ changes: [], nextCursor: null })))));

  it.effect("取り込めなければ、カーソルを進めず、間隔を倍ずつ延ばす", () =>
    Effect.gen(function* () {
      yield* start;
      yield* (yield* SyncRunner).runOnce();
      const record = Option.getOrThrow(yield* syncs.find("github-work"));
      assert.deepStrictEqual({ failures: record.failures, lastError: record.lastError, cursor: record.cursor, nextRunAt: record.nextRunAt }, {
        failures: 1,
        lastError: "ネットワーク",
        cursor: null,
        nextRunAt: "2026-11-28T00:02:00.000Z",
      });
    }).pipe(Effect.provide(layerWith(() => Effect.fail(new SourceFetchError({ reason: "ネットワーク" }))))));

  it("延ばす間隔は 30 分で頭打ちにする", () => {
    assert.deepStrictEqual([1, 2, 3, 10].map((n) => Duration.toMinutes(backoffAfter(n))), [2, 4, 8, 30]);
  });

  it.effect("トークンが通らなければ、アカウントをつなぎ直しが要るにする（次からは取り込まない）", () =>
    Effect.gen(function* () {
      yield* start;
      yield* (yield* SyncRunner).runOnce();
      const account = Option.getOrThrow(yield* accounts.find("github-work"));
      assert.deepStrictEqual({ status: account.status, problem: account.problem }, { status: "つなぎ直しが要る", problem: "トークンが切れた" });
    }).pipe(Effect.provide(layerWith(() => Effect.fail(new SourceFetchError({ reason: "トークンが通らない" }))))));
});
