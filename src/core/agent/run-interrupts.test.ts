import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import * as AgentRunSpec from "../../../specs/agent-run.spec.js";
import { Deferred, Effect, Fiber, Option } from "effect";
import { Database } from "../db/database.js";
import { agentRuns } from "../db/schema.js";
import { TestDatabase } from "../db/test-database.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import type { ItemState } from "../source/source-item.js";
import { TaskRepository } from "../task/task-repository.js";
import type { TaskStatus } from "../task/task.js";
import { ClaudeCodeError, StopNotice } from "./claude-code.js";
import { RunInterrupts, statusAfterRun } from "./run-interrupts.js";

const run = <A, E>(effect: Effect.Effect<A, E, RunInterrupts | TaskRepository | SourceItemRepository | Database>) =>
  effect.pipe(Effect.provide(RunInterrupts.layer), Effect.provide(TestDatabase));

const trackedTask = (status: TaskStatus, itemState: ItemState = "open") =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const item = yield* items.upsertItem({ source: "github:work", externalId: "pr-1", title: "PR", url: "https://github.com/acme/app/pull/1", state: itemState, fingerprint: "v1" });
    const task = yield* tasks.createTask({ title: "PR", status });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    return task;
  });

const insertRun = (taskId: number, status: "queued" | "running", kind = "next_actions", previousStatus: TaskStatus = "todo") =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db.insert(agentRuns).values({ taskId, kind, status, subjectFingerprint: "", previousStatus, startedAt: "2026-11-26T00:00:00.000Z" });
  });

describe("RunInterrupts.trackedClosed", () => {
  it.effect("処理中の Task の追う項目が merge されたら、動いている処理に知らせる", () =>
    run(
      Effect.gen(function* () {
        const task = yield* trackedTask("agent_running");
        yield* insertRun(task.id, "running", "fix_pull_request");
        const interrupts = yield* RunInterrupts;
        const listening = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          interrupts.listen(
            task.id,
            Effect.gen(function* () {
              const notice = yield* StopNotice;
              yield* Deferred.succeed(listening, undefined);
              return yield* notice.wait;
            }),
          ),
        );
        yield* Deferred.await(listening);

        const handled = yield* interrupts.trackedClosed(task.id, ["resolved"]);

        assert.isTrue(handled);
        assert.include(yield* Fiber.join(fiber), "merge");
      }),
    ));

  it.effect("追う項目にまだ開いているものがあれば、知らせない", () =>
    run(
      Effect.gen(function* () {
        const task = yield* trackedTask("agent_running");
        yield* insertRun(task.id, "queued");

        const handled = yield* (yield* RunInterrupts).trackedClosed(task.id, ["resolved", "open"]);

        assert.isFalse(handled);
        assert.lengthOf(yield* (yield* Database).select().from(agentRuns), 1);
      }),
    ));

  it.effect("待ち行列にあるだけの処理は取り消し、Task を完了にする（まだ何も作業していないので判断させない）", () =>
    run(
      Effect.gen(function* () {
        const task = yield* trackedTask("agent_running", "resolved");
        yield* insertRun(task.id, "queued", "next_actions", "in_progress");

        const handled = yield* (yield* RunInterrupts).trackedClosed(task.id, ["resolved"]);

        const tasks = yield* TaskRepository;
        assert.isTrue(handled);
        assert.lengthOf(yield* (yield* Database).select().from(agentRuns), 0);
        assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(task.id)).status, "done");
        assert.deepInclude((yield* tasks.listChanges(task.id)).at(-1), { field: "status", before: "agent_running", after: "done", actor: "agent", seenAt: null });
      }),
    ));

  it.effect("追う項目が消えただけなら、取り消したあとアーカイブにする", () =>
    run(
      Effect.gen(function* () {
        const task = yield* trackedTask("agent_running", "removed");
        yield* insertRun(task.id, "queued");

        yield* (yield* RunInterrupts).trackedClosed(task.id, ["removed"]);

        assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(task.id)).status, "archived");
      }),
    ));

  describe(specOf(AgentRunSpec.notifyClosed, "merge の処理には知らせない"), () => {
    it.effect("merge のように知らせを聞かない処理が動いていれば、待ち行列だけ取り消し、status は変えない", () =>
      run(
        Effect.gen(function* () {
          const task = yield* trackedTask("agent_running", "resolved");
          yield* insertRun(task.id, "running", "merge_pull_request");
          yield* insertRun(task.id, "queued");

          const handled = yield* (yield* RunInterrupts).trackedClosed(task.id, ["resolved"]);

          const remaining = yield* (yield* Database).select().from(agentRuns);
          assert.isTrue(handled);
          assert.deepStrictEqual(remaining.map((row) => row.kind), ["merge_pull_request"]);
          assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(task.id)).status, "agent_running");
        }),
      ));
  });

  describe(specOf(AgentRunSpec.notifyClosed, "待ちか実行中のときだけ"), () => {
    it.effect("聞き終わった処理には知らせない", () =>
      run(
        Effect.gen(function* () {
          const task = yield* trackedTask("agent_running", "resolved");
          yield* insertRun(task.id, "running", "merge_pull_request");
          const interrupts = yield* RunInterrupts;
          yield* interrupts.listen(task.id, Effect.void);

          const handled = yield* interrupts.trackedClosed(task.id, ["resolved"]);

          assert.isFalse(handled);
        }),
      ));
  });
});

describe("statusAfterRun", () => {
  it.effect("作業をやめた処理のあとは、追う項目の今の状態から status を導き直す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* trackedTask("agent_running", "resolved");

        const status = yield* statusAfterRun(task.id, "todo", new ClaudeCodeError({ message: "やめた", stoppedReason: "merge された" }));

        assert.strictEqual(status, "done");
      }),
    ));

  it.effect("ふつうに失敗・成功した処理のあとは、処理前の status に戻す", () =>
    run(
      Effect.gen(function* () {
        const task = yield* trackedTask("agent_running", "resolved");

        assert.strictEqual(yield* statusAfterRun(task.id, "todo", new ClaudeCodeError({ message: "落ちた" })), "todo");
        assert.strictEqual(yield* statusAfterRun(task.id, "in_progress", undefined), "in_progress");
      }),
    ));
});
