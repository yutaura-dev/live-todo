import { Schema } from "effect";

// specs/task-activity.value.ts の Task Activity

export const ActivityBy = Schema.Literals(["ユーザー", "AI", "同期", "アプリ"]);
export type ActivityBy = typeof ActivityBy.Type;

export const TaskField = Schema.Literals([
  "列",
  "どう終わったか",
  "何をするか",
  "今の状況と次の一手",
  "計画",
  "Action Item の進み",
  "完了条件",
  "完了したときにすること",
  "AI の作業",
  "優先度",
  "期日",
  "他の人を止めているか",
]);
export type TaskField = typeof TaskField.Type;

export const TaskFieldChange = Schema.Struct({
  field: TaskField,
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
  target: Schema.NullOr(Schema.String),
});
export type TaskFieldChange = typeof TaskFieldChange.Type;

export const TaskActivity = Schema.Struct({
  kind: Schema.Literals(["できた", "変わった"]),
  by: ActivityBy,
  occurredAt: Schema.String,
  changes: Schema.Array(TaskFieldChange),
  cause: Schema.NullOr(Schema.String),
});
export type TaskActivity = typeof TaskActivity.Type;

/** 前と後の値を持たない項目（どれが変わったかを計画の中でハイライトする） */
export const PLAN_FIELDS: ReadonlyArray<TaskField> = ["計画", "Action Item の進み", "完了したときにすること"];
