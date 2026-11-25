import { and, eq, inArray, isNull, like } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { Database } from "../core/db/database.js";
import { sourceItems } from "../core/db/schema.js";
import type { GitHubClient } from "../sources/github/github-adapter.js";
import { githubSourceName } from "../sources/github/github-binding.js";

const PullAuthor = Schema.Struct({ user: Schema.NullOr(Schema.Struct({ login: Schema.String })) });
const decodePullAuthor = Schema.decodeUnknownOption(PullAuthor);
const PULL_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;
// 1 回で問い合わせる上限。API の残り回数を使いすぎないため（残りは次の回に回す）
const MAX_PER_RUN = 100;

/**
 * 作成者が空の開いている PR に、GitHub へ問い合わせて作成者を埋める。
 * 作成者の列を足す前に保存した項目は、通知が次に更新されるまで空のままで、
 * 依存更新の bot の PR として自動で調べる対象にならないため。
 */
export const backfillGitHubPullAuthors = Effect.fnUntraced(function* (accountId: string, client: GitHubClient["Service"]) {
  const db = yield* Database;
  const rows = yield* db
    .select({ id: sourceItems.id, url: sourceItems.url })
    .from(sourceItems)
    .where(
      and(
        inArray(sourceItems.source, [githubSourceName(accountId), `${githubSourceName(accountId)}:watch`]),
        eq(sourceItems.state, "open"),
        isNull(sourceItems.author),
        like(sourceItems.url, "%/pull/%"),
      ),
    )
    .limit(MAX_PER_RUN)
    .pipe(Effect.orDie);

  let filled = 0;
  for (const row of rows) {
    const match = PULL_URL.exec(row.url);
    if (match === null) continue;
    const apiUrl = `https://api.github.com/repos/${match[1]}/${match[2]}/pulls/${match[3]}`;
    const pull = yield* client.getPullRequest(apiUrl);
    const login = Option.flatMap(Option.flatMap(pull, decodePullAuthor), (decoded) => Option.fromNullishOr(decoded.user?.login));
    if (Option.isNone(login)) continue;
    yield* db.update(sourceItems).set({ author: login.value }).where(eq(sourceItems.id, row.id)).pipe(Effect.orDie);
    filled++;
  }
  return filled;
});
