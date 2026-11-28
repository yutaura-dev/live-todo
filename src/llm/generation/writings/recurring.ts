import { Schema } from "effect";
import { TaskMaterial } from "../../shared/materials.js";
import { defineWriting } from "../writing.js";
import { ItemDraft } from "./plan.js";

const Weekday = Schema.Literals(["月", "火", "水", "木", "金", "土", "日"]);

/** recurring-task.spec の Schedule */
export const ScheduleDraft = Schema.Union([
  Schema.Struct({ type: Schema.Literal("毎日") }),
  Schema.Struct({ type: Schema.Literal("毎週"), weekday: Weekday }),
  Schema.Struct({ type: Schema.Literal("毎月"), day: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("毎年"), month: Schema.Number, day: Schema.Number }),
]);

/**
 * 「定期の Task にしませんか」の下書き（決まり方・ひな形の Action Item）。決まりを作るのはユーザーが承認してから。
 * ひな形は期日と版を持たない（recurring-task.spec の不変条件）ので、呼ぶ側で due を落とす。
 */
export const recurringDraftWriting = defineWriting({
  purpose: "recurring.draft",
  version: 1,
  objectName: "recurring_draft",
  input: Schema.Struct({ task: TaskMaterial, similar: Schema.Array(Schema.Struct({ title: Schema.String, closedAt: Schema.String })) }),
  output: Schema.Struct({
    rule: ScheduleDraft,
    advanceDays: Schema.Number,
    dueAfterDays: Schema.NullOr(Schema.Number),
    template: Schema.Array(ItemDraft),
  }),
  instructions: () =>
    [
      "この Task（task）と、似た Task が終わった日（similar）から、決まった時期に同じ Task を作る決まりの下書きを書いてください。",
      "- rule: 予定日の出し方（毎日・毎週・毎月・毎年）",
      "- advanceDays: 予定日の何日前に作るか。dueAfterDays: 予定日から何日後を期日にするか（決めないなら null）",
      "- template: 毎回の Action Item。期日は書かない",
    ].join("\n"),
});
