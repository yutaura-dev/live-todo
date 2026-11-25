import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { withTransaction } from "../db/database.js";
import type { TodoJudgment, TodoVerdict } from "../judge/todo-judge.js";
import { detectActivities } from "../source/activities.js";
import type { ActivityKind, ItemState } from "../source/source-item.js";
import { type SourceItem, SourceItemRepository } from "../source/source-item-repository.js";
import { deriveTaskStatus } from "../task/task-status.js";
import type { TaskStatus } from "../task/task.js";
import { TaskRepository } from "../task/task-repository.js";
import type { SourceAdapter } from "./source-adapter.js";
import type { SourceChange } from "./source-change.js";

export type ItemDraft = {
  title: string;
  url: string;
  state: Exclude<ItemState, "removed">;
  /** Source Item の内容の変化を検知するための値。変わると Activity（changed）になる */
  fingerprint: string;
};

export type SourceBinding<TItem, TCursor, EA, EJ, RJ> = {
  source: string;
  adapter: SourceAdapter<TItem, TCursor, EA>;
  cursorSchema: Schema.Decoder<TCursor>;
  externalIdOf: (item: TItem) => string;
  toItemDraft: (item: TItem) => ItemDraft;
  judge: (item: TItem) => Effect.Effect<TodoJudgment, EJ, RJ>;
};

export type SyncSummary = {
  activities: number;
  tasksCreated: number;
  tasksUpdated: number;
  itemsIgnored: number;
};

// not_todo も要確認の Task にする理由: 判定の当たり具合を確かめる前に黙って隠すと、自分の todo を取りこぼしても
// 気づけない。使いながらユーザーが dismissed にした操作を正解として集め、閾値を決めてから隠すようにする。
const STATUS_ON_CREATE = {
  todo: "todo",
  needs_review: "needs_review",
  not_todo: "needs_review",
} as const satisfies Record<TodoVerdict, TaskStatus>;

const STATUS_AFFECTING_ACTIVITIES: ReadonlySet<ActivityKind> = new Set(["resolved", "reopened", "removed"]);

const JUDGE_CONCURRENCY = 4;

type Dependencies = SourceItemRepository | TaskRepository | SqlClient.SqlClient;

export const syncSource = Effect.fnUntraced(function* <TItem, TCursor, EA, EJ, RJ>(
  binding: SourceBinding<TItem, TCursor, EA, EJ, RJ>,
): Effect.fn.Return<SyncSummary, EA | EJ, Dependencies | RJ> {
  const items = yield* SourceItemRepository;

  const stored = yield* items.loadCursor(binding.source);
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
  const judgments = yield* judgeItemsNeedingTriage(binding, changes);

  return yield* withTransaction(
    Effect.gen(function* () {
      const summary: SyncSummary = { activities: 0, tasksCreated: 0, tasksUpdated: 0, itemsIgnored: 0 };
      for (const change of changes) {
        yield* applyChange(binding, change, judgments, summary);
      }
      yield* items.saveCursor(binding.source, nextCursor);
      return summary;
    }),
  );
});

const judgeItemsNeedingTriage = Effect.fnUntraced(function* <TItem, TCursor, EA, EJ, RJ>(
  binding: SourceBinding<TItem, TCursor, EA, EJ, RJ>,
  changes: readonly SourceChange<TItem>[],
): Effect.fn.Return<Map<string, TodoJudgment>, EJ, SourceItemRepository | RJ> {
  const items = yield* SourceItemRepository;
  const candidates: TItem[] = [];
  for (const change of changes) {
    if (change.kind !== "upserted" || binding.toItemDraft(change.item).state !== "open") continue;
    const existing = yield* items.findItem(binding.source, binding.externalIdOf(change.item));
    if (Option.isNone(existing) || existing.value.triage === "pending") candidates.push(change.item);
  }

  const judged = yield* Effect.forEach(
    candidates,
    (item) => binding.judge(item).pipe(Effect.map((judgment) => [binding.externalIdOf(item), judgment] as const)),
    { concurrency: JUDGE_CONCURRENCY },
  );
  return new Map(judged);
});

const applyChange = Effect.fnUntraced(function* <TItem, TCursor, EA, EJ, RJ>(
  binding: SourceBinding<TItem, TCursor, EA, EJ, RJ>,
  change: SourceChange<TItem>,
  judgments: ReadonlyMap<string, TodoJudgment>,
  summary: SyncSummary,
) {
  const items = yield* SourceItemRepository;

  const externalId = change.kind === "removed" ? change.externalId : binding.externalIdOf(change.item);
  const previous = yield* items.findItem(binding.source, externalId);

  let draft: { title: string; url: string; state: ItemState; fingerprint: string };
  if (change.kind === "removed") {
    if (Option.isNone(previous)) return;
    const { title, url, fingerprint } = previous.value;
    draft = { title, url, fingerprint, state: "removed" };
  } else {
    draft = binding.toItemDraft(change.item);
  }
  const item = yield* items.upsertItem({ source: binding.source, externalId, ...draft });

  const kinds = detectActivities(previous, item);
  for (const kind of kinds) {
    yield* items.recordActivity(item.id, kind);
  }
  summary.activities += kinds.length;

  if (item.triage === "pending") {
    yield* triage(item, judgments.get(externalId), summary);
  } else if (item.triage === "linked" && kinds.some((kind) => STATUS_AFFECTING_ACTIVITIES.has(kind))) {
    yield* reconcileStatus(item, summary);
  }
});

const triage = Effect.fnUntraced(function* (item: SourceItem, judgment: TodoJudgment | undefined, summary: SyncSummary) {
  // 判定がない（初めて見た時点で解決済みなど）Item は pending のまま残し、再オープンされたときに判定する。
  if (item.state !== "open" || judgment === undefined) return;
  const items = yield* SourceItemRepository;
  const tasks = yield* TaskRepository;

  const task = yield* tasks.createTask({ title: item.title, status: STATUS_ON_CREATE[judgment.verdict] });
  yield* tasks.linkItem(task.id, item.id, "tracks");
  yield* items.setTriage(item.id, "linked", judgment);
  yield* tasks.recordChange(task.id, { kind: "created", after: { judgment }, unread: false });
  summary.tasksCreated++;
});

const reconcileStatus = Effect.fnUntraced(function* (item: SourceItem, summary: SyncSummary) {
  const tasks = yield* TaskRepository;
  const task = yield* tasks.findTaskByItem(item.id);
  if (Option.isNone(task)) return;

  const next = deriveTaskStatus(task.value.status, yield* tasks.trackedItemStates(task.value.id));
  if (next === task.value.status) return;

  yield* tasks.updateTask(task.value.id, { status: next });
  yield* tasks.recordChange(task.value.id, {
    kind: "field_changed",
    field: "status",
    before: task.value.status,
    after: next,
    unread: true,
  });
  summary.tasksUpdated++;
});
