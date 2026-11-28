import { Schema } from "effect";

// spec の値オブジェクトと同じ値を Schema で持つ。spec はコードを指さないので、対応はここから spec の名前で書く
// （priority.value.ts の Level・action-definition.value.ts の Effort / Aspect・due-date.value.ts・wait-estimate.value.ts）

export const PriorityLevel = Schema.Literals(["今すぐ", "今日中", "3 日以内", "10 日以内", "30 日以内", "それより先でよい"]);
export type PriorityLevel = typeof PriorityLevel.Type;

export const Effort = Schema.Literals(["easy", "normal", "hard", "tedious"]);
export type Effort = typeof Effort.Type;

export const Aspect = Schema.Literals(["期日", "手間", "あとの負担", "お金", "確実さ", "取り返し", "セキュリティ", "ほかの人", "機会", "決まり", "出来"]);
export type Aspect = typeof Aspect.Type;

export { DueDate } from "../../domain/values.js";

export const WaitEstimate = Schema.Struct({
  /** 元の書き方（「2〜3 営業日」） */
  text: Schema.String,
  minDays: Schema.Number,
  maxDays: Schema.Number,
  businessDays: Schema.Boolean,
});
export type WaitEstimate = typeof WaitEstimate.Type;

export const TaskStatus = Schema.Literals(["やること", "完了待ち", "終わった"]);
export const Completion = Schema.Literals(["未定", "まだ", "満たした"]);
export const ItemStatus = Schema.Literals(["まだ", "済んだ", "やらなくなった"]);
