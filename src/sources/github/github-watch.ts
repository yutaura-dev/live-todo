import { DateTime, Effect, Option, Schema } from "effect";
import type { Condition, WatchProvider } from "../../core/watch/watcher.js";
import { decodeResponse, type GitHubAdapterError, GitHubClient } from "./github-adapter.js";
import { githubSourceName } from "./github-binding.js";

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
  items: Schema.Array(Schema.Struct({ pull_request: Schema.Struct({ url: Schema.String }) })),
});
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

// 1 回の見張りで GitHub の API レート制限を使い切らないよう、同時に詳細を取りに行く PR の数を絞る。
const PULL_REQUEST_FETCH_CONCURRENCY = 5;

export const makeGitHubPullRequestWatchProvider = Effect.fnUntraced(function* (accountId: string) {
  const client = yield* GitHubClient;

  const loadSubject = Effect.fnUntraced(function* (apiUrl: string) {
    const raw = yield* client.getPullRequest(apiUrl);
    if (Option.isNone(raw)) return Option.none<GitHubPullRequestSubject>();
    const pull = yield* decodePullRequest(raw.value);
    const repository = pull.base.repo.full_name;

    const [checkRuns, reviews] = yield* Effect.all(
      [
        client.listCheckRuns(repository, pull.head.sha).pipe(Effect.flatMap(decodeCheckRuns)),
        client.listReviews(apiUrl).pipe(Effect.flatMap(decodeReviews)),
      ],
      { concurrency: 2 },
    );

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

  const subjects = Effect.gen(function* () {
    const search = yield* client.searchMyOpenPullRequests.pipe(Effect.flatMap(decodeSearchResult));
    const loaded = yield* Effect.forEach(search.items, (item) => loadSubject(item.pull_request.url), {
      concurrency: PULL_REQUEST_FETCH_CONCURRENCY,
    });
    return loaded.flatMap((subject) => (Option.isSome(subject) ? [subject.value] : []));
  });

  return {
    source: githubSourceName(accountId),
    subjects,
    subjectId: (subject) => subject.apiUrl,
    subjectUrl: (subject) => subject.htmlUrl,
  } satisfies WatchProvider<GitHubPullRequestSubject, GitHubAdapterError>;
});

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
