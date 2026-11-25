import { and, eq, inArray } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { Database } from "../core/db/database.js";
import { sourceItems, taskLinks, tasks } from "../core/db/schema.js";
import { applyItemState } from "../core/sync/sync-source.js";
import type { GitHubClient } from "../sources/github/github-adapter.js";

const UNFINISHED_STATUSES = ["needs_review", "todo", "in_progress", "agent_running"] as const;
// 通知の項目の externalId は、PR・issue の API の URL（CI の通知などは github:thread:… で、状態を取れない）
const API_URL_PREFIX = "https://api.github.com/repos/";

const SubjectState = Schema.Struct({ state: Schema.String, merged: Schema.optional(Schema.NullOr(Schema.Boolean)) });

/**
 * 終わっていない Task が追っている、このアカウントの開いた項目の状態を読み直す。
 * GitHub は自分の操作を自分に通知しないので、自分で merge した PR は通知の同期だけでは open のまま残るため。
 * 状態が変わった項目の数を返す。
 */
export const refreshTrackedItems = (accountId: string, client: GitHubClient["Service"]) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const source = `github:${accountId}`;
    const rows = yield* db
      .selectDistinct({ externalId: sourceItems.externalId })
      .from(taskLinks)
      .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(
        and(
          eq(taskLinks.role, "tracks"),
          eq(sourceItems.source, source),
          eq(sourceItems.state, "open"),
          inArray(tasks.status, [...UNFINISHED_STATUSES]),
        ),
      )
      .pipe(Effect.orDie);

    let changed = 0;
    for (const { externalId } of rows) {
      if (!externalId.startsWith(API_URL_PREFIX)) continue;
      const state = yield* client.getSubject(externalId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed("removed" as const),
            onSome: (raw) =>
              Schema.decodeUnknownEffect(SubjectState)(raw).pipe(
                Effect.map((subject) => (subject.merged === true || subject.state === "closed" ? ("resolved" as const) : ("open" as const))),
              ),
          }),
        ),
        Effect.map(Option.some),
        // レート制限は止めて休ませる（ジョブの backoff に任せる）。それ以外の 1 件の失敗は飛ばして、ほかを読み直す
        Effect.catchIf(
          (error) => !(typeof error === "object" && error !== null && "_tag" in error && error._tag === "GitHubRateLimitedError"),
          (error) =>
            Effect.logWarning("項目の状態を読み直せない").pipe(
              Effect.annotateLogs({ externalId, reason: error instanceof Error ? error.message : String(error) }),
              Effect.as(Option.none<"open" | "resolved" | "removed">()),
            ),
        ),
      );
      if (Option.isNone(state)) continue;
      if (yield* applyItemState(source, externalId, state.value)) changed++;
    }
    return changed;
  });
