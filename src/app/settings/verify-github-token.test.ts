import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { GitHubRequestError } from "../../sources/github/github-adapter.js";
import { gitHubClientStub } from "../../sources/github/test-client.js";
import { tokenExpiryWarning, verifyGitHubToken } from "./verify-github-token.js";

const NOW = "2026-11-25T00:00:00.000Z";
const atNow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    return yield* effect;
  });

const token = (info: { scopes?: string[] | undefined; expiresAt?: string | undefined; login?: string }) =>
  gitHubClientStub({
    inspectToken: Effect.succeed({ viewer: { login: info.login ?? "octocat" }, scopes: info.scopes, expiresAt: info.expiresAt }),
  });

describe("verifyGitHubToken", () => {
  it.effect("必要な権限があれば、持ち主・権限・有効期限を返す", () =>
    atNow(
      Effect.gen(function* () {
        const info = yield* verifyGitHubToken(token({ scopes: ["repo", "read:org"], expiresAt: "2027-02-01T00:00:00.000Z" }));

        assert.deepStrictEqual(info, {
          login: "octocat",
          scopes: ["repo", "read:org"],
          expiresAt: "2027-02-01T00:00:00.000Z",
          missingRecommendedScopes: ["workflow"],
        });
      }),
    ));

  it.effect("workflow の権限がなくても受け付けるが、足りないことを返す（.github/workflows を変える PR を merge できない）", () =>
    atNow(
      Effect.gen(function* () {
        const info = yield* verifyGitHubToken(token({ scopes: ["repo"] }));

        assert.deepStrictEqual(info.missingRecommendedScopes, ["workflow"]);
      }),
    ));

  it.effect("有効期限のないトークンも受け付ける", () =>
    atNow(
      Effect.gen(function* () {
        const info = yield* verifyGitHubToken(token({ scopes: ["repo"] }));

        assert.isUndefined(info.expiresAt);
      }),
    ));

  it.effect("repo の権限がなければ、足りない権限を伝えて保存させない", () =>
    atNow(
      Effect.gen(function* () {
        const error = yield* Effect.flip(verifyGitHubToken(token({ scopes: ["notifications", "public_repo"] })));

        assert.strictEqual(error._tag, "GitHubTokenVerificationError");
        assert.include(error.message, "repo");
      }),
    ));

  it.effect("権限のヘッダーがないトークン（fine-grained token など）は、通知を読めないので受け付けない", () =>
    atNow(
      Effect.gen(function* () {
        const error = yield* Effect.flip(verifyGitHubToken(token({ scopes: undefined })));

        assert.include(error.message, "classic token");
      }),
    ));

  it.effect("有効期限を過ぎていたら受け付けない", () =>
    atNow(
      Effect.gen(function* () {
        const error = yield* Effect.flip(verifyGitHubToken(token({ scopes: ["repo"], expiresAt: "2026-11-24T00:00:00.000Z" })));

        assert.include(error.message, "有効期限");
      }),
    ));

  it.effect("トークンが無効（401）なら、無効だと伝える", () =>
    atNow(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          verifyGitHubToken(gitHubClientStub({ inspectToken: Effect.fail(new GitHubRequestError({ message: "401", status: 401 })) })),
        );

        assert.include(error.message, "トークンが無効");
      }),
    ));
});

describe("tokenExpiryWarning", () => {
  const now = DateTime.makeUnsafe(NOW);

  it("期限まで 14 日以内なら、残りの日数を返す", () => {
    assert.deepStrictEqual(tokenExpiryWarning("2026-12-05T00:00:00.000Z", now), { daysLeft: 10 });
  });

  it("期限を過ぎていたら、残り 0 日として返す", () => {
    assert.deepStrictEqual(tokenExpiryWarning("2026-11-20T00:00:00.000Z", now), { daysLeft: 0 });
  });

  it("期限まで 14 日より先、または期限がなければ警告しない", () => {
    assert.isUndefined(tokenExpiryWarning("2026-12-20T00:00:00.000Z", now));
    assert.isUndefined(tokenExpiryWarning(undefined, now));
  });
});
