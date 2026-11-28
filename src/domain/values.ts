import { Schema } from "effect";

// spec の値オブジェクト（due-date.value.ts・wait-estimate.value.ts など）。ドメインと src/llm の両方が使う

export const DueDate = Schema.Struct({
  /** 元の書き方（「12 月中旬」「金曜までに」）。画面ではこれを見せる */
  text: Schema.String,
  /** いちばん早い日時（ISO 8601）。優先度はこれを期日とみなす */
  earliest: Schema.String,
  /** いちばん遅い日時（ISO 8601） */
  latest: Schema.String,
  precision: Schema.Literals(["時刻", "日", "週", "旬", "月"]),
});
export type DueDate = typeof DueDate.Type;
