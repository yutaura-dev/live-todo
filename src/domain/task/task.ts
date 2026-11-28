import { DateTime, Effect, Schema } from "effect";
import { DueDate } from "../values.js";
import { type ActivityBy, PLAN_FIELDS, TaskActivity, type TaskFieldChange } from "./activity.js";

// specs/task.spec.ts の Task。計画・事実・定期の Task・優先度は、それぞれの縦の一本で足す

export const TaskStatus = Schema.Literals(["やること", "完了待ち", "終わった"]);
export type TaskStatus = typeof TaskStatus.Type;
export const Completion = Schema.Literals(["未定", "まだ", "満たした"]);
export const CompleteReason = Schema.Literals(["自分で完了にした", "完了条件を満たした"]);
export type CompleteReason = typeof CompleteReason.Type;
export const DismissReason = Schema.Literals(["自分で片付けた", "絞り込みの外になった", "もう要らなくなった"]);
export type DismissReason = typeof DismissReason.Type;
export const Origin = Schema.Literals(["事実から自動で作った", "提案を受け入れた", "手で足した", "定期の Task から作った", "切り出した"]);
export type Origin = typeof Origin.Type;

export const Closure = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("done"), reason: CompleteReason }),
  Schema.Struct({ outcome: Schema.Literal("dismissed"), reason: DismissReason }),
  Schema.Struct({ outcome: Schema.Literal("merged"), into: Schema.String }),
]);

export const Task = Schema.Struct({
  id: Schema.String,
  status: TaskStatus,
  closure: Schema.NullOr(Closure),
  pendingReason: Schema.NullOr(CompleteReason),
  completion: Completion,
  title: Schema.String,
  brief: Schema.NullOr(Schema.String),
  due: Schema.NullOr(DueDate),
  blocksOthers: Schema.Boolean,
  /** この Task についての事実（つながりの持ち主は Task。1 つの事実を、いくつの Task が持ってもよい） */
  sourceItemIds: Schema.Array(Schema.String),
  history: Schema.Array(TaskActivity),
  lastSeenAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Task = typeof Task.Type;

export type Actor = { readonly kind: "user" } | { readonly kind: "sync" } | { readonly kind: "agent" } | { readonly kind: "app" };

/** spec の ensure に当たる。reason は spec の理由の文のまま（テストと画面が同じ言葉で断る） */
export class TaskDenied extends Schema.TaggedError<TaskDenied>()("TaskDenied", { operation: Schema.String, reason: Schema.String }) {}

const BY: Record<Actor["kind"], ActivityBy> = { user: "ユーザー", agent: "AI", sync: "同期", app: "アプリ" };
const CREATED_BY: Record<Origin, Actor["kind"]> = {
  事実から自動で作った: "agent",
  提案を受け入れた: "user",
  手で足した: "user",
  "定期の Task から作った": "app",
  切り出した: "user",
};

const isOpen = (task: Task) => task.status === "やること";
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const guard = (operation: string) => (holds: boolean, reason: string) => (holds ? Effect.void : Effect.fail(new TaskDenied({ operation, reason })));

/** 出来事を 1 つ足す。前と後が同じ変化は残さず、変化が残らなければ出来事も足さない（task-activity.value.ts の不変条件） */
const noted = (task: Task, actor: Actor, changes: ReadonlyArray<TaskFieldChange>, next: Partial<Task>, cause: string | null = null) =>
  Effect.gen(function* () {
    const kept = changes.filter((change) => PLAN_FIELDS.includes(change.field) || change.before !== change.after);
    if (kept.length === 0) return { ...task, ...next };
    const occurredAt = yield* nowIso;
    const activity: TaskActivity = { kind: "変わった", by: BY[actor.kind], occurredAt, changes: kept, cause };
    return { ...task, ...next, history: [...task.history, activity], updatedAt: occurredAt };
  });

export const create = Effect.fn("Task.create")(function* (input: {
  id: string;
  title: string;
  actor: Actor;
  origin: Origin;
  brief?: string | null;
  due?: DueDate | null;
  blocksOthers?: boolean;
  sourceItemIds?: ReadonlyArray<string>;
}) {
  const ensure = guard("initial");
  yield* ensure(input.actor.kind === CREATED_BY[input.origin], "事実から自動で作るのは AI、提案を受け入れる・手で足す・切り出すのはユーザー、定期の Task の回はアプリだけ");
  // spec にはない、実装の入力の検証（題のない Task はボードで見分けられない）
  yield* ensure(input.title.trim() !== "", "何をするかが要る");
  const now = yield* nowIso;
  const task: Task = {
    id: input.id,
    status: "やること",
    closure: null,
    pendingReason: null,
    completion: "未定",
    title: input.title.trim(),
    brief: input.brief ?? null,
    due: input.due ?? null,
    blocksOthers: input.blocksOthers ?? false,
    sourceItemIds: [...(input.sourceItemIds ?? [])],
    history: [{ kind: "できた", by: BY[input.actor.kind], occurredAt: now, changes: [], cause: input.origin }],
    lastSeenAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return task;
});

export const complete = Effect.fn("Task.complete")(function* (
  task: Task,
  actor: Actor,
  reason: CompleteReason,
  facts: { effects: "完了したときにすることがない" | "完了したときにすることがある"; added: "足した項目はすべて済んだ" | "足した項目にまだのものがある" },
) {
  const ensure = guard("complete");
  yield* ensure(reason !== "自分で完了にした" || actor.kind === "user", "自分で完了にするのはユーザーだけ");
  yield* ensure(isOpen(task), "やること のときだけ");
  yield* ensure(reason !== "完了条件を満たした" || task.completion === "満たした", "完了条件で終えるのは、完了条件をすべて満たしたときだけ");
  yield* ensure(
    reason !== "完了条件を満たした" || facts.added === "足した項目はすべて済んだ",
    "完了条件で自動で終えるのは、事実から計画に足した項目がすべて済んだときだけ（残っていれば、切り出しを提案する）",
  );
  if (facts.effects === "完了したときにすることがある") {
    return yield* noted(task, actor, [{ field: "列", before: task.status, after: "完了待ち", target: null }], { status: "完了待ち", pendingReason: reason });
  }
  return yield* noted(
    task,
    actor,
    [
      { field: "列", before: task.status, after: "終わった", target: null },
      { field: "どう終わったか", before: null, after: reason, target: null },
    ],
    { status: "終わった", closure: { outcome: "done", reason } },
  );
});

export const dismiss = Effect.fn("Task.dismiss")(function* (task: Task, actor: Actor, reason: DismissReason, inFlight: "頼んだものはない" | "頼んだものがある") {
  const ensure = guard("dismiss");
  const allowed = reason === "自分で片付けた" ? "user" : reason === "絞り込みの外になった" ? "sync" : "agent";
  yield* ensure(actor.kind === allowed, "自分で片付けるのはユーザー、絞り込みの外は同期、もう要らないと判定するのは AI だけ");
  yield* ensure(isOpen(task) || task.status === "完了待ち", "やること・完了待ちのときだけ");
  yield* ensure(inFlight === "頼んだものはない", "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）");
  return yield* noted(
    task,
    actor,
    [
      { field: "列", before: task.status, after: "終わった", target: null },
      { field: "どう終わったか", before: null, after: reason, target: null },
    ],
    { status: "終わった", pendingReason: null, closure: { outcome: "dismissed", reason } },
  );
});

export const reopen = Effect.fn("Task.reopen")(function* (task: Task, actor: Actor, inFlight: "頼んだものはない" | "頼んだものがある") {
  const ensure = guard("reopen");
  yield* ensure(actor.kind === "user" || actor.kind === "agent", "ユーザーか AI だけ");
  yield* ensure(task.status === "終わった" || task.status === "完了待ち", "終わった・完了待ちのときだけ");
  yield* ensure(inFlight === "頼んだものはない", "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）");
  yield* ensure(
    actor.kind !== "agent" || !(task.closure?.outcome === "dismissed" && task.closure.reason === "自分で片付けた"),
    "自分で片付けた Task は、AI では戻らない",
  );
  return yield* noted(task, actor, [{ field: "列", before: task.status, after: "やること", target: null }], {
    status: "やること",
    closure: null,
    pendingReason: null,
    completion: "未定",
  });
});

export const setDue = Effect.fn("Task.setDue")(function* (task: Task, actor: Actor, due: DueDate | null) {
  const ensure = guard("setDue");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(isOpen(task), "やること のときだけ");
  return yield* noted(task, actor, [{ field: "期日", before: task.due?.text ?? null, after: due?.text ?? null, target: null }], { due });
});

export const defineCompletionByHand = Effect.fn("Task.defineCompletionByHand")(function* (task: Task, actor: Actor) {
  const ensure = guard("defineCompletionByHand");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(isOpen(task), "やること のときだけ");
  yield* ensure(task.completion === "未定", "完了条件が決まっていないときだけ");
  return yield* noted(task, actor, [{ field: "完了条件", before: "未定", after: "まだ", target: null }], { completion: "まだ" });
});

/** 事実を持つ（振り分けが、この Task の事実にすると決めた）。事実は出来事にしない（task-activity.value.ts） */
export const attachFact = Effect.fn("Task.attachFact")(function* (task: Task, _actor: Actor, sourceItemId: string) {
  yield* guard("attachFact")(task.status !== "終わった", "終わっていないときだけ");
  return task.sourceItemIds.includes(sourceItemId) ? task : { ...task, sourceItemIds: [...task.sourceItemIds, sourceItemId] };
});

/** 事実を外す（ユーザーが外した・別の Task に移した・対象外にした） */
export const detachFact = Effect.fn("Task.detachFact")(function* (task: Task, actor: Actor, sourceItemId: string) {
  yield* guard("detachFact")(actor.kind === "user", "ユーザーだけ");
  return { ...task, sourceItemIds: task.sourceItemIds.filter((id) => id !== sourceItemId) };
});

/** 優先度の段階が変わった（優先度の決まり方から届く）。ラベル未定は「ラベル未定」として残す */
export const notePriority = Effect.fn("Task.notePriority")(function* (task: Task, actor: Actor, before: string | null, after: string | null) {
  yield* guard("notePriority")(isOpen(task), "やること のときだけ（終わった Task の優先度は判定しない）");
  return yield* noted(task, actor, [{ field: "優先度", before, after, target: null }], {});
});

/** 見ても、最後に変えた日時は変えない（Task の中身は変わらないので） */
export const view = Effect.fn("Task.view")(function* (task: Task, actor: Actor) {
  yield* guard("view")(actor.kind === "user", "ユーザーだけ");
  return { ...task, lastSeenAt: yield* nowIso };
});

/** 更新マークと新着（spec の判断表）。保存せず、履歴と最後に見た時刻から導く */
export function markOf(task: Task): "新着" | "更新マーク" | "なし" {
  if (task.lastSeenAt === null) return "新着";
  const seenAt = task.lastSeenAt;
  const lastBy = new Map<string, ActivityBy>();
  for (const activity of task.history) {
    if (activity.occurredAt <= seenAt) continue;
    for (const change of activity.changes) lastBy.set(change.field, activity.by);
  }
  return [...lastBy.values()].some((by) => by !== "ユーザー") ? "更新マーク" : "なし";
}
