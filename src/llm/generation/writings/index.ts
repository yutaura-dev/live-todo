import { pointDetailsWriting, recommendationReasonWriting } from "./decision-point.js";
import { planWriting } from "./plan.js";
import { recurringDraftWriting } from "./recurring.js";
import { extractWorkWriting, proposalReasonWriting, taskDraftWriting } from "./routing.js";
import { rewriteTaskWriting } from "./task.js";

/** アプリが Generation に頼む書き物のすべて。ベンチマークはここから選ぶ */
export const allWritings = [
  extractWorkWriting,
  taskDraftWriting,
  proposalReasonWriting,
  planWriting,
  rewriteTaskWriting,
  pointDetailsWriting,
  recommendationReasonWriting,
  recurringDraftWriting,
] as const;

export * from "./decision-point.js";
export * from "./plan.js";
export * from "./recurring.js";
export * from "./routing.js";
export * from "./task.js";
