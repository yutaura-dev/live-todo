import type { RuleDraft } from "../../shared/api.js";

/** 新しいルール。作った時刻より前に届いたものには当てない */
export const newRule = (createdAt: string, id: string): RuleDraft => ({ id, name: "新しいルール", enabled: true, createdAt, when: "", then: {} });

/** ルールを一文で見せる（設定の一覧で、何をするルールかが分かるように） */
export function describeRule(rule: RuleDraft): string {
  const gmail = rule.then.gmail ?? {};
  const actions: Array<{ te: string; end: string }> = [
    ...((gmail.labels ?? []).length > 0
      ? [{ te: `ラベル${(gmail.labels ?? []).map((label) => `「${label}」`).join("")}を付けて`, end: `ラベル${(gmail.labels ?? []).map((label) => `「${label}」`).join("")}を付ける` }]
      : []),
    ...(gmail.markRead === true ? [{ te: "既読にして", end: "既読にする" }] : []),
    ...(gmail.archive === true ? [{ te: "アーカイブして", end: "アーカイブする" }] : []),
  ];
  if (rule.when.trim() === "" || actions.length === 0) return "条件と操作をそれぞれ決めてください";
  const action = actions.map((entry, index) => (index === actions.length - 1 ? entry.end : entry.te)).join("");
  return `「${rule.when.trim()}」に当てはまるメールが届いたら、Gmail で${action}`;
}
