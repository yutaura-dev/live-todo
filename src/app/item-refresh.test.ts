import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { TaskStatus } from "../core/task/task.js";
import { GitHubRequestError } from "../sources/github/github-adapter.js";
import { gitHubClientStub } from "../sources/github/test-client.js";
import { refreshTrackedItems } from "./item-refresh.js";

let pullNumber = 0;
const trackedPull = (options: { status?: TaskStatus; source?: string; externalId?: string } = {}) =>
  Effect.gen(function* () {
    const items = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const number = 700 + pullNumber++;
    const externalId = options.externalId ?? `https://api.github.com/repos/acme/app/pulls/${number}`;
    const item = yield* items.upsertItem({
      source: options.source ?? "github:personal",
      externalId,
      title: "MCP からスケジュールを変更できるようにする",
      url: `https://github.com/acme/app/pull/${number}`,
      state: "open",
      fingerprint: "v1",
    });
    const task = yield* tasks.createTask({ title: item.title, status: options.status ?? "todo" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    yield* items.setTriage(item.id, "linked");
    return { taskId: task.id, externalId };
  });

const statusOf = (taskId: number) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status;
  });

const subjects = (byUrl: Record<string, unknown>) =>
  gitHubClientStub({ getSubject: (url) => Effect.succeed(url in byUrl ? Option.some(byUrl[url]) : Option.none()) });

describe("refreshTrackedItems", () => {
  it.effect("通知が来ないまま merge された PR（自分で merge したなど）を読み直して解消にし、Task を完了にする", () =>
    Effect.gen(function* () {
      const { taskId, externalId } = yield* trackedPull();

      const refreshed = yield* refreshTrackedItems("personal", subjects({ [externalId]: { state: "closed", merged: true } }));

      assert.strictEqual(refreshed, 1);
      assert.strictEqual(yield* statusOf(taskId), "done");
      const last = (yield* (yield* TaskRepository).listChanges(taskId)).at(-1);
      assert.deepInclude(last, { field: "status", before: "todo", after: "done" });
      assert.isNull(last?.seenAt);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("まだ開いている PR は、何も変えない", () =>
    Effect.gen(function* () {
      const { taskId, externalId } = yield* trackedPull();
      const before = (yield* (yield* TaskRepository).listChanges(taskId)).length;

      assert.strictEqual(yield* refreshTrackedItems("personal", subjects({ [externalId]: { state: "open", merged: false } })), 0);

      assert.strictEqual(yield* statusOf(taskId), "todo");
      assert.lengthOf(yield* (yield* TaskRepository).listChanges(taskId), before);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("終わった Task・ほかのアカウント・状態を取れない通知（CI など）の項目は読み直さない", () =>
    Effect.gen(function* () {
      yield* trackedPull({ status: "done" });
      yield* trackedPull({ source: "github:work" });
      yield* trackedPull({ externalId: "github:thread:1" });
      const asked: string[] = [];
      const client = gitHubClientStub({
        getSubject: (url) => {
          asked.push(url);
          return Effect.succeed(Option.none());
        },
      });

      assert.strictEqual(yield* refreshTrackedItems("personal", client), 0);
      assert.deepStrictEqual(asked, []);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("1 件を読み直せなくても、ほかの項目は読み直す", () =>
    Effect.gen(function* () {
      const broken = yield* trackedPull();
      const merged = yield* trackedPull();
      const client = gitHubClientStub({
        getSubject: (url) =>
          url === broken.externalId
            ? Effect.fail(new GitHubRequestError({ message: "500", status: 500 }))
            : Effect.succeed(Option.some<unknown>({ state: "closed", merged: true })),
      });

      assert.strictEqual(yield* refreshTrackedItems("personal", client), 1);
      assert.strictEqual(yield* statusOf(broken.taskId), "todo");
      assert.strictEqual(yield* statusOf(merged.taskId), "done");
    }).pipe(Effect.provide(TestDatabase)));
});
