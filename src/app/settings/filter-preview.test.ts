import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestDatabase } from "../../core/db/test-database.js";
import { SourceItemRepository } from "../../core/source/source-item-repository.js";
import { GitHubRequestError } from "../../sources/github/github-adapter.js";
import { previewAccountFilter } from "./filter-preview.js";

const itemFrom = (source: string, url: string) =>
  Effect.gen(function* () {
    yield* (yield* SourceItemRepository).upsertItem({ source, externalId: url, title: url, url, state: "open", fingerprint: "v1" });
  });

const remote = (names: string[], truncated = false) => Effect.succeed({ repositories: names.map((full_name) => ({ full_name })), truncated });

describe("previewAccountFilter", () => {
  it.effect("GitHub の一覧と、そのアカウントで既に届いた項目のリポジトリを合わせて、含めるものと除くものに分ける", () =>
    Effect.gen(function* () {
      yield* itemFrom("github:work", "https://github.com/acme/legacy/issues/1");
      yield* itemFrom("github:work:watch", "https://github.com/acme/watched/pull/2");
      yield* itemFrom("github:personal", "https://github.com/me/hobby/pull/3");

      const preview = yield* previewAccountFilter({
        accountId: "work",
        filter: { include: ["acme/*"], exclude: ["acme/legacy"] },
        targets: [],
        listRemote: remote(["acme/app", "other/tool"]),
      });

      assert.deepStrictEqual(preview.included.map((entry) => entry.repository), ["acme/app", "acme/watched"]);
      assert.deepStrictEqual(preview.excluded.map((entry) => entry.repository), ["acme/legacy", "other/tool"]);
      assert.deepStrictEqual(preview.remote, { status: "loaded", truncated: false });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("入力された PR や issue の URL を、含まれるかどうかと理由つきで判定する", () =>
    Effect.gen(function* () {
      const preview = yield* previewAccountFilter({
        accountId: "work",
        filter: { include: ["acme/*"], exclude: ["acme/legacy"] },
        targets: ["https://github.com/acme/legacy/pull/9", "acme/app#3", "よくわからない"],
        listRemote: remote([]),
      });

      assert.deepStrictEqual(preview.targets, [
        {
          input: "https://github.com/acme/legacy/pull/9",
          target: { repository: "acme/legacy", kind: "pull", number: 9 },
          decision: { included: false, reason: { kind: "excluded_by", pattern: "acme/legacy" } },
        },
        {
          input: "acme/app#3",
          target: { repository: "acme/app", kind: "number", number: 3 },
          decision: { included: true, reason: { kind: "included_by", pattern: "acme/*" } },
        },
        { input: "よくわからない" },
      ]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("GitHub から一覧を取れなくても、手元の項目だけでプレビューし、取れなかった理由を返す", () =>
    Effect.gen(function* () {
      yield* itemFrom("github:work", "https://github.com/acme/app/issues/1");

      const preview = yield* previewAccountFilter({
        accountId: "work",
        filter: {},
        targets: [],
        listRemote: Effect.fail(new GitHubRequestError({ message: "GitHub API が 401 を返した", status: 401 })),
      });

      assert.deepStrictEqual(preview.included.map((entry) => entry.repository), ["acme/app"]);
      assert.deepStrictEqual(preview.remote, { status: "failed", message: "GitHub API が 401 を返した" });
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("フィルタのパターンが不正なら、プレビューせずにエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        previewAccountFilter({ accountId: "work", filter: { include: ["acme"] }, targets: [], listRemote: remote([]) }),
      );

      assert.strictEqual(error._tag, "InvalidRepositoryPatternError");
    }).pipe(Effect.provide(TestDatabase)));
});
