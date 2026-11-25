import { DateTime, Effect, Schema } from "effect";
import type { GitHubClient, GitHubClientError } from "../../sources/github/github-adapter.js";

export class GitHubTokenVerificationError extends Schema.TaggedError<GitHubTokenVerificationError>()(
  "GitHubTokenVerificationError",
  { message: Schema.String },
) {}

/**
 * このアプリが使う classic token の scope。repo があれば通知と private リポジトリの PR・check run・レビューを読める。
 * notifications + public_repo で足りるとしない理由: 仕事の通知の多くは private リポジトリのもので、詳細を読めないと判定できないため。
 */
export const REQUIRED_GITHUB_SCOPES = ["repo"] as const;

/**
 * なくても同期はできるが、あると便利な scope。workflow がないと、.github/workflows を変える PR
 * （GitHub Actions の更新など、依存更新の PR に多い）を merge できない。
 */
export const RECOMMENDED_GITHUB_SCOPES = ["workflow"] as const;

export const missingRecommendedScopes = (scopes: ReadonlyArray<string>) => RECOMMENDED_GITHUB_SCOPES.filter((scope) => !scopes.includes(scope));

/** 期限がこの日数より近づいたら、新しいトークンを入れるよう警告する */
export const TOKEN_EXPIRY_WARNING_DAYS = 14;

export type GitHubTokenInfo = { login: string; scopes: string[]; expiresAt: string | undefined; missingRecommendedScopes: string[] };

const Viewer = Schema.Struct({ login: Schema.String });
const DAY_MILLIS = 24 * 60 * 60 * 1000;

export function tokenExpiryWarning(expiresAt: string | undefined, now: DateTime.Utc): { daysLeft: number } | undefined {
  if (expiresAt === undefined) return undefined;
  const millisLeft = Date.parse(expiresAt) - DateTime.toEpochMillis(now);
  if (millisLeft > TOKEN_EXPIRY_WARNING_DAYS * DAY_MILLIS) return undefined;
  return { daysLeft: Math.max(0, Math.floor(millisLeft / DAY_MILLIS)) };
}

const describeFailure = (error: GitHubClientError) => {
  if (error._tag === "GitHubRateLimitedError") return `GitHub のレート制限中のため確かめられない（${error.resetAt} に解除）`;
  if (error.status === 401) return "トークンが無効（期限切れか、取り消された）";
  return `GitHub に確かめられない: ${error.message}`;
};

/** 保存する前に、同期に使えるトークンか（持ち主・権限・有効期限）を確かめる */
export const verifyGitHubToken = Effect.fnUntraced(function* (client: GitHubClient["Service"]) {
  const fail = (message: string) => new GitHubTokenVerificationError({ message });

  const inspected = yield* client.inspectToken.pipe(Effect.mapError((error) => fail(describeFailure(error))));
  const { login } = yield* Schema.decodeUnknownEffect(Viewer)(inspected.viewer).pipe(
    Effect.mapError(() => fail("GitHub の応答からアカウント名を読めない")),
  );

  if (inspected.scopes === undefined) {
    return yield* fail("このトークンでは通知を読めない（fine-grained token など）。repo の権限を付けた classic token を使ってください");
  }
  const missing = REQUIRED_GITHUB_SCOPES.filter((scope) => !inspected.scopes?.includes(scope));
  if (missing.length > 0) {
    return yield* fail(`権限が足りない: ${missing.join(", ")}。通知と private リポジトリの PR を読むために必要です`);
  }

  const now = yield* DateTime.now;
  if (inspected.expiresAt !== undefined && Date.parse(inspected.expiresAt) <= DateTime.toEpochMillis(now)) {
    return yield* fail(`有効期限（${inspected.expiresAt}）を過ぎている`);
  }

  return {
    login,
    scopes: inspected.scopes,
    expiresAt: inspected.expiresAt,
    missingRecommendedScopes: missingRecommendedScopes(inspected.scopes),
  } satisfies GitHubTokenInfo;
});
