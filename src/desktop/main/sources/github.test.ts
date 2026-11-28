import { assert, describe, it } from "@effect/vitest";
import type { GitHubItem } from "../../../sources/github/github-adapter.js";
import { githubObserved } from "./github.js";

const item: GitHubItem = {
  externalId: "https://api.github.com/repos/acme/app/pulls/42",
  reason: "review_requested",
  subjectType: "PullRequest",
  title: "Fix login",
  repository: "acme/app",
  htmlUrl: "https://github.com/acme/app/pull/42",
  state: "open",
  updatedAt: "2026-11-28T00:00:00Z",
  author: "alice",
  bodyExcerpt: "見てください",
  requestedReviewers: ["me"],
  requestedTeams: [],
};
const viewer = { login: "me", teams: [] as string[] };

describe("GitHub の通知を、Source を知らない事実の形にする", () => {
  it("uri はアカウントの origin に、PR のパスを続けたもの", () => {
    const observed = githubObserved(item, "github://me@github.com", viewer);
    assert.deepStrictEqual({ uri: observed.uri, url: observed.url, externalId: observed.externalId, stream: observed.stream }, {
      uri: "github://me@github.com/acme/app/pull/42",
      url: "https://github.com/acme/app/pull/42",
      externalId: "https://api.github.com/repos/acme/app/pulls/42",
      stream: "通知",
    });
  });

  it("アプリが書く行は、値がなくても書き、状態は Source の言葉で書く。本文は外の人の文として分ける", () => {
    const observed = githubObserved(item, "github://me@github.com", viewer);
    assert.deepStrictEqual(observed.snapshot.fact, {
      trusted: [
        { key: "種類", value: "PullRequest" },
        { key: "状態", value: "開いている" },
        { key: "通知の理由", value: "レビューを頼まれた" },
        { key: "リポジトリ", value: "acme/app" },
        { key: "あなたへのレビュー依頼", value: "あり" },
      ],
      body: "見てください",
    });
    assert.strictEqual(observed.snapshot.author, "alice");
  });

  it("所属するチームへのレビュー依頼も、あなたへのレビュー依頼として書く", () => {
    const observed = githubObserved({ ...item, requestedReviewers: [], requestedTeams: ["acme/web"] }, "github://me@github.com", { login: "me", teams: ["acme/web"] });
    assert.deepStrictEqual(observed.snapshot.fact.trusted.at(-1), { key: "あなたへのレビュー依頼", value: "あり（チーム acme/web）" });
  });

  it("マージされた PR は、マージ済みと書く", () => {
    assert.deepStrictEqual(githubObserved({ ...item, state: "merged", requestedReviewers: [] }, "github://me@github.com", viewer).snapshot.fact.trusted.slice(1, 2), [{ key: "状態", value: "マージ済み" }]);
  });
});
