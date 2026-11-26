import type { RuleActions, RuleDraft } from "../../shared/api.js";

/** 新しいルール。作った時刻より前に届いたものには当てない */
export const newRule = (createdAt: string, id: string): RuleDraft => ({ id, name: "新しいルール", enabled: true, createdAt, when: "", then: "", actions: {}, interpretedFrom: "" });

/** 読み取った操作を、読める文にする（「ラベル「レシート」を付ける・既読にする」） */
export function describeActions(actions: RuleActions): string {
  const gmail = actions.gmail ?? {};
  const parts = [
    ...(gmail.labels ?? []).map((label) => `ラベル「${label}」を付ける`),
    ...(gmail.markRead === true ? ["既読にする"] : []),
    ...(gmail.archive === true ? ["アーカイブする"] : []),
  ];
  return parts.length === 0 ? "（操作なし）" : `Gmail で${parts.join("・")}`;
}

/** 「何をする」を読み取ってあるか（書き換えたあとに読み取り直していなければ false） */
export const isInterpreted = (rule: RuleDraft) => rule.then.trim() !== "" && rule.interpretedFrom === rule.then;
