import { optionAspectsQuestion, recommendationQuestion } from "./decision-point.js";
import { itemEffortQuestion } from "./plan.js";
import { blockingNowQuestion, priorityLevelQuestion } from "./priority.js";
import { factBelongsToTaskQuestion, factRequestsWorkQuestion, workNeedsNewActionQuestion, workOutlivesTaskQuestion } from "./routing.js";
import { arrivalImpactQuestion, blocksOthersQuestion, detachNeedsReplanQuestion } from "./task.js";

/** アプリが Decisions に聞く問いのすべて。ベンチマークはここから問いを選ぶ */
export const allQuestions = [
  factRequestsWorkQuestion,
  factBelongsToTaskQuestion,
  workOutlivesTaskQuestion,
  workNeedsNewActionQuestion,
  arrivalImpactQuestion,
  detachNeedsReplanQuestion,
  blocksOthersQuestion,
  priorityLevelQuestion,
  blockingNowQuestion,
  optionAspectsQuestion,
  recommendationQuestion,
  itemEffortQuestion,
] as const;

export * from "./decision-point.js";
export * from "./plan.js";
export * from "./priority.js";
export * from "./routing.js";
export * from "./task.js";
