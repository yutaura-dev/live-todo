import type { Rule } from "./rule.spec.ts";
import type { RuleRun } from "./rule-run.spec.ts";

/**
 * Rule と、そのルールを当てた記録（Rule Run）。Rule Run は Rule を通してだけ扱う。
 * 同じ Task に、同じ中身のルールを、同じきっかけで当てるのは一度だけ、という決まりは、ルールとその記録を一緒に見て守る。
 */
export const displayName = "Rule";
export const root = "rule";
export const entities = ["rule-run"];

export const invariants = {
  "判定待ちの記録があるのは、有効なルールだけ（止めた・消した・書き換えたら、判定待ちは当てない）": (rule: Rule, runs: ReadonlyArray<RuleRun>) =>
    rule.status === "有効" || runs.every((run) => run.status !== "判定待ち"),
  "同じ Task・同じ中身・同じきっかけで当てた記録は、1 つだけ": (_rule: Rule, runs: ReadonlyArray<RuleRun>) =>
    new Set(runs.map((run) => `${run.taskId}|${run.ruleFingerprint}|${run.triggerKey}`)).size === runs.length,
};
