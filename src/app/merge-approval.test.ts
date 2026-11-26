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
import { approveAndMerge, finishMerge, mergePlan, startMerge } from "./merge-approval.js";

const reviewedTask = (options: { conclusion?: string; subjectSha?: string | null; canMergeAsIs?: boolean } = {}) =>
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
      result: {
        conclusion: options.conclusion ?? "mergeable",
        impact: "",
        requiredChanges: "",
        blockers: "",
        configChanges: "",
        canMergeAsIs: options.canMergeAsIs ?? false,
        mergeAsIsNote: "",
      },
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

  it.effect("修正すれば merge 可能でも、そのまま merge してよいとされていれば merge できる", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask({ conclusion: "mergeable_after_fix", canMergeAsIs: true });

      const plan = yield* mergePlan(taskId, clientFor(squashRepo));

      assert.strictEqual(plan.number, 42);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("最後の調べ直しが失敗していても、それより前に成功した調査の結論で merge できる", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask();
      yield* (yield* Database).insert(agentRuns).values({
        taskId,
        kind: "dependency_review",
        status: "failed",
        error: "作業場所を取得できない",
        subjectFingerprint: "v1",
        previousStatus: "todo",
        startedAt: "2026-11-25T01:00:00.000Z",
      });

      const plan = yield* mergePlan(taskId, clientFor(squashRepo));

      assert.strictEqual(plan.sha, "head-sha");
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

describe("startMerge / finishMerge（裏で merge する）", () => {
  it.effect("merge を始めると、Task を処理中のレーンに移して merge 中の記録を作り、終わったら完了にする", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask();
      const tasks = yield* TaskRepository;

      const runId = yield* startMerge(taskId, { method: "squash", sha: "head-sha" }, clientFor(gitHubClientStub()));

      assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(taskId)).status, "agent_running");
      const [running] = yield* (yield* Database).select().from(agentRuns).where(eq(agentRuns.id, runId));
      assert.deepInclude(running, { kind: "merge_pull_request", status: "running", previousStatus: "todo" });

      yield* finishMerge(runId, { method: "squash", sha: "head-sha" }, clientFor(gitHubClientStub()));

      assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(taskId)).status, "done");
      const [finished] = yield* (yield* Database).select().from(agentRuns).where(eq(agentRuns.id, runId));
      assert.strictEqual(finished?.status, "succeeded");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("確認した内容が今の調査と違えば、始める前にエラーにする（レーンは動かさない）", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask({ subjectSha: "newer-sha" });

      const error = yield* Effect.flip(startMerge(taskId, { method: "squash", sha: "head-sha" }, clientFor(gitHubClientStub())));

      assert.strictEqual(error._tag, "MergeNotAllowedError");
      assert.strictEqual(Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId)).status, "todo");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("merge に失敗したら、元のレーンに戻して理由を残し、更新マークで知らせる", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask();
      const runId = yield* startMerge(taskId, { method: "squash", sha: "head-sha" }, clientFor(gitHubClientStub()));
      const client = gitHubClientStub({
        mergePullRequest: () => Effect.fail(new GitHubRequestError({ message: "Head branch was modified", status: 409 })),
      });

      yield* finishMerge(runId, { method: "squash", sha: "head-sha" }, clientFor(client));

      const tasks = yield* TaskRepository;
      assert.strictEqual(Option.getOrThrow(yield* tasks.findTask(taskId)).status, "todo");
      const [failed] = yield* (yield* Database).select().from(agentRuns).where(eq(agentRuns.id, runId));
      assert.deepInclude(failed, { status: "failed", error: "Head branch was modified" });
      const changes = yield* tasks.listChanges(taskId);
      assert.isTrue(changes.some((change) => change.field === "merge" && change.seenAt === null));
    }).pipe(Effect.provide(TestDatabase)));
});

describe("approveAndMerge（権限が足りないとき）", () => {
  it.effect("workflow の権限がなくて断られたら、何をすれば merge できるかを日本語で伝える", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask();
      const client = gitHubClientStub({
        mergePullRequest: () =>
          Effect.fail(
            new GitHubRequestError({
              message: "GitHub API が 403 を返した: PUT /repos/acme/app/pulls/42/merge: refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope",
              status: 403,
            }),
          ),
      });

      const error = yield* Effect.flip(approveAndMerge(taskId, { method: "squash", sha: "head-sha" }, clientFor(client)));

      assert.include(error.message, "workflow の権限");
      assert.include(error.message, "gh auth refresh -s workflow");
    }).pipe(Effect.provide(TestDatabase)));
});

describe("approveAndMerge（GitHub 側のエラー）", () => {
  it.effect("GitHub 側のエラー（500 番台）で断られたら、GitHub の画面から merge するよう伝える", () =>
    Effect.gen(function* () {
      const taskId = yield* reviewedTask();
      const client = gitHubClientStub({
        mergePullRequest: () =>
          Effect.fail(new GitHubRequestError({ message: "GitHub API が 500 を返した: PUT /repos/acme/app/pulls/42/merge", status: 500 })),
      });

      const error = yield* Effect.flip(approveAndMerge(taskId, { method: "squash", sha: "head-sha" }, clientFor(client)));

      assert.include(error.message, "GitHub の画面");
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

const ownPullTask = (options: { author?: string; nextActions?: unknown } = {}) =>
  Effect.gen(function* () {
    const url = "https://github.com/acme/app/pull/733";
    const item = yield* (yield* SourceItemRepository).upsertItem({
      source: "github:personal",
      externalId: "https://api.github.com/repos/acme/app/pulls/733",
      title: "カレンダーで一覧できるようにする（acme/app）",
      url,
      state: "open",
      fingerprint: "v1",
      author: options.author ?? "me",
    });
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: item.title, status: "todo" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    if (options.nextActions !== undefined) yield* tasks.updateTask(task.id, { nextActions: options.nextActions as never });
    return task.id;
  });

const livePull = (options: { mergeableState?: string; checks?: Array<{ status: string; conclusion: string | null }> } = {}) =>
  gitHubClientStub({
    getRepository: () => Effect.succeed({ allowSquashMerge: true, allowMergeCommit: false, allowRebaseMerge: false }),
    getPullRequest: (apiUrl) =>
      Effect.succeed(
        apiUrl === "https://api.github.com/repos/acme/app/pulls/733"
          ? Option.some<unknown>({ state: "open", draft: false, mergeable_state: options.mergeableState ?? "clean", head: { sha: "live-sha" } })
          : Option.none(),
      ),
    listCheckRuns: (_repository, sha) =>
      Effect.succeed<unknown>({
        check_runs: sha === "live-sha" ? (options.checks ?? [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }]).map((check, index) => ({ name: `c${index}`, ...check })) : [],
      }),
  });

describe("自分の PR（依存更新の調査がない PR）の merge", () => {
  it.effect("CI がすべて通り、コンフリクトもなければ、今の head の commit で merge の確認を出す", () =>
    Effect.gen(function* () {
      const taskId = yield* ownPullTask();

      const plan = yield* mergePlan(taskId, clientFor(livePull()));

      assert.deepInclude(plan, { repository: "acme/app", number: 733, sha: "live-sha", method: "squash" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("CI が終わっていない・落ちているなら、merge させない", () =>
    Effect.gen(function* () {
      const taskId = yield* ownPullTask();
      for (const checks of [[{ status: "in_progress", conclusion: null }], [{ status: "completed", conclusion: "failure" }]]) {
        const error = yield* mergePlan(taskId, clientFor(livePull({ checks }))).pipe(Effect.flip);
        assert.include(error.message, "CI");
      }
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("コンフリクトがある・必要な承認がないなど、GitHub が merge できる状態と言っていなければ、merge させない", () =>
    Effect.gen(function* () {
      const taskId = yield* ownPullTask();
      for (const mergeableState of ["dirty", "blocked", "unknown"]) {
        const error = yield* mergePlan(taskId, clientFor(livePull({ mergeableState }))).pipe(Effect.flip);
        assert.strictEqual(error._tag, "MergeNotAllowedError");
      }
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("依存更新の bot の PR は、調査なしでは merge させない", () =>
    Effect.gen(function* () {
      const taskId = yield* ownPullTask({ author: "renovate[bot]" });

      const error = yield* mergePlan(taskId, clientFor(livePull())).pipe(Effect.flip);

      assert.include(error.message, "調査");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("確認したあとに PR に commit が足されていたら、始めない", () =>
    Effect.gen(function* () {
      const taskId = yield* ownPullTask();

      const error = yield* startMerge(taskId, { method: "squash", sha: "older-sha" }, clientFor(livePull())).pipe(Effect.flip);

      assert.strictEqual(error._tag, "MergeNotAllowedError");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("merge したら merge の手順を済ませ、まだ手順が残っていれば Task は元のレーンに戻す", () =>
    Effect.gen(function* () {
      const taskId = yield* ownPullTask({
        nextActions: {
          steps: [
            { id: "m", kind: "merge_pull_request", title: "PR を merge する", effort: "easy", mode: "serial", status: "todo" },
            { id: "ask", kind: "manual", title: "stg で確認してもらう", effort: "normal", mode: "serial", status: "todo" },
          ],
        },
      });
      const tasks = yield* TaskRepository;

      const runId = yield* startMerge(taskId, { method: "squash", sha: "live-sha" }, clientFor(livePull()));
      yield* finishMerge(runId, { method: "squash", sha: "live-sha" }, clientFor(livePull()));

      const task = Option.getOrThrow(yield* tasks.findTask(taskId));
      assert.strictEqual(task.status, "todo");
      assert.deepInclude((task.nextActions as { steps: Array<{ id: string; status: string }> }).steps[0], { id: "m", status: "done" });
    }).pipe(Effect.provide(TestDatabase)));
});

