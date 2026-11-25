import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Database } from "../core/db/database.js";
import { sourceItems, taskLinks, tasks } from "../core/db/schema.js";
import { TaskRepository } from "../core/task/task-repository.js";
import type { TaskStatus } from "../core/task/task.js";
import { githubSourceName } from "../sources/github/github-binding.js";
import { parseGitHubTarget } from "../sources/github/repository-filter-preview.js";
import { makeRepositoryFilter, type RepositoryFilterConfig } from "../sources/github/repository-filter.js";

// 完了した Task は履歴として残す。片付けるのは、まだ手を付ける可能性があるものだけ
const OPEN_STATUSES: ReadonlyArray<TaskStatus> = ["needs_review", "todo", "in_progress"];

/**
 * フィルタで除外したリポジトリの項目だけを追っている Task を片付ける（dismissed にする）。
 * フィルタは新しく届く通知にしか効かないので、除外する前に作られた Task はこれで消す。
 * ユーザーの判断ではないので actor は filter にし、判定の正解には使わない。
 */
export const dismissTasksOutsideFilter = Effect.fnUntraced(function* (accountId: string, filter: RepositoryFilterConfig) {
  if ((filter.include ?? []).length === 0 && (filter.exclude ?? []).length === 0) return 0;
  const isTarget = yield* makeRepositoryFilter(filter);
  const db = yield* Database;
  const taskRepository = yield* TaskRepository;

  const sources = [githubSourceName(accountId), `${githubSourceName(accountId)}:watch`];
  const rows = yield* db
    .select({ taskId: tasks.id, status: tasks.status, source: sourceItems.source, url: sourceItems.url })
    .from(taskLinks)
    .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(and(eq(taskLinks.role, "tracks"), inArray(tasks.status, [...OPEN_STATUSES])))
    .pipe(Effect.orDie);

  const byTask = new Map<number, { status: TaskStatus; keep: boolean; ofAccount: boolean }>();
  for (const row of rows) {
    const entry = byTask.get(row.taskId) ?? { status: row.status, keep: false, ofAccount: false };
    const repository = parseGitHubTarget(row.url)?.repository;
    if (!sources.includes(row.source) || repository === undefined || isTarget(repository)) entry.keep = true;
    else entry.ofAccount = true;
    byTask.set(row.taskId, entry);
  }

  let dismissed = 0;
  for (const [taskId, entry] of byTask) {
    if (entry.keep || !entry.ofAccount) continue;
    yield* taskRepository.updateTask(taskId, { status: "dismissed" });
    yield* taskRepository.recordChange(taskId, {
      kind: "field_changed",
      field: "status",
      before: entry.status,
      after: "dismissed",
      unread: false,
      actor: "filter",
    });
    dismissed++;
  }
  return dismissed;
});
