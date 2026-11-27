import { Effect } from "effect";
import { labelCandidatesOf } from "../core/rules/interpret.js";
import { interpretRuleActions, ruleActionsOf } from "../core/rules/rule-actions.js";

const MAX_LABEL_CANDIDATES = 30;

/**
 * ルールの「何をする」を読み取る（ADR-0019）。Gmail のアカウントは、メールへの操作を読み取ったときだけ求める
 * （Task への操作だけのルールは、どの Source の Task にも当てられるため）
 */
export const readRuleActions = Effect.fnUntraced(function* (then: string, gmail: { available: boolean; labels: ReadonlyArray<string> }) {
  const candidates = [...new Set([...labelCandidatesOf(then), ...gmail.labels])].slice(0, MAX_LABEL_CANDIDATES);
  const result = ruleActionsOf(yield* interpretRuleActions({ then, labels: candidates }));
  if (result.ok && result.actions.gmail !== undefined && !gmail.available) {
    return { ok: false as const, reason: "メールへの操作（既読・アーカイブ・ラベル）には、Gmail のアカウントの設定が要ります" };
  }
  return result;
});
