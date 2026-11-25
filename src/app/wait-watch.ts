import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { Cause, Effect, Option, Schema } from "effect";
import { Database } from "../core/db/database.js";
import { sourceItems, taskLinks, tasks } from "../core/db/schema.js";
import { type ActionStep, completeStep, currentSteps, decodePlan, type WaitCondition } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { GitHubClient } from "../sources/github/github-adapter.js";

// 待ちは Todo か進行中の Task にしかない（要確認・完了などは見ない）
const WATCHED_STATUSES = ["todo", "in_progress"] as const;

const PullBody = Schema.Struct({ merged: Schema.Boolean });
const ReviewsBody = Schema.Array(Schema.Struct({ submitted_at: Schema.optional(Schema.NullOr(Schema.String)) }));

const pullApiUrl = (pullUrl: string) => {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(pullUrl);
  return match === null ? undefined : `https://api.github.com/repos/${match[1]}/${match[2]}/pulls/${match[3]}`;
};

/** 条件が成り立っていれば、何が起きたかの説明を返す */
const satisfied = (client: GitHubClient["Service"], until: WaitCondition, ownUrls: ReadonlySet<string>) =>
  Effect.gen(function* () {
    switch (until.kind) {
      case "pull_request_opened": {
        // Task 自身が追う PR は、待っている PR ではない（待つ理由の PR がタイトルに同じ語を含むことがある）
        const found = (yield* client.searchOpenPullRequests(until.repository, until.query)).urls.filter((url) => !ownUrls.has(url));
        return found.length > 0 ? Option.some(`PR が出た: ${found[0]}`) : Option.none<string>();
      }
      case "review_submitted": {
        const api = pullApiUrl(until.pullUrl);
        if (api === undefined) return Option.none<string>();
        const reviews = yield* Schema.decodeUnknownEffect(ReviewsBody)(yield* client.listReviews(api));
        const since = until.since === undefined ? 0 : Date.parse(until.since);
        const fresh = reviews.some((review) => typeof review.submitted_at === "string" && Date.parse(review.submitted_at) > since);
        return fresh ? Option.some(`レビューが付いた: ${until.pullUrl}`) : Option.none<string>();
      }
      case "merged": {
        const api = pullApiUrl(until.pullUrl);
        if (api === undefined) return Option.none<string>();
        const pull = yield* client.getPullRequest(api);
        if (Option.isNone(pull)) return Option.none<string>();
        const body = yield* Schema.decodeUnknownEffect(PullBody)(pull.value);
        return body.merged ? Option.some(`merge された: ${until.pullUrl}`) : Option.none<string>();
      }
    }
  });

/**
 * いま着手できる待つ手順のうち、何を待つかが分かっているものを GitHub で確かめ、成り立っていれば済ませる。
 * このアカウントの項目だけを追う Task に限る（会社のトークンで私用の PR を見に行かないため）。済ませた数を返す。
 */
export const checkWaitConditions = (accountId: string, client: GitHubClient["Service"]) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const taskRepository = yield* TaskRepository;
    const ownSources = [`github:${accountId}`, `github:${accountId}:watch`];
    const rows = yield* db
      .select({ taskId: tasks.id, source: sourceItems.source, url: sourceItems.url })
      .from(taskLinks)
      .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(and(eq(taskLinks.role, "tracks"), isNotNull(tasks.nextActions), inArray(tasks.status, [...WATCHED_STATUSES])))
      .pipe(Effect.orDie);
    const ownTasks = new Map<number, boolean>();
    const trackedUrls = new Map<number, Set<string>>();
    for (const row of rows) {
      ownTasks.set(row.taskId, (ownTasks.get(row.taskId) ?? true) && ownSources.includes(row.source));
      trackedUrls.set(row.taskId, (trackedUrls.get(row.taskId) ?? new Set()).add(row.url));
    }

    let completed = 0;
    for (const [taskId, own] of ownTasks) {
      if (!own) continue;
      const task = Option.getOrUndefined(yield* taskRepository.findTask(taskId));
      const plan = task === undefined ? Option.none() : decodePlan(task.nextActions);
      if (Option.isNone(plan)) continue;
      const waits = currentSteps(plan.value).filter((step): step is ActionStep & { until: WaitCondition } => step.kind === "wait" && "until" in step && step.until !== undefined);
      let next = plan.value;
      const reasons: string[] = [];
      for (const step of waits) {
        // 1 件を確かめられなくても（PR が消えた・応答の形が違うなど）、ほかの Task は確かめる
        const outcome = yield* satisfied(client, step.until, trackedUrls.get(taskId) ?? new Set()).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("待つ条件を確かめられない").pipe(
              Effect.annotateLogs({ taskId, kind: step.until.kind, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<string>()),
            ),
          ),
        );
        if (Option.isNone(outcome)) continue;
        next = completeStep(next, step.id);
        reasons.push(`${step.title}（${outcome.value}）`);
      }
      if (reasons.length === 0) continue;
      yield* taskRepository.updateTask(taskId, { nextActions: next });
      yield* taskRepository.recordChange(taskId, {
        kind: "field_changed",
        field: "next_actions",
        before: null,
        after: `待ち終わった: ${reasons.join(" / ")}`,
        unread: true,
        actor: "sync",
      });
      completed += reasons.length;
    }
    return completed;
  });
