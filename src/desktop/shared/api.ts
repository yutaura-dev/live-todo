import { Schema } from "effect";
import { DueDate } from "../../domain/values.js";
import { TaskActivity } from "../../domain/task/activity.js";
import { Closure, Completion, TaskStatus } from "../../domain/task/task.js";
import { PrioritizationStatus } from "../../domain/priority/prioritization.js";
import { PriorityLevel } from "../../llm/shared/vocabulary.js";

// renderer と main の間でやりとりする形。renderer はこれだけを知り、DB・秘密情報・AI には触れない（ADR-0002）

export const Mark = Schema.Literals(["新着", "更新マーク", "なし"]);

/** 見せる優先度（いまのラベルと、どう決まったか。まだ決め始めていなければ status は未判定） */
export const PriorityView = Schema.Struct({ status: PrioritizationStatus, level: Schema.NullOr(PriorityLevel), reason: Schema.NullOr(Schema.String) });
export type PriorityView = typeof PriorityView.Type;

export const BoardCard = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: TaskStatus,
  mark: Mark,
  due: Schema.NullOr(Schema.String),
  blocksOthers: Schema.Boolean,
  priority: PriorityView,
});
export type BoardCard = typeof BoardCard.Type;

export const TaskView = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  brief: Schema.NullOr(Schema.String),
  status: TaskStatus,
  completion: Completion,
  closure: Schema.NullOr(Closure),
  due: Schema.NullOr(DueDate),
  mark: Mark,
  priority: PriorityView,
  history: Schema.Array(TaskActivity),
  createdAt: Schema.String,
});
export type TaskView = typeof TaskView.Type;

const Id = Schema.String.check(Schema.isNonEmpty());

/** 画面からの操作。どれも「ユーザーが」行う（renderer は登場人物を選べない） */
export const Command = Schema.Union([
  Schema.TaggedStruct("CreateTask", { title: Schema.String, brief: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("CompleteTask", { id: Id }),
  Schema.TaggedStruct("DismissTask", { id: Id }),
  Schema.TaggedStruct("ReopenTask", { id: Id }),
  Schema.TaggedStruct("SetDue", { id: Id, due: Schema.NullOr(DueDate) }),
  Schema.TaggedStruct("DefineCompletion", { id: Id }),
  Schema.TaggedStruct("ViewTask", { id: Id }),
  Schema.TaggedStruct("SetPriority", { id: Id, level: PriorityLevel }),
  Schema.TaggedStruct("ClearPriority", { id: Id }),
]);
export type Command = typeof Command.Type;

export const Query = Schema.Union([Schema.TaggedStruct("Board", {}), Schema.TaggedStruct("Task", { id: Id })]);
export type Query = typeof Query.Type;

/** 断られた・見つからないは値で返す（画面は reason をそのまま見せる） */
export type Reply<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly reason: string };

export { CHANNELS } from "./channels.js";

export interface LiveTodoApi {
  command(command: Command): Promise<Reply<TaskView>>;
  board(): Promise<Reply<ReadonlyArray<BoardCard>>>;
  task(id: string): Promise<Reply<TaskView>>;
  /** main 側で Task が変わったら呼ばれる。戻り値で購読をやめる */
  onChanged(listener: () => void): () => void;
}
