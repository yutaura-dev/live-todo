import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { TaskStatus } from "../core/task/task.js";
import { dismissTasksOutsideFilter } from "./filter-cleanup.js";

const taskTracking = (status: TaskStatus, items: Array<{ source: string; url: string }>) =>
  Effect.gen(function* () {
    const sourceItems = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: items[0]?.url ?? "manual", status });
    for (const item of items) {
      const stored = yield* sourceItems.upsertItem({ ...item, externalId: item.url, title: item.url, state: "open", fingerprint: "v1" });
      yield* tasks.linkItem(task.id, stored.id, "tracks");
    }
    return task.id;
  });

const statusOf = (taskId: number) =>
  Effect.gen(function* () {
    const found = yield* (yield* TaskRepository).findTask(taskId);
    return found._tag === "Some" ? found.value.status : undefined;
  });

const filter = { exclude: ["quipper/*"] };

describe("dismissTasksOutsideFilter", () => {
  it.effect("除外したリポジトリの項目だけを追う、終わっていない Task を片付ける", () =>
    Effect.gen(function* () {
      const review = yield* taskTracking("needs_review", [{ source: "github:personal", url: "https://github.com/quipper/monorepo/pull/1" }]);
      const todo = yield* taskTracking("todo", [{ source: "github:personal:watch", url: "https://github.com/Quipper/monorepo/pull/2" }]);
      const doing = yield* taskTracking("in_progress", [{ source: "github:personal", url: "https://github.com/quipper/app/issues/3" }]);

      const dismissed = yield* dismissTasksOutsideFilter("personal", filter);

      assert.strictEqual(dismissed, 3);
      for (const id of [review, todo, doing]) assert.strictEqual(yield* statusOf(id), "dismissed");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("片付けたことは、ユーザーの操作ではなくフィルタによる変更として、既読で記録する", () =>
    Effect.gen(function* () {
      const id = yield* taskTracking("todo", [{ source: "github:personal", url: "https://github.com/quipper/monorepo/pull/1" }]);

      yield* dismissTasksOutsideFilter("personal", filter);

      const changes = yield* (yield* TaskRepository).listChanges(id);
      const last = changes.at(-1);
      assert.deepInclude(last, { field: "status", before: "todo", after: "dismissed", actor: "filter" });
      assert.isNotNull(last?.seenAt);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("含めるリポジトリの項目も追っている Task は残す", () =>
    Effect.gen(function* () {
      const id = yield* taskTracking("todo", [
        { source: "github:personal", url: "https://github.com/quipper/monorepo/pull/1" },
        { source: "github:personal", url: "https://github.com/me/app/pull/2" },
      ]);

      assert.strictEqual(yield* dismissTasksOutsideFilter("personal", filter), 0);
      assert.strictEqual(yield* statusOf(id), "todo");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("完了した Task と、ほかのアカウントの項目の Task には触らない", () =>
    Effect.gen(function* () {
      const done = yield* taskTracking("done", [{ source: "github:personal", url: "https://github.com/quipper/monorepo/pull/1" }]);
      const otherAccount = yield* taskTracking("todo", [{ source: "github:work", url: "https://github.com/quipper/monorepo/pull/2" }]);

      assert.strictEqual(yield* dismissTasksOutsideFilter("personal", filter), 0);
      assert.strictEqual(yield* statusOf(done), "done");
      assert.strictEqual(yield* statusOf(otherAccount), "todo");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("フィルタがなければ何もしない", () =>
    Effect.gen(function* () {
      const id = yield* taskTracking("todo", [{ source: "github:personal", url: "https://github.com/quipper/monorepo/pull/1" }]);

      assert.strictEqual(yield* dismissTasksOutsideFilter("personal", {}), 0);
      assert.strictEqual(yield* statusOf(id), "todo");
    }).pipe(Effect.provide(TestDatabase)));
});
