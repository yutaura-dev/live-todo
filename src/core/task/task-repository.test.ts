import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../db/test-database.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { TaskRepository } from "./task-repository.js";

const itemWith = (externalId: string, state: "open" | "resolved" | "removed" = "open") =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    return yield* items.upsertItem({ source: "github", externalId, title: externalId, url: "u", state, fingerprint: "v1" });
  });

describe("TaskRepository", () => {
  it.effect("Item に紐づけた Task を、その Item から取得できる", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const item = yield* itemWith("pr-42");

      const task = yield* tasks.createTask({ title: "PR をレビューする", status: "todo" });
      yield* tasks.linkItem(task.id, item.id, "tracks");

      assert.deepStrictEqual(yield* tasks.findTaskByItem(item.id), Option.some(task));
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("どの Task にも紐づいていない Item からは none を返す", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const item = yield* itemWith("pr-42");

      assert.isTrue(Option.isNone(yield* tasks.findTaskByItem(item.id)));
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("1 つの Item を 2 つの Task に紐づけることはできない", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const item = yield* itemWith("pr-42");
      const a = yield* tasks.createTask({ title: "a", status: "todo" });
      const b = yield* tasks.createTask({ title: "b", status: "todo" });
      yield* tasks.linkItem(a.id, item.id, "tracks");

      const exit = yield* Effect.exit(tasks.linkItem(b.id, item.id, "context"));

      assert.isTrue(exit._tag === "Failure");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("tracks で紐づけた Item の状態だけを返し、context の Item は含めない", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const pr = yield* itemWith("pr-42", "resolved");
      const thread = yield* itemWith("slack-thread", "open");
      const task = yield* tasks.createTask({ title: "PR をレビューする", status: "todo" });
      yield* tasks.linkItem(task.id, pr.id, "tracks");
      yield* tasks.linkItem(task.id, thread.id, "context");

      assert.deepStrictEqual(yield* tasks.trackedItemStates(task.id), ["resolved"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("更新すると指定した項目と updatedAt だけが変わる", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      const tasks = yield* TaskRepository;
      const task = yield* tasks.createTask({ title: "PR をレビューする", status: "todo" });

      yield* TestClock.setTime(Date.parse("2026-11-25T01:00:00Z"));
      const updated = yield* tasks.updateTask(task.id, { status: "done" });

      assert.deepStrictEqual(updated, { ...task, status: "done", updatedAt: "2026-11-25T01:00:00.000Z" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("未読として記録した変更の数を Task ごとに数える", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const a = yield* tasks.createTask({ title: "a", status: "todo" });
      const b = yield* tasks.createTask({ title: "b", status: "todo" });

      yield* tasks.recordChange(a.id, { kind: "created", unread: false });
      yield* tasks.recordChange(a.id, { kind: "field_changed", field: "status", before: "todo", after: "done", unread: true });

      assert.deepStrictEqual(
        (yield* tasks.listTasks).map((task) => [task.title, task.unreadChanges]),
        [["a", 1], ["b", 0]],
      );
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("項目の変更は、どの項目が何から何に変わったかを記録する", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const task = yield* tasks.createTask({ title: "a", status: "todo" });

      yield* tasks.recordChange(task.id, { kind: "field_changed", field: "status", before: "todo", after: "done", unread: true });

      const [change] = yield* tasks.listChanges(task.id);
      assert.deepInclude(change, { kind: "field_changed", field: "status", before: "todo", after: "done" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("変更を記録するときに誰が変えたか（同期かユーザーか）を残し、指定しなければ同期とする", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const task = yield* tasks.createTask({ title: "a", status: "todo" });

      yield* tasks.recordChange(task.id, { kind: "field_changed", field: "status", before: "todo", after: "done", unread: true });
      yield* tasks.recordChange(task.id, { kind: "field_changed", field: "status", before: "done", after: "dismissed", unread: false, actor: "user" });

      assert.deepStrictEqual((yield* tasks.listChanges(task.id)).map((change) => change.actor), ["sync", "user"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("既読にすると、その Task の未読の変更がなくなる", () =>
    Effect.gen(function* () {
      const tasks = yield* TaskRepository;
      const task = yield* tasks.createTask({ title: "a", status: "todo" });
      yield* tasks.recordChange(task.id, { kind: "field_changed", field: "status", before: "todo", after: "done", unread: true });

      yield* tasks.markChangesSeen(task.id);

      assert.strictEqual((yield* tasks.listTasks)[0]?.unreadChanges, 0);
    }).pipe(Effect.provide(TestDatabase)));
});
