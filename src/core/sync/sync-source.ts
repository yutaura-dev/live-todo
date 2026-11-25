import { Effect, Option, Schema } from "effect";
import type { TodoJudgment, TodoVerdict } from "../judge/todo-judge.js";
import type { Task, TaskChangeInput, TaskPatch, TaskStatus } from "../task/task.js";
import { TaskRepository } from "../task/task-repository.js";
import type { SourceAdapter } from "./source-adapter.js";
import type { SourceChange } from "./source-change.js";

export type TaskDraft = {
  title: string;
  url: string;
  /** 内容の変化を検知するための値。変わると更新マークが付く */
  fingerprint: string;
  /** 元のツール側で解決済み（マージ・クローズなど）か */
  resolved: boolean;
};

export type SourceBinding<TItem, TCursor, EA, EJ, RJ> = {
  source: string;
  adapter: SourceAdapter<TItem, TCursor, EA>;
  cursorSchema: Schema.Decoder<TCursor>;
  externalIdOf: (item: TItem) => string;
  toDraft: (item: TItem) => TaskDraft;
  judge: (item: TItem) => Effect.Effect<TodoJudgment, EJ, RJ>;
};

export type SyncSummary = {
  created: number;
  updated: number;
  resolved: number;
  reopened: number;
  archived: number;
};

const STATUS_ON_CREATE = {
  todo: "todo",
  needs_review: "needs_review",
  not_todo: "dismissed",
} as const satisfies Record<TodoVerdict, TaskStatus>;

const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set(["todo", "in_progress", "needs_review"]);
const CLOSED_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "archived"]);

const JUDGE_CONCURRENCY = 4;

export const syncSource = Effect.fnUntraced(function* <TItem, TCursor, EA, EJ, RJ>(
  binding: SourceBinding<TItem, TCursor, EA, EJ, RJ>,
): Effect.fn.Return<SyncSummary, EA | EJ, TaskRepository | RJ> {
  const repo = yield* TaskRepository;

  const stored = yield* repo.loadCursor(binding.source);
  const cursor = Option.flatMap(stored, Schema.decodeUnknownOption(binding.cursorSchema));
  if (Option.isSome(stored) && Option.isNone(cursor)) {
    yield* Effect.logWarning("保存されたカーソルを読めないため、カーソルなしで取得し直す").pipe(
      Effect.annotateLogs({ source: binding.source }),
    );
  }

  // 取得と判定をトランザクションの外で行う理由: SQLite の書き込みロックは DB 全体にかかるため、
  // ネットワークの応答を待つ間 UI 側の書き込み（既読・カードの移動）まで止めてしまう。
  // 先に済ませても、失敗した時点ではまだ何も書いていないので原子性は保たれる。
  const { changes, nextCursor } = yield* binding.adapter.fetchChanges(Option.getOrNull(cursor));
  const judgments = yield* judgeNewItems(binding, changes);

  return yield* repo.withTransaction(
    Effect.gen(function* () {
      const summary: SyncSummary = { created: 0, updated: 0, resolved: 0, reopened: 0, archived: 0 };
      for (const change of changes) {
        yield* applyChange(repo, binding, change, judgments, summary);
      }
      yield* repo.saveCursor(binding.source, nextCursor);
      return summary;
    }),
  );
});

const judgeNewItems = Effect.fnUntraced(function* <TItem, TCursor, EA, EJ, RJ>(
  binding: SourceBinding<TItem, TCursor, EA, EJ, RJ>,
  changes: readonly SourceChange<TItem>[],
): Effect.fn.Return<Map<string, TodoJudgment>, EJ, TaskRepository | RJ> {
  const repo = yield* TaskRepository;
  const candidates: TItem[] = [];
  for (const change of changes) {
    if (change.kind !== "upserted" || binding.toDraft(change.item).resolved) continue;
    const existing = yield* repo.findBySource(binding.source, binding.externalIdOf(change.item));
    if (Option.isNone(existing)) candidates.push(change.item);
  }

  const judged = yield* Effect.forEach(
    candidates,
    (item) => binding.judge(item).pipe(Effect.map((judgment) => [binding.externalIdOf(item), judgment] as const)),
    { concurrency: JUDGE_CONCURRENCY },
  );
  return new Map(judged);
});

const applyChange = Effect.fnUntraced(function* <TItem, TCursor, EA, EJ, RJ>(
  repo: TaskRepository["Service"],
  binding: SourceBinding<TItem, TCursor, EA, EJ, RJ>,
  change: SourceChange<TItem>,
  judgments: ReadonlyMap<string, TodoJudgment>,
  summary: SyncSummary,
) {
  if (change.kind === "removed") {
    const existing = yield* repo.findBySource(binding.source, change.externalId);
    if (Option.isNone(existing) || existing.value.status === "archived") return;
    yield* repo.update(existing.value.id, { status: "archived" });
    if (existing.value.status !== "dismissed") {
      yield* repo.recordChange(existing.value.id, { kind: "source_removed", unread: true });
    }
    summary.archived++;
    return;
  }

  const externalId = binding.externalIdOf(change.item);
  const draft = binding.toDraft(change.item);
  const existing = yield* repo.findBySource(binding.source, externalId);

  if (Option.isNone(existing)) {
    const judgment = judgments.get(externalId);
    if (draft.resolved || judgment === undefined) return;
    const task = yield* repo.insert({
      source: binding.source,
      externalId,
      title: draft.title,
      url: draft.url,
      fingerprint: draft.fingerprint,
      status: STATUS_ON_CREATE[judgment.verdict],
    });
    yield* repo.recordChange(task.id, { kind: "created", detail: { judgment }, unread: false });
    summary.created++;
    return;
  }

  yield* applyUpdate(repo, existing.value, draft, summary);
});

const applyUpdate = Effect.fnUntraced(function* (
  repo: TaskRepository["Service"],
  task: Task,
  draft: TaskDraft,
  summary: SyncSummary,
) {
  let patch: TaskPatch = {};
  const records: TaskChangeInput[] = [];
  // 対象外（dismissed）の Task に更新マークを付けない理由: ユーザーが見ないと決めたものなので、
  // 内容だけ最新にしておき、通知のように目に入る形にはしない。
  const silent = task.status === "dismissed";

  if (draft.fingerprint !== task.fingerprint) {
    patch = { ...patch, title: draft.title, url: draft.url, fingerprint: draft.fingerprint };
    if (!silent) records.push({ kind: "content_updated", unread: true });
    summary.updated++;
  }

  const next = nextStatus(task.status, draft.resolved);
  if (next !== task.status) {
    patch = { ...patch, status: next };
    records.push({ kind: "status_changed", detail: { from: task.status, to: next }, unread: true });
    if (next === "done") summary.resolved++;
    else summary.reopened++;
  }

  if (Object.keys(patch).length === 0) return;
  yield* repo.update(task.id, patch);
  for (const record of records) {
    yield* repo.recordChange(task.id, record);
  }
});

function nextStatus(current: TaskStatus, resolved: boolean): TaskStatus {
  if (resolved && OPEN_STATUSES.has(current)) return "done";
  if (!resolved && CLOSED_STATUSES.has(current)) return "todo";
  return current;
}
