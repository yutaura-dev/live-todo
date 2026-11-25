import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { Database } from "../db/database.js";
import { sourceItems } from "../db/schema.js";

const StoredJudgment = Schema.Struct({ request: Schema.Struct({ input: Schema.String }) });
const decodeJudgment = Schema.decodeUnknownOption(StoredJudgment);
// github-binding の describeGitHubItem が書く行（"作成者: @login"）
const AUTHOR_LINE = /^作成者: @(\S+)$/m;

/**
 * 作成者の列を足す前に保存した項目に、判定のときに LLM に渡した入力から作成者を埋める。
 * 埋めないと、既存の依存更新 PR は通知が次に更新されるまで自動の調査の対象にならないため。
 */
export const backfillAuthorsFromJudgments = Effect.gen(function* () {
  const db = yield* Database;
  const rows = yield* db
    .select({ id: sourceItems.id, judgment: sourceItems.judgment })
    .from(sourceItems)
    .where(and(isNull(sourceItems.author), isNotNull(sourceItems.judgment)))
    .pipe(Effect.orDie);
  let filled = 0;
  for (const row of rows) {
    const author = Option.flatMap(decodeJudgment(row.judgment), (judgment) => Option.fromNullishOr(AUTHOR_LINE.exec(judgment.request.input)?.[1]));
    if (Option.isNone(author)) continue;
    yield* db.update(sourceItems).set({ author: author.value }).where(eq(sourceItems.id, row.id)).pipe(Effect.orDie);
    filled++;
  }
  return filled;
});
