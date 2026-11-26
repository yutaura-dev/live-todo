import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import type { NextActionPlan } from "../core/task/next-actions.js";
import { currentSteps, decodePlan } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { TaskStatus } from "../core/task/task.js";
import { gitHubClientStub } from "../sources/github/test-client.js";
import { checkWaitConditions } from "./wait-watch.js";

let itemNumber = 0;
let lastItemId = 0;
const waitingFor = (until: unknown, options: { source?: string; status?: TaskStatus } = {}) =>
  Effect.gen(function* () {
    const sourceItems = yield* SourceItemRepository;
    const tasks = yield* TaskRepository;
    const task = yield* tasks.createTask({ title: "移行する", status: options.status ?? "todo" });
    const url = `https://github.com/acme/app/pull/${1000 + itemNumber++}`;
    const item = yield* sourceItems.upsertItem({ source: options.source ?? "github:personal", url, externalId: url, title: url, state: "open", fingerprint: "v1" });
    yield* tasks.linkItem(task.id, item.id, "tracks");
    const plan = {
      steps: [
        { id: "w", kind: "wait", title: "CLI v3 の PR が出るのを待つ", effort: "easy", mode: "serial", status: "todo", ...(until === undefined ? {} : { until }) },
        { id: "m", kind: "manual", title: "移行する", effort: "tedious", mode: "serial", status: "todo" },
      ],
    } as NextActionPlan;
    yield* tasks.updateTask(task.id, { nextActions: plan });
    lastItemId = item.id;
    return task.id;
  });

const currentOf = (taskId: number) =>
  Effect.gen(function* () {
    const task = Option.getOrThrow(yield* (yield* TaskRepository).findTask(taskId));
    return currentSteps(Option.getOrThrow(decodePlan(task.nextActions))).map((step) => step.id);
  });

const opened = { kind: "pull_request_opened", repository: "acme/app", query: "@changesets/cli v3" };

describe("checkWaitConditions", () => {
  it.effect("待っている PR が出たら、待つ手順を済ませて次の手順に進め、更新マークで知らせる", () =>
    Effect.gen(function* () {
      const id = yield* waitingFor(opened);
      const searched: string[] = [];
      const client = gitHubClientStub({
        searchOpenPullRequests: (repository, query) => {
          searched.push(`${repository} ${query}`);
          return Effect.succeed({ urls: ["https://github.com/acme/app/pull/240"] });
        },
      });

      assert.strictEqual(yield* checkWaitConditions("personal", client), 1);

      assert.deepStrictEqual(searched, ["acme/app @changesets/cli v3"]);
      assert.deepStrictEqual(yield* currentOf(id), ["m"]);
      const last = (yield* (yield* TaskRepository).listChanges(id)).at(-1);
      assert.deepInclude(last, { field: "next_actions", actor: "sync" });
      assert.include(String(last?.after), "https://github.com/acme/app/pull/240");
      assert.isNull(last?.seenAt);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("検索に当たったのが Task 自身が追う PR だけなら、待ち終わりにしない（待っている別の PR ではない）", () =>
    Effect.gen(function* () {
      const id = yield* waitingFor(opened);
      const ownUrl = `https://github.com/acme/app/pull/${1000 + itemNumber - 1}`;
      const client = gitHubClientStub({ searchOpenPullRequests: () => Effect.succeed({ urls: [ownUrl] }) });

      assert.strictEqual(yield* checkWaitConditions("personal", client), 0);
      assert.deepStrictEqual(yield* currentOf(id), ["w"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("要確認の Task の待つ手順も見張る", () =>
    Effect.gen(function* () {
      const id = yield* waitingFor(opened, { status: "needs_review" });
      const client = gitHubClientStub({ searchOpenPullRequests: () => Effect.succeed({ urls: ["https://github.com/acme/app/pull/240"] }) });

      assert.strictEqual(yield* checkWaitConditions("personal", client), 1);
      assert.deepStrictEqual(yield* currentOf(id), ["m"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("何を待つかが分からない待つ手順は、元の項目に待ち始めたあとで動き（新しいコメントなど）があったら済ませる", () =>
    Effect.gen(function* () {
      const id = yield* waitingFor(undefined);
      const itemId = lastItemId;

      assert.strictEqual(yield* checkWaitConditions("personal", gitHubClientStub()), 0);

      yield* TestClock.adjust("1 minute");
      yield* (yield* SourceItemRepository).recordActivity(itemId, "changed");

      assert.strictEqual(yield* checkWaitConditions("personal", gitHubClientStub()), 1);
      assert.deepStrictEqual(yield* currentOf(id), ["m"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("待ち始める前の動きでは済ませない", () =>
    Effect.gen(function* () {
      const id = yield* waitingFor({ kind: "item_changed", since: "2100-01-01T00:00:00.000Z" });
      yield* TestClock.adjust("1 minute");
      yield* (yield* SourceItemRepository).recordActivity(lastItemId, "changed");

      assert.strictEqual(yield* checkWaitConditions("personal", gitHubClientStub()), 0);
      assert.deepStrictEqual(yield* currentOf(id), ["w"]);
    }).pipe(Effect.provide(TestDatabase)));

  const merged733 = (pullApi: string) =>
    Effect.succeed(
      pullApi.endsWith("/pulls/733")
        ? Option.some<unknown>({ merged: true, merge_commit_sha: "merge-sha", head: { sha: "pr-head" } })
        : pullApi.endsWith("/pulls/800")
          ? Option.some<unknown>({ merged: false, merge_commit_sha: null, head: { sha: "deploy-head" } })
          : Option.none(),
    );

  it.effect("自分の PR の merge commit が、開いている deploy の PR に入ったら済ませる", () =>
    Effect.gen(function* () {
      const until = { kind: "included_in_pull_request", repository: "acme/app", query: "Deploy stg", pullUrl: "https://github.com/acme/app/pull/733" };
      const id = yield* waitingFor(until);
      const compared: string[] = [];
      const client = (status: string) =>
        gitHubClientStub({
          getPullRequest: merged733,
          searchOpenPullRequests: () => Effect.succeed({ urls: ["https://github.com/acme/app/pull/800"] }),
          compareCommits: (_repository, base, head) => {
            compared.push(`${base}...${head}`);
            return Effect.succeed({ status });
          },
        });

      assert.strictEqual(yield* checkWaitConditions("personal", client("diverged")), 0);
      assert.deepStrictEqual(compared, ["merge-sha...deploy-head"]);
      assert.strictEqual(yield* checkWaitConditions("personal", client("ahead")), 1);
      assert.deepStrictEqual(yield* currentOf(id), ["m"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("自分の PR の merge commit を含む commit でワークフロー（deploy など）が成功したら済ませる。前の成功では済ませない", () =>
    Effect.gen(function* () {
      const until = { kind: "workflow_succeeded", repository: "acme/app", workflow: "deploy-stg.yml", pullUrl: "https://github.com/acme/app/pull/733" };
      const id = yield* waitingFor(until);
      const client = (runs: Array<{ headSha: string; conclusion: string | null }>) =>
        gitHubClientStub({
          getPullRequest: merged733,
          listWorkflowRuns: () => Effect.succeed(runs.map((run) => ({ ...run, status: run.conclusion === null ? "in_progress" : "completed", url: "u" }))),
          compareCommits: (_repository, _base, head) => Effect.succeed({ status: head === "new-deploy" ? "ahead" : "behind" }),
        });

      assert.strictEqual(yield* checkWaitConditions("personal", client([{ headSha: "old-deploy", conclusion: "success" }, { headSha: "new-deploy", conclusion: null }])), 0);
      assert.strictEqual(yield* checkWaitConditions("personal", client([{ headSha: "new-deploy", conclusion: "success" }])), 1);
      assert.deepStrictEqual(yield* currentOf(id), ["m"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("まだ出ていなければ、待ったままにする", () =>
    Effect.gen(function* () {
      const id = yield* waitingFor(opened);

      assert.strictEqual(yield* checkWaitConditions("personal", gitHubClientStub()), 0);
      assert.deepStrictEqual(yield* currentOf(id), ["w"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("待ち始めたあとにレビューが付いたら済ませる（前からあったレビューでは済ませない）", () =>
    Effect.gen(function* () {
      const until = { kind: "review_submitted", pullUrl: "https://github.com/acme/app/pull/233", since: "2026-11-25T00:00:00.000Z" };
      const before = yield* waitingFor(until);
      const reviewedPulls: string[] = [];
      const reviews = (submitted: string) =>
        gitHubClientStub({
          listReviews: (pullApiUrl) => {
            reviewedPulls.push(pullApiUrl);
            return Effect.succeed([{ submitted_at: submitted }]);
          },
        });

      assert.strictEqual(yield* checkWaitConditions("personal", reviews("2026-11-24T23:00:00Z")), 0);
      assert.deepStrictEqual(yield* currentOf(before), ["w"]);
      assert.strictEqual(reviewedPulls[0], "https://api.github.com/repos/acme/app/pulls/233");

      assert.strictEqual(yield* checkWaitConditions("personal", reviews("2026-11-25T01:00:00Z")), 1);
      assert.deepStrictEqual(yield* currentOf(before), ["m"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("merge されたら済ませる", () =>
    Effect.gen(function* () {
      const id = yield* waitingFor({ kind: "merged", pullUrl: "https://github.com/acme/app/pull/233" });
      const client = gitHubClientStub({ getPullRequest: () => Effect.succeed(Option.some<unknown>({ merged: true })) });

      assert.strictEqual(yield* checkWaitConditions("personal", client), 1);
      assert.deepStrictEqual(yield* currentOf(id), ["m"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("ほかのアカウントの Task と、終わった Task は見ない（会社のトークンで私用の PR を見に行かない）", () =>
    Effect.gen(function* () {
      yield* waitingFor(opened, { source: "github:work" });
      yield* waitingFor(opened, { status: "done" });
      const client = gitHubClientStub({ searchOpenPullRequests: () => Effect.die(new Error("呼ばれてはいけない")) });

      assert.strictEqual(yield* checkWaitConditions("personal", client), 0);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("1 件を確かめられなくても、ほかの Task は確かめる", () =>
    Effect.gen(function* () {
      const broken = yield* waitingFor({ kind: "merged", pullUrl: "https://github.com/acme/app/pull/1" });
      const ok = yield* waitingFor(opened);
      const client = gitHubClientStub({
        getPullRequest: () => Effect.die(new Error("取れない")),
        searchOpenPullRequests: () => Effect.succeed({ urls: ["https://github.com/acme/app/pull/240"] }),
      });

      assert.strictEqual(yield* checkWaitConditions("personal", client), 1);
      assert.deepStrictEqual(yield* currentOf(broken), ["w"]);
      assert.deepStrictEqual(yield* currentOf(ok), ["m"]);
    }).pipe(Effect.provide(TestDatabase)));
});
