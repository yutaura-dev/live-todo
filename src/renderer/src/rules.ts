import type { RuleActions, RuleCondition, RuleDraft } from "../../shared/api.js";

/** 新しいルール。作った時刻より前に届いたもの・できた Task には当てない */
export const newRule = (createdAt: string, id: string): RuleDraft => ({
  id,
  name: "新しいルール",
  enabled: true,
  createdAt,
  when: "",
  conditionFrom: "",
  then: "",
  actions: {},
  interpretedFrom: "",
});

const TASK_ACTION_TEXT = { done: "Task を完了にする", dismissed: "Task を対象外にする", todo: "Task を todo にする" } as const;

/** 読み取った操作を、読める文にする（「Task を完了にする・Gmail でラベル「レシート」を付ける」） */
export function describeActions(actions: RuleActions): string {
  const gmail = actions.gmail ?? {};
  const gmailParts = [
    ...(gmail.labels ?? []).map((label) => `ラベル「${label}」を付ける`),
    ...(gmail.markRead === true ? ["既読にする"] : []),
    ...(gmail.archive === true ? ["アーカイブする"] : []),
  ];
  const parts = [...(actions.task === undefined ? [] : [TASK_ACTION_TEXT[actions.task]]), ...(gmailParts.length === 0 ? [] : [`Gmail で${gmailParts.join("・")}`])];
  return parts.length === 0 ? "（操作なし）" : parts.join("・");
}

/** 分けた問いを、利用者が確かめられる形にする */
export function describeCondition(condition: RuleCondition): string[] {
  return [
    ...condition.clauses.map((clause) => `${clause.question} → ${clause.expect ? "はい" : "いいえ"}`),
    ...(condition.combine === "any" ? ["（どれか 1 つに当てはまればよい）"] : []),
  ];
}

/** 「何をする」を読み取ってあるか（書き換えたあとに読み取り直していなければ false） */
export const isInterpreted = (rule: RuleDraft) => rule.then.trim() !== "" && rule.interpretedFrom === rule.then;

/** 「どういう時」を判定に使う問いに分けてあるか（書き換えたあとに分け直していなければ false） */
export const isConditionChecked = (rule: RuleDraft) => rule.when.trim() !== "" && rule.condition !== undefined && rule.conditionFrom === rule.when;

/** Task への操作をするルールは、分けた問いで判定するので、条件を分けて確かめる必要がある（ADR-0019） */
export const needsCondition = (rule: RuleDraft) => rule.actions.task !== undefined;

/**
 * 今あるものにも当てるとき、判定する対象。読み取った操作の Source から決める（操作のない Source のものには当てようがないため）。
 * Task への操作は、ルールを作ったあとにできた・動いた Task にだけ当てる（今ある Task にまとめて当てない）
 */
export function existingTargetsOf(actions: RuleActions): string[] {
  return [...(actions.gmail === undefined ? [] : ["Gmail の受信トレイに残っているメール"])];
}
