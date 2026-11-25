import { assert, describe, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { Database } from "../core/db/database.js";
import { agentRuns, approvals } from "../core/db/schema.js";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { GitHubRequestError, type GitHubClient } from "../sources/github/github-adapter.js";
import { gitHubClientStub } from "../sources/github/test-client.js";
import { approveAndMerge, mergePlan } from "./merge-approval.js";

const reviewedTask = (options: { conclusion?: string; subjectSha?: string | null } = {}) =>
  Effect.gen(function* () {
    const url = "https://github.com/acme/app/pull/42";
    const item = yield* (yield* SourceItemRepository).upsertItem({
      source: "github:personal",
      externalId: url,
      title: "Update dependency effect（acme/app）",
      url,
      state: "open",
      fingerprint: "v1",
      author: "renovate[bot]",
    });
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: item.title, status: "todo" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    yield* (yield* Database).insert(agentRuns).values({
      taskId: task.id,
      kind: "dependency_review",
      status: "succeeded",
      subjectFingerprint: "v1",
      subjectSha: options.subjectSha === undefined ? "head-sha" : options.subjectSha,
      previousStatus: "todo",
      result: { conclusion: options.conclusion ?? "mergeable", impact: "", requiredChanges: "", blockers: "", configChanges: "" },
      startedAt: "2026-11-25T00:00:00.000Z",
    });
    return task.id;
  });

const clientFor = (client: GitHubClient["Service"]) => (accountId: string) =>
  accountId === "personal" ? Effect.succeed(client) : Effect.die(new Error(`unexpected account ${accountId}`));

const squashRepo = gitHubClientStub({
  getRepository: () => Effect.succeed({ allowSquashMerge: true, allowMergeCommit: true, allowRebaseMerge: false }),
  listRecentCommits: () => Effect.succeed([{ title: "chore: a (#1)", parents: 1 }, { title: "chore: b (#2)", parents: 1 }]),
});

describe("mergePlan", () => {
  it.effect("merge 可能と判定された PR について、merge する先・方法と理由・調べたときの commit を返す", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask();

      const plan = yield* mergePlan(taskId, clientFor(squashRepo));

      assert.deepInclude(plan, { repository: "acme/app", number: 42, sha: "head-sha", method: "squash" });
      assert.include(plan.reason, "2 件中 2 件");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("merge 可能と判定されていなければ、merge させない", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask({ conclusion: "mergeable_after_fix" });

      const error = yield* Effect.flip(mergePlan(taskId, clientFor(squashRepo)));

      assert.strictEqual(error._tag, "MergeNotAllowedError");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("調べたときの commit が分からなければ、merge させない（調べていない変更を merge しないため）", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask({ subjectSha: null });

      const error = yield* Effect.flip(mergePlan(taskId, clientFor(squashRepo)));

      assert.strictEqual(error._tag, "MergeNotAllowedError");
    }).pipe(Effect.provide(TestDatabase)));
});

describe("approveAndMerge", () => {
  it.effect("承認された方法と commit で merge し、承認を記録して Task を完了にする", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask();
      const merged: unknown[] = [];
      const client = gitHubClientStub({
        mergePullRequest: (params) => {
          merged.push(params);
          return Effect.succeed({ sha: "merged-sha" });
        },
      });

      yield* approveAndMerge(taskId, { method: "squash", sha: "head-sha" }, clientFor(client));

      assert.deepStrictEqual(merged, [{ repository: "acme/app", number: 42, sha: "head-sha", method: "squash" }]);
      const [approval] = yield* (yield* Database).select().from(approvals).where(eq(approvals.taskId, taskId));
      assert.deepInclude(approval, { action: "merge_pull_request", target: "acme/app#42", status: "executed" });
      const tasks = yield* TaskRepository;
      assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(taskId)).status, "done");
      const changes = yield* tasks.listChanges(taskId);
      assert.deepInclude(changes.at(-1), { field: "status", after: "done", actor: "user" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("確認したときと commit が違えば（そのあと調べ直した）、merge せずにエラーにする", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask({ subjectSha: "newer-sha" });
      const merged: unknown[] = [];
      const client = gitHubClientStub({
        mergePullRequest: (params) => {
          merged.push(params);
          return Effect.succeed({ sha: "x" });
        },
      });

      const error = yield* Effect.flip(approveAndMerge(taskId, { method: "squash", sha: "head-sha" }, clientFor(client)));

      assert.strictEqual(error._tag, "MergeNotAllowedError");
      assert.lengthOf(merged, 0);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("GitHub に断られたら、承認を失敗として理由つきで残し、Task は動かさない", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask();
      const client = gitHubClientStub({
        mergePullRequest: () => Effect.fail(new GitHubRequestError({ message: "Head branch was modified", status: 409 })),
      });

      const error = yield* Effect.flip(approveAndMerge(taskId, { method: "squash", sha: "head-sha" }, clientFor(client)));

      assert.include(error.message, "Head branch was modified");
      const [approval] = yield* (yield* Database).select().from(approvals).where(eq(approvals.taskId, taskId));
      assert.deepInclude(approval, { status: "failed", error: "Head branch was modified" });
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "todo");
    }).pipe(Effect.provide(TestDatabase)));
});
