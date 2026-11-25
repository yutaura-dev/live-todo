import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestDatabase } from "../core/db/test-database.js";
import { SourceItemRepository } from "../core/source/source-item-repository.js";
import { gitHubClientStub } from "../sources/github/test-client.js";
import { backfillGitHubPullAuthors } from "./github-author-backfill.js";

const pull = (source: string, number: number, options: { author?: string; state?: "open" | "resolved"; url?: string } = {}) =>
  Effect.gen(function* () {
    const url = options.url ?? `https://github.com/acme/app/pull/${number}`;
    yield* (yield* SourceItemRepository).upsertItem({
      source,
      externalId: url,
      title: url,
      url,
      state: options.state ?? "open",
      fingerprint: "v1",
      ...(options.author === undefined ? {} : { author: options.author }),
    });
    return url;
  });

const authorOf = (source: string, externalId: string) =>
  Effect.gen(function* () {
    return Option.getOrThrow(yield* (yield* SourceItemRepository).findItem(source, externalId)).author;
  });

describe("backfillGitHubPullAuthors", () => {
  it.effect("作成者が空の開いている PR だけ、GitHub に作成者を問い合わせて埋める", () =>
    Effect.gen(function* () {
      const target = yield* pull("github:personal", 1);
      yield* pull("github:personal", 2, { author: "octocat" });
      yield* pull("github:personal", 3, { state: "resolved" });
      yield* pull("github:personal", 4, { url: "https://github.com/acme/app/issues/4" });
      yield* pull("github:work", 5);
      const asked: string[] = [];
      const client = gitHubClientStub({
        getPullRequest: (apiUrl) => {
          asked.push(apiUrl);
          return Effect.succeed(Option.some({ user: { login: "renovate[bot]" } }));
        },
      });

      const filled = yield* backfillGitHubPullAuthors("personal", client);

      assert.strictEqual(filled, 1);
      assert.deepStrictEqual(asked, ["https://api.github.com/repos/acme/app/pulls/1"]);
      assert.strictEqual(yield* authorOf("github:personal", target), "renovate[bot]");
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("PR が見つからない・作成者が読めないときは空のままにして、ほかの PR は続ける", () =>
    Effect.gen(function* () {
      const missing = yield* pull("github:personal", 1);
      const found = yield* pull("github:personal", 2);
      const client = gitHubClientStub({
        getPullRequest: (apiUrl) =>
          Effect.succeed(apiUrl.endsWith("/1") ? Option.none() : Option.some({ user: { login: "dependabot[bot]" } })),
      });

      assert.strictEqual(yield* backfillGitHubPullAuthors("personal", client), 1);
      assert.isNull(yield* authorOf("github:personal", missing));
      assert.strictEqual(yield* authorOf("github:personal", found), "dependabot[bot]");
    }).pipe(Effect.provide(TestDatabase)));
});
