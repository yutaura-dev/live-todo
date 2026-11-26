import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { TestDatabase } from "../../core/db/test-database.js";
import { SourceItemRepository } from "../../core/source/source-item-repository.js";
import { syncSource } from "../../core/sync/sync-source.js";
import { TaskRepository } from "../../core/task/task-repository.js";
import { watchBinding } from "../../core/watch/watch-binding.js";
import checkRunsFailed from "./__fixtures__/check-runs-failed.json" with { type: "json" };
import conflictedPull from "./__fixtures__/pull-42-open-conflict.json" with { type: "json" };
import reviewsChangesRequested from "./__fixtures__/reviews-changes-requested.json" with { type: "json" };
import searchResult from "./__fixtures__/search-my-open-prs.json" with { type: "json" };
import { GitHubClient, GitHubResponseError } from "./github-adapter.js";
import {
  type GitHubPullRequestSubject,
  makeGitHubPullRequestWatchProvider,
  pullRequestChangesRequested,
  pullRequestChecksFailing,
  pullRequestConflict,
  pullRequestConditions,
  pullRequestFingerprint,
} from "./github-watch.js";
import { gitHubClientStub } from "./test-client.js";

const PULL_URL = "https://api.github.com/repos/acme/app/pulls/42";
const NOW = DateTime.makeUnsafe("2026-11-25T00:00:00Z");

const subject = (overrides: Partial<GitHubPullRequestSubject> = {}): GitHubPullRequestSubject => ({
  apiUrl: PULL_URL,
  number: 42,
  title: "Add retry to sync",
  repository: "acme/app",
  htmlUrl: "https://github.com/acme/app/pull/42",
  headSha: "head-sha-2",
  mergeable: true,
  checkRuns: [],
  reviews: [],
  ...overrides,
});

const review = (login: string, state: string, commitId = "head-sha-2", submittedAt = "2026-11-24T10:00:00Z") => ({
  login,
  state,
  commitId,
  submittedAt,
});

describe("pullRequestConflict", () => {
  it.each([
    [false, "holds"],
    [true, "clear"],
    [null, "unknown"],
  ] as const)("mergeable が %s なら %s", (mergeable, verdict) => {
    assert.strictEqual(pullRequestConflict.evaluate(subject({ mergeable }), NOW), verdict);
  });

  it("title は PR とリポジトリがわかる、やることの形にする", () => {
    assert.strictEqual(pullRequestConflict.title(subject()), "PR #42 の conflict を解消する（acme/app）");
  });
});

describe("pullRequestChecksFailing", () => {
  it("失敗した check があれば holds", () => {
    const checkRuns = [
      { status: "completed", conclusion: "failure" },
      { status: "completed", conclusion: "success" },
    ];
    assert.strictEqual(pullRequestChecksFailing.evaluate(subject({ checkRuns }), NOW), "holds");
  });

  it("すべて完了して失敗がなければ clear", () => {
    const checkRuns = [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }];
    assert.strictEqual(pullRequestChecksFailing.evaluate(subject({ checkRuns }), NOW), "clear");
  });

  it("失敗はないが実行中の check があれば unknown", () => {
    const checkRuns = [{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "success" }];
    assert.strictEqual(pullRequestChecksFailing.evaluate(subject({ checkRuns }), NOW), "unknown");
  });

  it("check が 1 つもなければ clear", () => {
    assert.strictEqual(pullRequestChecksFailing.evaluate(subject({ checkRuns: [] }), NOW), "clear");
  });
});

describe("pullRequestChangesRequested", () => {
  it("今の head に対して changes requested が付いていれば holds", () => {
    assert.strictEqual(
      pullRequestChangesRequested.evaluate(subject({ reviews: [review("alice", "CHANGES_REQUESTED")] }), NOW),
      "holds",
    );
  });

  it("changes requested が古いコミットに対するもの（修正を push 済み）なら clear", () => {
    assert.strictEqual(
      pullRequestChangesRequested.evaluate(subject({ reviews: [review("alice", "CHANGES_REQUESTED", "head-sha-1")] }), NOW),
      "clear",
    );
  });

  it("同じ reviewer があとから APPROVED にしたら clear", () => {
    const reviews = [
      review("alice", "CHANGES_REQUESTED", "head-sha-2", "2026-11-24T10:00:00Z"),
      review("alice", "APPROVED", "head-sha-2", "2026-11-24T11:00:00Z"),
    ];
    assert.strictEqual(pullRequestChangesRequested.evaluate(subject({ reviews }), NOW), "clear");
  });

  it("changes requested のあとのコメントだけのレビューでは解消しない", () => {
    const reviews = [
      review("alice", "CHANGES_REQUESTED", "head-sha-2", "2026-11-24T10:00:00Z"),
      review("alice", "COMMENTED", "head-sha-2", "2026-11-24T11:00:00Z"),
    ];
    assert.strictEqual(pullRequestChangesRequested.evaluate(subject({ reviews }), NOW), "holds");
  });

  it("別の reviewer が APPROVED にしても、changes requested を付けた reviewer の指摘は残る", () => {
    const reviews = [review("alice", "CHANGES_REQUESTED"), review("bob", "APPROVED")];
    assert.strictEqual(pullRequestChangesRequested.evaluate(subject({ reviews }), NOW), "holds");
  });
});

describe("pullRequestFingerprint", () => {
  it("mergeable が変わると fingerprint が変わる（ベースブランチが進んで conflict したときに気づける）", () => {
    assert.notStrictEqual(pullRequestFingerprint(subject({ mergeable: true })), pullRequestFingerprint(subject({ mergeable: false })));
  });

  it("判定に効く値が同じなら、タイトルが変わっても fingerprint は同じ", () => {
    assert.strictEqual(pullRequestFingerprint(subject()), pullRequestFingerprint(subject({ title: "renamed" })));
  });
});

describe("makeGitHubPullRequestWatchProvider", () => {
  const clientWith = (responses: { pull?: unknown; search?: unknown }) =>
    gitHubClientStub({
      searchMyOpenPullRequests: Effect.succeed<unknown>(responses.search ?? searchResult),
      getPullRequest: () => Effect.succeed(Option.fromNullishOr(responses.pull)),
      listCheckRuns: () => Effect.succeed<unknown>(checkRunsFailed),
      listReviews: () => Effect.succeed<unknown>(reviewsChangesRequested),
    });

  const subjectsWith = (client: GitHubClient["Service"]) =>
    Effect.gen(function* () {
      const provider = yield* makeGitHubPullRequestWatchProvider("work");
      const refs = yield* provider.listSubjects;
      const loaded = yield* Effect.forEach(refs, provider.loadSubject);
      return loaded.flatMap((value) => Option.toArray(value));
    }).pipe(Effect.provideService(GitHubClient, client));

  it.effect("一覧には、PR の API の URL・Web の URL・更新時刻（revision）を入れる", () =>
    Effect.gen(function* () {
      const refs = yield* Effect.gen(function* () {
        const provider = yield* makeGitHubPullRequestWatchProvider("work");
        return yield* provider.listSubjects;
      }).pipe(Effect.provideService(GitHubClient, clientWith({ pull: conflictedPull })));

      assert.deepStrictEqual(refs, [{ id: PULL_URL, url: "https://github.com/acme/app/pull/42", revision: "2026-11-24T10:00:00Z" }]);
    }));

  it.effect("自分の open な PR を、マージ可否・check・レビュー付きの見張る対象にする", () =>
    Effect.gen(function* () {
      const subjects = yield* subjectsWith(clientWith({ pull: conflictedPull }));

      assert.deepStrictEqual(subjects, [
        subject({
          mergeable: false,
          checkRuns: [
            { status: "completed", conclusion: "failure" },
            { status: "completed", conclusion: "success" },
          ],
          reviews: [review("alice", "CHANGES_REQUESTED")],
        }),
      ]);
    }));

  it.effect("リポジトリのフィルターに一致しない PR は見張らず、詳細も取りに行かない", () =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const client = gitHubClientStub({
        searchMyOpenPullRequests: Effect.succeed<unknown>({
          items: [
            { repository_url: "https://api.github.com/repos/acme/app", html_url: "h", updated_at: "u", pull_request: { url: PULL_URL } },
            {
              repository_url: "https://api.github.com/repos/old-contest/app",
              html_url: "h",
              updated_at: "u",
              pull_request: { url: "https://api.github.com/repos/old-contest/app/pulls/1" },
            },
          ],
        }),
        getPullRequest: (url) => {
          requested.push(url);
          return Effect.succeed(Option.some<unknown>(conflictedPull));
        },
        listCheckRuns: () => Effect.succeed<unknown>(checkRunsFailed),
        listReviews: () => Effect.succeed<unknown>(reviewsChangesRequested),
      });

      const subjects = yield* Effect.gen(function* () {
        const provider = yield* makeGitHubPullRequestWatchProvider("work", { repositoryFilter: { exclude: ["old-contest/*"] } });
        const refs = yield* provider.listSubjects;
        return (yield* Effect.forEach(refs, provider.loadSubject)).flatMap((value) => Option.toArray(value));
      }).pipe(Effect.provideService(GitHubClient, client));

      assert.deepStrictEqual(subjects.map((subject) => subject.apiUrl), [PULL_URL]);
      assert.deepStrictEqual(requested, [PULL_URL]);
    }));

  it.effect("30 日より長く動きのない PR は見張らない（放ってある古い PR の conflict で Task を作らない）", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T00:00:00Z"));
      const client = gitHubClientStub({
        searchMyOpenPullRequests: Effect.succeed<unknown>({
          items: [
            { repository_url: "https://api.github.com/repos/acme/app", html_url: "recent", updated_at: "2026-10-27T00:00:00Z", pull_request: { url: PULL_URL } },
            { repository_url: "https://api.github.com/repos/acme/app", html_url: "stale", updated_at: "2026-10-25T00:00:00Z", pull_request: { url: `${PULL_URL}0` } },
          ],
        }),
        getPullRequest: () => Effect.succeed(Option.some<unknown>(conflictedPull)),
        listCheckRuns: () => Effect.succeed<unknown>(checkRunsFailed),
        listReviews: () => Effect.succeed<unknown>(reviewsChangesRequested),
      });

      const refs = yield* Effect.gen(function* () {
        return yield* (yield* makeGitHubPullRequestWatchProvider("work")).listSubjects;
      }).pipe(Effect.provideService(GitHubClient, client));

      assert.deepStrictEqual(refs.map((ref) => ref.url), ["recent"]);
    }));

  it.effect("PR の詳細が取れない（削除・権限喪失）ものは見張る対象から外す", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* subjectsWith(clientWith({ pull: undefined })), []);
    }));

  it.effect("検索の応答が想定した形でないときはエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(subjectsWith(clientWith({ search: { items: [{ number: "x" }] } })));

      assert.instanceOf(error, GitHubResponseError);
    }));

  it.effect("Sync につなぐと、困った状態ごとに Task ができる", () =>
    Effect.gen(function* () {
      const provider = yield* makeGitHubPullRequestWatchProvider("work").pipe(
        Effect.provideService(GitHubClient, clientWith({ pull: conflictedPull })),
      );
      const binding = watchBinding(provider, pullRequestConditions);

      yield* syncSource(binding);

      const items = yield* SourceItemRepository;
      const tasks = yield* TaskRepository;
      const titles: string[] = [];
      for (const condition of pullRequestConditions) {
        const item = yield* items.findItem("github:work:watch", `${PULL_URL}#${condition.id}`);
        const task = Option.isSome(item) ? yield* tasks.findTaskByItem(item.value.id) : Option.none();
        if (Option.isSome(task)) titles.push(task.value.title);
      }
      assert.deepStrictEqual(titles, [
        "PR #42 の conflict を解消する（acme/app）",
        "PR #42 の CI の失敗を直す（acme/app）",
        "PR #42 のレビュー指摘に対応する（acme/app）",
      ]);
    }).pipe(Effect.provide(TestDatabase)));
});
