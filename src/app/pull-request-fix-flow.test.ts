import { assert, describe, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { ClaudeCode, type ClaudeRequest } from "../core/agent/claude-code.js";
import { ConflictWorkspace } from "../core/agent/conflict-workspace.js";
import { Database } from "../core/db/database.js";
import { agentRuns, approvals } from "../core/db/schema.js";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { currentSteps, decodePlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { finishPullRequestFix, pushPullRequestFix, startPullRequestFix } from "./pull-request-fix-flow.js";

const FIX = { summary: "CLI を 3.x にした", verification: "pnpm changeset version が通った", concerns: "" };

const fixTask = Effect.gen(function* () {
  const db = yield* Database;
  const url = "https://github.com/acme/app/pull/179";
  const item = yield* (yield* SourceItemRepository).upsertItem({ source: "github:personal", externalId: url, title: "Update changesets/action", url, state: "open", fingerprint: "v1", author: "renovate[bot]" });
  const tasks = yield* TaskRepository;
  const task = yield* tasks.createTask({ title: item.title, status: "todo" });
  yield* tasks.linkItem(task.id, item.id, "tracks");
  yield* tasks.updateTask(task.id, {
    nextActions: {
      steps: [
        { id: "s2", kind: "fix_and_push", title: "CLI v3 への更新をまとめて push する", effort: "tedious", mode: "serial", status: "todo" },
        { id: "s3", kind: "merge_pull_request", title: "merge する", effort: "easy", mode: "serial", status: "todo" },
      ],
    },
  });
  yield* db.insert(agentRuns).values({
    taskId: task.id,
    kind: "dependency_review",
    status: "succeeded",
    subjectFingerprint: "v1",
    subjectSha: "a".repeat(40),
    previousStatus: "todo",
    result: { conclusion: "mergeable_after_fix", requiredChanges: "package.json の @changesets/cli を 3.x にする" },
    startedAt: "2026-11-26T00:00:00.000Z",
  });
  return task.id;
});

const doubles = () => {
  const requests: ClaudeRequest[] = [];
  const prepared: Array<{ purpose: string }> = [];
  const commits: Array<{ anyChanges: boolean | undefined; message: string | undefined; headSha: string | undefined }> = [];
  const pushes: string[] = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        ClaudeCode,
        ClaudeCode.of({
          run: (request) =>
            Effect.sync(() => {
              requests.push(request);
              return { sessionId: "fix", structured: FIX, costUsd: 0.5, permissionDenials: 0 };
            }),
        }),
      ),
      Effect.provideService(
        ConflictWorkspace,
        ConflictWorkspace.of({
          prepare: (taskId, _pullUrl, options) =>
            Effect.sync(() => {
              prepared.push({ purpose: options?.purpose ?? "conflict" });
              return {
                cwd: `/w/task-${taskId}/fix`,
                repository: "acme/app",
                headRef: "renovate/changesets-action-2.x",
                baseRef: "main",
                headSha: "a".repeat(40),
                conflicted: [],
                isolationDir: `/w/task-${taskId}/no-credentials`,
                cacheDir: `/w/task-${taskId}/package-cache`,
              };
            }),
          commit: (_cwd, _conflicted, options) =>
            Effect.sync(() => {
              commits.push({ anyChanges: options?.anyChanges, message: options?.message, headSha: options?.headSha });
              return { commitSha: "b".repeat(40), diff: "diff --git a/package.json b/package.json" };
            }),
          push: (_cwd, _repository, headRef, _expected, commitSha) =>
            Effect.sync(() => {
              pushes.push(`${headRef} ${commitSha}`);
            }),
        }),
      ),
    );
  return { requests, prepared, commits, pushes, provide };
};

const kindsOf = (taskId: number) =>
  Effect.gen(function* () {
    return currentSteps(Option.getOrThrow(decodePlan(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).nextActions))).map((step) => step.kind);
  });

describe("Claude Code に PR を修正させる", () => {
  it.effect("PR のブランチを取り出し（merge しない）、調査の必要な修正を渡して、コマンドも使える・認証はない環境で直させ、全部の変更を手元で commit する", () =>
    Effect.gen(function* () {
      const taskId = yield* fixTask;
      const h = doubles();

      yield* h.provide(finishPullRequestFix(yield* startPullRequestFix(taskId), { denyRead: ["/app/data"] }));

      assert.deepStrictEqual(h.prepared, [{ purpose: "fix" }]);
      const request = h.requests[0]!;
      assert.include(request.prompt, "package.json の @changesets/cli を 3.x にする");
      assert.include([...request.allowedTools], "Bash");
      assert.include([...(request.disallowedTools ?? [])], "Bash(git push:*)");
      assert.deepStrictEqual(request.withoutCredentials, { ghConfigDir: `/w/task-${taskId}/no-credentials` });
      assert.deepStrictEqual(request.sandbox?.allowWrite, [`/w/task-${taskId}/package-cache`]);
      assert.includeMembers([...(request.sandbox?.denyRead ?? [])], ["/app/data"]);
      assert.deepStrictEqual(request.sandbox?.allowRead, [`/w/task-${taskId}/fix`, `/w/task-${taskId}/package-cache`]);
      assert.deepInclude(request.env as object, { npm_config_userconfig: "/dev/null", npm_config_globalconfig: "/dev/null" });
      assert.include([...(request.sandbox?.allowedDomains ?? [])], "registry.npmjs.org");
      assert.deepInclude(request.env as object, { npm_config_cache: `/w/task-${taskId}/package-cache/npm`, npm_config_store_dir: `/w/task-${taskId}/package-cache/pnpm` });
      assert.deepStrictEqual(h.commits, [{ anyChanges: true, message: "CLI v3 への更新をまとめて push する", headSha: "a".repeat(40) }]);
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "todo");
      const [run] = yield* (yield* Database).select().from(agentRuns).where(eq(agentRuns.kind, "fix_pull_request"));
      assert.deepInclude(run?.result as object, { summary: "CLI を 3.x にした", diff: "diff --git a/package.json b/package.json" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("承認したら、確認した commit を PR のブランチに push し、修正の手順を済ませる", () =>
    Effect.gen(function* () {
      const taskId = yield* fixTask;
      const h = doubles();
      yield* h.provide(finishPullRequestFix(yield* startPullRequestFix(taskId), {}));

      yield* h.provide(pushPullRequestFix(taskId, "b".repeat(40), (accountId) => Effect.succeed(`token-of-${accountId}`)));

      assert.deepStrictEqual(h.pushes, [`renovate/changesets-action-2.x ${"b".repeat(40)}`]);
      assert.deepStrictEqual(yield* kindsOf(taskId), ["merge_pull_request"]);
      const [approval] = yield* (yield* Database).select().from(approvals).where(eq(approvals.taskId, taskId));
      assert.deepInclude(approval, { action: "push_fix", status: "executed" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("確認画面で見せた commit が最新の修正と違えば push しない", () =>
    Effect.gen(function* () {
      const taskId = yield* fixTask;
      const h = doubles();
      yield* h.provide(finishPullRequestFix(yield* startPullRequestFix(taskId), {}));

      const error = yield* h.provide(pushPullRequestFix(taskId, "c".repeat(40), () => Effect.succeed("t"))).pipe(Effect.flip);

      assert.include(error.message, "もう一度確かめて");
      assert.lengthOf(h.pushes, 0);
    }).pipe(Effect.provide(TestDatabase)));
});
