import { DateTime, Effect, Option, Schema } from "effect";
import type { Condition, WatchProvider } from "../../core/watch/watcher.js";
import { decodeResponse, type GitHubAdapterError, GitHubClient } from "./github-adapter.js";
import { githubSourceName } from "./github-binding.js";
import { makeRepositoryFilter, type RepositoryFilterConfig } from "./repository-filter.js";

export type CheckRun = { status: string; conclusion: string | null };
export type PullRequestReview = { login: string; state: string; commitId: string; submittedAt: string };

export type GitHubPullRequestSubject = {
  apiUrl: string;
  number: number;
  title: string;
  repository: string;
  htmlUrl: string;
  headSha: string;
  /** GitHub が計算中のときは null */
  mergeable: boolean | null;
  checkRuns: ReadonlyArray<CheckRun>;
  reviews: ReadonlyArray<PullRequestReview>;
};

const SearchResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      repository_url: Schema.String,
      html_url: Schema.String,
      updated_at: Schema.String,
      pull_request: Schema.Struct({ url: Schema.String }),
    }),
  ),
});

/** "https://api.github.com/repos/acme/app" → "acme/app" */
const repositoryOf = (repositoryUrl: string) => new URL(repositoryUrl).pathname.replace(/^\/repos\//, "");
const PullRequestDetail = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  mergeable: Schema.NullOr(Schema.Boolean),
  head: Schema.Struct({ sha: Schema.String }),
  base: Schema.Struct({ repo: Schema.Struct({ full_name: Schema.String }) }),
});
const CheckRunsResponse = Schema.Struct({
  check_runs: Schema.Array(Schema.Struct({ status: Schema.String, conclusion: Schema.NullOr(Schema.String) })),
});
const ReviewsResponse = Schema.Array(
  Schema.Struct({
    user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
    state: Schema.String,
    commit_id: Schema.NullOr(Schema.String),
    submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const decodeSearchResult = decodeResponse(SearchResult);
const decodePullRequest = decodeResponse(PullRequestDetail);
const decodeCheckRuns = decodeResponse(CheckRunsResponse);
const decodeReviews = decodeResponse(ReviewsResponse);


export type GitHubWatchOptions = { repositoryFilter?: RepositoryFilterConfig };

export const makeGitHubPullRequestWatchProvider = Effect.fnUntraced(function* (accountId: string, options: GitHubWatchOptions = {}) {
  const client = yield* GitHubClient;
  const isTargetRepository = yield* makeRepositoryFilter(options.repositoryFilter ?? {});

  const loadSubject = Effect.fnUntraced(function* (apiUrl: string) {
    const raw = yield* client.getPullRequest(apiUrl);
    if (Option.isNone(raw)) return Option.none<GitHubPullRequestSubject>();
    const pull = yield* decodePullRequest(raw.value);
    const repository = pull.base.repo.full_name;

    const checkRuns = yield* client.listCheckRuns(repository, pull.head.sha).pipe(Effect.flatMap(decodeCheckRuns));
    const reviews = yield* client.listReviews(apiUrl).pipe(Effect.flatMap(decodeReviews));

    return Option.some<GitHubPullRequestSubject>({
      apiUrl,
      number: pull.number,
      title: pull.title,
      repository,
      htmlUrl: pull.html_url,
      headSha: pull.head.sha,
      mergeable: pull.mergeable,
      checkRuns: checkRuns.check_runs.map(({ status, conclusion }) => ({ status, conclusion })),
      reviews: reviews.flatMap((review) =>
        review.user === null || review.commit_id === null || review.submitted_at == null
          ? []
          : [{ login: review.user.login, state: review.state, commitId: review.commit_id, submittedAt: review.submitted_at }],
      ),
    });
  });

  const listSubjects = client.searchMyOpenPullRequests.pipe(
    Effect.flatMap(decodeSearchResult),
    // 一覧の段階で外す理由: 見張りは PR ごとに 3 回 API を呼ぶので、対象外の PR を先に除けば呼び出しが減る。
    Effect.map((search) =>
      search.items
        .filter((item) => isTargetRepository(repositoryOf(item.repository_url)))
        .map((item) => ({ id: item.pull_request.url, url: item.html_url, revision: item.updated_at })),
    ),
  );

  return {
    source: githubSourceName(accountId),
    listSubjects,
    loadSubject: (ref) => loadSubject(ref.id),
    fingerprint: pullRequestFingerprint,
  } satisfies WatchProvider<GitHubPullRequestSubject, GitHubAdapterError>;
});

/**
 * 条件の判定に効く値だけを並べる。説明文の編集のように判定に効かない変化では、見張る間隔を戻さない。
 * conflict はベースブランチが進んで起きることが多く PR の updated_at は変わらないため、mergeable も含める。
 */
export const pullRequestFingerprint = (subject: GitHubPullRequestSubject) =>
  JSON.stringify([
    subject.headSha,
    subject.mergeable,
    subject.checkRuns.map((run) => `${run.status}:${run.conclusion}`).toSorted(),
    subject.reviews.map((review) => `${review.login}:${review.state}:${review.commitId}`).toSorted(),
  ]);

const label = (subject: GitHubPullRequestSubject) => `PR #${subject.number}`;

export const pullRequestConflict: Condition<GitHubPullRequestSubject> = {
  id: "pr-conflict",
  title: (subject) => `${label(subject)} の conflict を解消する（${subject.repository}）`,
  evaluate: (subject) => (subject.mergeable === null ? "unknown" : subject.mergeable ? "clear" : "holds"),
};

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "action_required"]);

export const pullRequestChecksFailing: Condition<GitHubPullRequestSubject> = {
  id: "pr-checks-failing",
  title: (subject) => `${label(subject)} の CI の失敗を直す（${subject.repository}）`,
  evaluate: (subject) => {
    if (subject.checkRuns.some((run) => run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion))) return "holds";
    // 実行中を unknown にする理由: 失敗した CI を再実行している最中に clear と扱うと、
    // Task がいったん done になり、また失敗すると todo に戻る往復が起きるため。
    if (subject.checkRuns.some((run) => run.status !== "completed")) return "unknown";
    return "clear";
  },
};

// COMMENTED を最新のレビューとして扱わない理由: changes requested のあとに質問のコメントを付けただけで、
// 指摘が取り消されたことにならないようにするため。
const DECISIVE_REVIEW_STATES: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

const epochOf = (iso: string) =>
  Option.match(DateTime.make(iso), { onNone: () => Number.NEGATIVE_INFINITY, onSome: DateTime.toEpochMillis });

export const pullRequestChangesRequested: Condition<GitHubPullRequestSubject> = {
  id: "pr-changes-requested",
  title: (subject) => `${label(subject)} のレビュー指摘に対応する（${subject.repository}）`,
  evaluate: (subject) => {
    const latestByReviewer = new Map<string, PullRequestReview>();
    const decisive = subject.reviews
      .filter((review) => DECISIVE_REVIEW_STATES.has(review.state))
      .toSorted((a, b) => epochOf(a.submittedAt) - epochOf(b.submittedAt));
    for (const review of decisive) latestByReviewer.set(review.login, review);

    // head のコミットに対する指摘だけを見る理由: 修正を push しても reviewer が見直すまで GitHub 上は
    // CHANGES_REQUESTED のままなので、それを holds にすると自分の番が終わっても Task が残り続けるため。
    const requested = [...latestByReviewer.values()].some(
      (review) => review.state === "CHANGES_REQUESTED" && review.commitId === subject.headSha,
    );
    return requested ? "holds" : "clear";
  },
};

export const pullRequestConditions: ReadonlyArray<Condition<GitHubPullRequestSubject>> = [
  pullRequestConflict,
  pullRequestChecksFailing,
  pullRequestChangesRequested,
];
