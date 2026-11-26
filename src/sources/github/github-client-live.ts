import { DateTime, Effect, Layer, Option, Redacted, Ref, Schema, Semaphore } from "effect";
import { Headers, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { type GitHubClientError, GitHubClient, GitHubRateLimitedError, GitHubRequestError } from "./github-adapter.js";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const PER_PAGE = "100";
// 1 回の取得でたどるページ数の上限。想定外に大量の結果が返ったときに、API の残り回数を使い切らないため。
const MAX_PAGES = 10;

const ArrayBody = Schema.Array(Schema.Unknown);
const SearchBody = Schema.Struct({ items: ArrayBody });
const CompareBody = Schema.Struct({ status: Schema.String });
const WorkflowRunsBody = Schema.Struct({
  workflow_runs: Schema.Array(
    Schema.Struct({ head_sha: Schema.String, status: Schema.String, conclusion: Schema.NullOr(Schema.String), html_url: Schema.String }),
  ),
});
const SearchCountBody = Schema.Struct({ total_count: Schema.Number, items: Schema.Array(Schema.Struct({ html_url: Schema.String })) });
const CheckRunsBody = Schema.Struct({ check_runs: ArrayBody });
const ErrorBody = Schema.Struct({ message: Schema.String });
const RepositoryBody = Schema.Struct({
  allow_squash_merge: Schema.Boolean,
  allow_merge_commit: Schema.Boolean,
  allow_rebase_merge: Schema.Boolean,
});
const MergeBody = Schema.Struct({ sha: Schema.String });
const CommitsBody = Schema.Array(Schema.Struct({ commit: Schema.Struct({ message: Schema.String }), parents: Schema.Array(Schema.Unknown) }));
// 慣習を読み取るのに使う commit の数。1 ページで足り、API の回数を増やさない
const RECENT_COMMITS = "30";
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

export type GitHubClientLiveOptions = { token: Redacted.Redacted<string> };

export const GitHubClientLive = (options: GitHubClientLiveOptions) =>
  Layer.effect(
    GitHubClient,
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
            HttpClientRequest.setHeader("x-github-api-version", API_VERSION),
            HttpClientRequest.bearerToken(Redacted.value(options.token)),
          ),
        ),
      );

      // トークンごとに 1 本のキューで順番に送る理由: GitHub は同じユーザーからのリクエストを並行ではなく
      // 順番に送ることを推奨しており、並行に送ると短時間の集中に対する制限（secondary rate limit）にかかりやすい。
      // 上限はトークン単位で数えられるので、通知の同期と見張りの同期もこのキューを共有する。
      const queue = yield* Semaphore.make(1);
      // レート制限を受けたら解除時刻を覚え、それまではキューに並んでいるリクエストも送らずに失敗させる。
      // 送り続けると同じ 403 がまとめて返り、secondary rate limit の最中なら制限が延びることもあるため。
      const blockedUntil = yield* Ref.make(Option.none<DateTime.Utc>());

      // 応答に含まれる URL（通知の subject.url など）を取りに行くメソッドがあるため、
      // api.github.com 以外を指していたらトークンを付けて送らないよう、送る前に宛先を確かめる。
      const resolveUrl = (target: string, params: Record<string, string> = {}): Effect.Effect<URL, GitHubRequestError> => {
        const url = new URL(target, API_ORIGIN);
        if (url.origin !== API_ORIGIN) {
          return Effect.fail(new GitHubRequestError({ message: `api.github.com 以外には送らない: ${url.origin}` }));
        }
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return Effect.succeed(url);
      };

      const describe = (url: URL, method = "GET") => `${method} ${url.pathname}`;

      const rateLimitResetAt = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
        const header = (name: string) => Headers.get(response.headers, name);
        const retryAfter = Option.flatMap(header("retry-after"), (value) => Option.fromNullishOr(Number.parseInt(value, 10) || null));
        if (Option.isSome(retryAfter)) {
          return Option.some(DateTime.add(yield* DateTime.now, { seconds: retryAfter.value }));
        }
        const exhausted = Option.getOrUndefined(header("x-ratelimit-remaining")) === "0";
        const reset = Option.flatMap(header("x-ratelimit-reset"), (value) => Option.fromNullishOr(Number.parseInt(value, 10) || null));
        if (exhausted && Option.isSome(reset)) {
          return Option.some(DateTime.makeUnsafe(reset.value * 1000));
        }
        return Option.none<DateTime.Utc>();
      });

      /** 404 / 410 のときは none、2xx は応答、それ以外は GitHubClientError */
      const sendOnce = Effect.fnUntraced(function* (url: URL, request: HttpClientRequest.HttpClientRequest = HttpClientRequest.get(url.toString())): Effect.fn.Return<
        Option.Option<HttpClientResponse.HttpClientResponse>,
        GitHubClientError
      > {
        const response = yield* http.execute(request).pipe(
          // cause に元のエラーを入れない理由: HttpClientError は送ったリクエスト（authorization ヘッダーを含む）を
          // 持っているため、ログに出したときにトークンが漏れる。エラーの種類と送り先だけを残す。
          Effect.mapError(
            (error) => new GitHubRequestError({ message: `GitHub API に接続できない（${error.reason._tag}）: ${describe(url, request.method)}` }),
          ),
        );
        if (response.status >= 200 && response.status < 300) return Option.some(response);
        if (response.status === 404 || response.status === 410) return Option.none();

        if (response.status === 403 || response.status === 429) {
          const resetAt = yield* rateLimitResetAt(response);
          if (Option.isSome(resetAt)) {
            yield* Ref.set(blockedUntil, resetAt);
            return yield* new GitHubRateLimitedError({ resetAt: DateTime.formatIso(resetAt.value) });
          }
        }
        // GitHub が返した理由（本文の message）を含める理由: 422 のようにステータスだけでは原因がわからない失敗があるため。
        // 本文にトークンは含まれない。
        const reason = yield* response.json.pipe(
          Effect.map((body) => Option.match(decodeErrorBody(body), { onNone: () => "", onSome: ({ message }) => `: ${message}` })),
          Effect.orElseSucceed(() => ""),
        );
        return yield* new GitHubRequestError({
          message: `GitHub API が ${response.status} を返した: ${describe(url, request.method)}${reason}`,
          status: response.status,
        });
      });

      const send = (url: URL, request?: HttpClientRequest.HttpClientRequest) =>
        Semaphore.withPermits(
          queue,
          1,
          Effect.gen(function* () {
            // 解除時刻の確認をキューの中で行う理由: 前に並んでいたリクエストがレート制限を受けた直後に、
            // 後ろのリクエストがその結果を見てから送るかどうかを決められるようにするため。
            const blocked = yield* Ref.get(blockedUntil);
            if (Option.isSome(blocked) && DateTime.toEpochMillis(yield* DateTime.now) < DateTime.toEpochMillis(blocked.value)) {
              return yield* new GitHubRateLimitedError({ resetAt: DateTime.formatIso(blocked.value) });
            }
            return yield* sendOnce(url, request);
          }),
        );

      const jsonOf = (url: URL) => (response: HttpClientResponse.HttpClientResponse) =>
        response.json.pipe(
          Effect.mapError(() => new GitHubRequestError({ message: `GitHub API の応答が JSON ではない: ${describe(url)}` })),
        );

      const decodeBody = <S extends Schema.Top>(schema: S, url: URL) => {
        const decode = Schema.decodeUnknownEffect(schema);
        return (body: unknown) =>
          decode(body).pipe(
            Effect.mapError((error) => new GitHubRequestError({ message: `GitHub API の応答の形が想定と違う: ${describe(url)}: ${error.message}` })),
          );
      };

      const nextPageUrl = (response: HttpClientResponse.HttpClientResponse) =>
        Option.flatMap(Headers.get(response.headers, "link"), (link) =>
          Option.fromNullishOr(/<([^>]+)>\s*;\s*rel="next"/.exec(link)?.[1]),
        );

      /** Link ヘッダーの next をたどり、各ページから pick で取り出した要素をつなげる */
      const collectPages = Effect.fnUntraced(function* (
        first: URL,
        pick: (body: unknown, url: URL) => Effect.Effect<ReadonlyArray<unknown>, GitHubRequestError>,
      ): Effect.fn.Return<{ items: unknown[]; truncated: boolean }, GitHubClientError> {
        const collected: unknown[] = [];
        let truncated = false;
        let url: URL | undefined = first;
        for (let page = 0; url !== undefined; page++) {
          if (page >= MAX_PAGES) {
            yield* Effect.logWarning("ページ数の上限に達したため、残りのページは次の取得に回す").pipe(
              Effect.annotateLogs({ path: first.pathname, maxPages: MAX_PAGES }),
            );
            truncated = true;
            break;
          }
          const current: URL = url;
          const response = yield* send(current);
          if (Option.isNone(response)) break;
          collected.push(...(yield* pick(yield* jsonOf(current)(response.value), current)));
          const next = nextPageUrl(response.value);
          url = Option.isSome(next) ? yield* resolveUrl(next.value) : undefined;
        }
        return { items: collected, truncated };
      });

      const getOptional = Effect.fnUntraced(function* (apiUrl: string) {
        const url = yield* resolveUrl(apiUrl);
        const response = yield* send(url);
        if (Option.isNone(response)) return Option.none<unknown>();
        return Option.some<unknown>(yield* jsonOf(url)(response.value));
      });

      const arrayItems = (body: unknown, url: URL) => decodeBody(ArrayBody, url)(body);

      return GitHubClient.of({
        listNotifications: ({ since, before, all }) =>
          resolveUrl("/notifications", {
            since,
            ...(before === undefined ? {} : { before }),
            all: String(all),
            per_page: "50",
          }).pipe(
            Effect.flatMap((url) => collectPages(url, arrayItems)),
            Effect.map(({ items, truncated }) => ({ notifications: items, truncated })),
          ),
        getSubject: getOptional,
        getPullRequest: getOptional,
        getComment: getOptional,
        getViewer: resolveUrl("/user").pipe(
          Effect.flatMap((url) =>
            getOptional(url.toString()).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new GitHubRequestError({ message: "自分のアカウントを取得できない: GET /user", status: 404 })),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
        ),
        inspectToken: Effect.gen(function* () {
          const url = yield* resolveUrl("/user");
          const response = yield* send(url);
          if (Option.isNone(response)) {
            return yield* new GitHubRequestError({ message: "自分のアカウントを取得できない: GET /user", status: 404 });
          }
          const header = (name: string) => Option.getOrUndefined(Headers.get(response.value.headers, name));
          const scopesHeader = header("x-oauth-scopes");
          // 形式は "2026-12-01 09:00:00 UTC"。ISO 8601 に直してから読む
          const expirationHeader = header("github-authentication-token-expiration");
          const expiresAt =
            expirationHeader === undefined
              ? undefined
              : Option.getOrUndefined(
                  Option.map(DateTime.make(expirationHeader.replace(" UTC", "Z").replace(" ", "T")), DateTime.formatIso),
                );
          return {
            viewer: yield* jsonOf(url)(response.value),
            scopes: scopesHeader === undefined ? undefined : scopesHeader.split(",").map((scope) => scope.trim()).filter((scope) => scope !== ""),
            expiresAt,
          };
        }),
        searchMyOpenPullRequests: resolveUrl("/search/issues", {
          q: "is:pr is:open author:@me archived:false",
          per_page: PER_PAGE,
        }).pipe(
          Effect.flatMap((url) =>
            collectPages(url, (body, pageUrl) => decodeBody(SearchBody, pageUrl)(body).pipe(Effect.map((page) => page.items))),
          ),
          Effect.map(({ items }) => ({ items })),
        ),
        listCheckRuns: (repository, sha) => {
          const repoPath = repository.split("/").map(encodeURIComponent).join("/");
          return resolveUrl(`/repos/${repoPath}/commits/${encodeURIComponent(sha)}/check-runs`, { per_page: PER_PAGE }).pipe(
            Effect.flatMap((url) =>
              collectPages(url, (body, pageUrl) =>
                decodeBody(CheckRunsBody, pageUrl)(body).pipe(Effect.map((page) => page.check_runs)),
              ),
            ),
            Effect.map(({ items }) => ({ check_runs: items })),
          );
        },
        getRepository: (repository) =>
          Effect.gen(function* () {
            const url = yield* resolveUrl(`/repos/${repository.split("/").map(encodeURIComponent).join("/")}`);
            const response = yield* send(url);
            if (Option.isNone(response)) {
              return yield* new GitHubRequestError({ message: `リポジトリが見つからない: ${repository}`, status: 404 });
            }
            const body = yield* jsonOf(url)(response.value).pipe(Effect.flatMap(decodeBody(RepositoryBody, url)));
            return { allowSquashMerge: body.allow_squash_merge, allowMergeCommit: body.allow_merge_commit, allowRebaseMerge: body.allow_rebase_merge };
          }),
        mergePullRequest: ({ repository, number, sha, method }) =>
          Effect.gen(function* () {
            const url = yield* resolveUrl(`/repos/${repository.split("/").map(encodeURIComponent).join("/")}/pulls/${number}/merge`);
            // sha を必ず付ける理由: 調べたあとに PR へ commit が足されていたら、GitHub に merge を断らせるため
            const request = HttpClientRequest.put(url.toString()).pipe(HttpClientRequest.bodyJsonUnsafe({ sha, merge_method: method }));
            const response = yield* send(url, request);
            if (Option.isNone(response)) {
              return yield* new GitHubRequestError({ message: `PR が見つからない: ${repository}#${number}`, status: 404 });
            }
            const body = yield* jsonOf(url)(response.value).pipe(Effect.flatMap(decodeBody(MergeBody, url)));
            return { sha: body.sha };
          }),
        listRecentCommits: (repository) =>
          Effect.gen(function* () {
            const url = yield* resolveUrl(`/repos/${repository.split("/").map(encodeURIComponent).join("/")}/commits`, { per_page: RECENT_COMMITS });
            const response = yield* send(url);
            if (Option.isNone(response)) return [];
            const body = yield* jsonOf(url)(response.value).pipe(Effect.flatMap(decodeBody(CommitsBody, url)));
            return body.map((entry) => ({ title: entry.commit.message.split("\n")[0] ?? "", parents: entry.parents.length }));
          }),
        listMyRepositories: resolveUrl("/user/repos", { sort: "pushed", per_page: PER_PAGE }).pipe(
          Effect.flatMap((url) => collectPages(url, arrayItems)),
          Effect.map(({ items, truncated }) => ({ repositories: items, truncated })),
        ),
        searchOpenPullRequests: (repository, query) =>
          Effect.gen(function* () {
            // 本文まで探すと、待っている PR の話をしている別の PR（Task 自身が追う PR など）にも当たるため、タイトルだけを探す。
            // 数件取る理由: Task 自身が追う PR を除いても残るかを、呼び出し側で確かめるため
            const url = yield* resolveUrl("/search/issues", { q: `repo:${repository} is:pr is:open in:title ${query}`, per_page: "5" });
            const response = yield* send(url);
            if (Option.isNone(response)) return { urls: [] };
            const body = yield* jsonOf(url)(response.value).pipe(Effect.flatMap(decodeBody(SearchCountBody, url)));
            return { urls: body.items.map((item) => item.html_url) };
          }),
        compareCommits: (repository, base, head) =>
          Effect.gen(function* () {
            const repoPath = repository.split("/").map(encodeURIComponent).join("/");
            const url = yield* resolveUrl(`/repos/${repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { per_page: "1" });
            const response = yield* send(url);
            if (Option.isNone(response)) return { status: "not_found" };
            const body = yield* jsonOf(url)(response.value).pipe(Effect.flatMap(decodeBody(CompareBody, url)));
            return { status: body.status };
          }),
        listWorkflowRuns: (repository, workflow) =>
          Effect.gen(function* () {
            const repoPath = repository.split("/").map(encodeURIComponent).join("/");
            const url = yield* resolveUrl(`/repos/${repoPath}/actions/workflows/${encodeURIComponent(workflow)}/runs`, { per_page: "10" });
            const response = yield* send(url);
            if (Option.isNone(response)) return [];
            const body = yield* jsonOf(url)(response.value).pipe(Effect.flatMap(decodeBody(WorkflowRunsBody, url)));
            return body.workflow_runs.map((run) => ({ headSha: run.head_sha, status: run.status, conclusion: run.conclusion, url: run.html_url }));
          }),
        listReviews: (pullApiUrl) =>
          resolveUrl(`${pullApiUrl}/reviews`, { per_page: PER_PAGE }).pipe(
            Effect.flatMap((url) => collectPages(url, arrayItems)),
            Effect.map(({ items }) => items),
          ),
      });
    }),
  );
