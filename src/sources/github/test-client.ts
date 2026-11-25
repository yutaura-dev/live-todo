import { Effect, Option } from "effect";
import { GitHubClient } from "./github-adapter.js";

/** テスト用の GitHubClient。指定しなかったメソッドは空の応答を返す */
export const gitHubClientStub = (overrides: Partial<GitHubClient["Service"]> = {}): GitHubClient["Service"] =>
  GitHubClient.of({
    listNotifications: () => Effect.succeed({ notifications: [], truncated: false }),
    getSubject: () => Effect.succeed(Option.none()),
    searchMyOpenPullRequests: Effect.succeed<unknown>({ items: [] }),
    getPullRequest: () => Effect.succeed(Option.none()),
    listCheckRuns: () => Effect.succeed<unknown>({ check_runs: [] }),
    listReviews: () => Effect.succeed<unknown>([]),
    ...overrides,
  });
