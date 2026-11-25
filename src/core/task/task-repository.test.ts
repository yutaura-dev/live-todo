import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import type { NewTask } from "./task.js";
import { TaskRepository } from "./task-repository.js";
import { TaskRepositoryTest } from "./test-database.js";

const newTask = (overrides: Partial<NewTask> = {}): NewTask => ({
  source: "github",
  externalId: "https://api.github.com/repos/acme/app/pulls/42",
  title: "Add retry to sync",
  url: "https://github.com/acme/app/pull/42",
  status: "todo",
  fingerprint: "v1",
  ...overrides,
});

describe("TaskRepository", () => {
  it.effect("追加した Task を source と externalId で取得できる", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      const repo = yield* TaskRepository;

      const inserted = yield* repo.insert(newTask());
      const found = yield* repo.findBySource("github", "https://api.github.com/repos/acme/app/pulls/42");

      assert.deepStrictEqual(found, Option.some(inserted));
      assert.strictEqual(inserted.createdAt, "2026-11-25T00:00:00.000Z");
    }).pipe(Effect.provide(TaskRepositoryTest)));

  it.effect("存在しない Task を探すと none を返す", () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepository;

      const found = yield* repo.findBySource("github", "missing");

      assert.isTrue(Option.isNone(found));
    }).pipe(Effect.provide(TaskRepositoryTest)));

  it.effect("更新すると指定した項目と updatedAt だけが変わる", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      const repo = yield* TaskRepository;
      const inserted = yield* repo.insert(newTask());

      yield* TestClock.setTime(Date.parse("2026-11-25T01:00:00Z"));
      const updated = yield* repo.update(inserted.id, { status: "done", fingerprint: "v2" });

      assert.deepStrictEqual(updated, {
        ...inserted,
        status: "done",
        fingerprint: "v2",
        updatedAt: "2026-11-25T01:00:00.000Z",
      });
    }).pipe(Effect.provide(TaskRepositoryTest)));

  it.effect("未読として記録した変更の数を Task ごとに数える", () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepository;
      const a = yield* repo.insert(newTask({ externalId: "a" }));
      const b = yield* repo.insert(newTask({ externalId: "b" }));

      yield* repo.recordChange(a.id, { kind: "created", unread: false });
      yield* repo.recordChange(a.id, { kind: "content_updated", unread: true });
      yield* repo.recordChange(a.id, { kind: "status_changed", detail: { from: "todo", to: "done" }, unread: true });

      const tasks = yield* repo.listTasks;

      assert.deepStrictEqual(
        tasks.map((task) => [task.externalId, task.unreadChanges]),
        [[a.externalId, 2], [b.externalId, 0]],
      );
    }).pipe(Effect.provide(TaskRepositoryTest)));

  it.effect("既読にすると、その Task の未読の変更がなくなる", () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepository;
      const task = yield* repo.insert(newTask());
      yield* repo.recordChange(task.id, { kind: "content_updated", unread: true });

      yield* repo.markChangesSeen(task.id);
      const tasks = yield* repo.listTasks;

      assert.strictEqual(tasks[0]?.unreadChanges, 0);
    }).pipe(Effect.provide(TaskRepositoryTest)));

  it.effect("保存していない source のカーソルは none を返す", () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepository;

      const cursor = yield* repo.loadCursor("github");

      assert.isTrue(Option.isNone(cursor));
    }).pipe(Effect.provide(TaskRepositoryTest)));

  it.effect("保存したカーソルを読み出せ、保存し直すと上書きされる", () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepository;

      yield* repo.saveCursor("github", { since: "2026-11-24T00:00:00Z" });
      yield* repo.saveCursor("github", { since: "2026-11-25T00:00:00Z" });
      const cursor = yield* repo.loadCursor("github");

      assert.deepStrictEqual(cursor, Option.some({ since: "2026-11-25T00:00:00Z" }));
    }).pipe(Effect.provide(TaskRepositoryTest)));

  it.effect("トランザクションの中で失敗すると、それまでの書き込みを巻き戻す", () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepository;

      yield* repo
        .withTransaction(
          Effect.gen(function* () {
            yield* repo.insert(newTask());
            yield* repo.saveCursor("github", { since: "2026-11-25T00:00:00Z" });
            return yield* Effect.fail("boom");
          }),
        )
        .pipe(Effect.flip);

      assert.deepStrictEqual(yield* repo.listTasks, []);
      assert.isTrue(Option.isNone(yield* repo.loadCursor("github")));
    }).pipe(Effect.provide(TaskRepositoryTest)));
});
