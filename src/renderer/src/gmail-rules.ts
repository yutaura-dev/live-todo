import type { GmailRuleDraft } from "../../shared/api.js";

export const TOPIC_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "billing", label: "請求・支払い" },
  { value: "account", label: "アカウント・セキュリティ" },
  { value: "product", label: "製品・サービスの変更" },
  { value: "contract", label: "契約・更新・予約" },
  { value: "shipping", label: "注文・配送" },
  { value: "promotion", label: "宣伝・キャンペーン" },
  { value: "news", label: "ニュース・読み物" },
  { value: "other", label: "その他" },
];
const TOPIC_LABEL = new Map(TOPIC_CHOICES.map((choice) => [choice.value, choice.label]));
const KIND_LABEL: Record<string, string> = { newsletter: "メルマガ", notification: "お知らせ", personal: "人からのメール" };

/** 新しいルール。作った時刻より前に届いたメールには当てない */
export const newGmailRule = (createdAt: string, id: string): GmailRuleDraft => ({ id, name: "新しいルール", enabled: true, createdAt, when: {}, then: {} });

/** ルールを一文で見せる（設定の一覧で、何をするルールかが分かるように） */
export function describeRule(rule: GmailRuleDraft): string {
  const conditions = [
    ...((rule.when.topics ?? []).length > 0 ? [`用件が${(rule.when.topics ?? []).map((topic) => `「${TOPIC_LABEL.get(topic) ?? topic}」`).join("か")}`] : []),
    ...((rule.when.kinds ?? []).length > 0 ? [`種類が${(rule.when.kinds ?? []).map((kind) => `「${KIND_LABEL[kind] ?? kind}」`).join("か")}`] : []),
    ...((rule.when.fromContains ?? "").trim() !== "" ? [`差出人のアドレスに「${rule.when.fromContains!.trim()}」を含む`] : []),
    ...((rule.when.subjectContains ?? "").trim() !== "" ? [`件名に「${rule.when.subjectContains!.trim()}」を含む`] : []),
  ];
  const actions: Array<{ te: string; end: string }> = [
    ...((rule.then.labels ?? []).length > 0
      ? [{ te: `ラベル${(rule.then.labels ?? []).map((label) => `「${label}」`).join("")}を付けて`, end: `ラベル${(rule.then.labels ?? []).map((label) => `「${label}」`).join("")}を付ける` }]
      : []),
    ...(rule.then.markRead === true ? [{ te: "既読にして", end: "既読にする" }] : []),
    ...(rule.then.archive === true ? [{ te: "アーカイブして", end: "アーカイブする" }] : []),
  ];
  if (conditions.length === 0 || actions.length === 0) return "条件と操作をそれぞれ 1 つ以上決めてください";
  const action = actions.map((entry, index) => (index === actions.length - 1 ? entry.end : entry.te)).join("");
  return `${conditions.join("で、")}メールに、${action}`;
}
