/**
 * 利用者が決めたルール（ADR-0014）。条件は言葉で書き（「請求書に関するメール」など）、当てはまるかは Decisions で判定する。
 * ルールの中身はアプリに組み込まず、設定に持つ。操作は Source ごとに決める（今は Gmail のラベル・既読・アーカイブだけ）
 */
export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  /** これより前に届いたものには当てない（過去のものにまとめて書き込まない） */
  createdAt: string;
  /** 条件（言葉で書く） */
  when: string;
  then: { gmail?: GmailRuleActions | undefined };
};

/** Gmail の操作はラベルの付け外しだけ。ゴミ箱に入れる・送るはルールではできない */
export type GmailRuleActions = { labels?: ReadonlyArray<string> | undefined; markRead?: boolean | undefined; archive?: boolean | undefined };

/** これ以上の確率で当てはまるときだけ当てる（自動で書き込むので、迷うものには当てない） */
export const RULE_MATCH_PROBABILITY = 0.8;

const hasGmailActions = (actions: GmailRuleActions | undefined) =>
  actions !== undefined && ((actions.labels ?? []).length > 0 || actions.markRead === true || actions.archive === true);

/** メールを、このルールの条件で判定する対象にするか */
export const isRuleCandidate = (mail: { receivedAt: number; kind: string }, rule: Rule) =>
  rule.enabled && mail.kind !== "mine" && hasGmailActions(rule.then.gmail) && mail.receivedAt >= Date.parse(rule.createdAt);

/** Gmail の操作を、ラベルの付け外しにする。labelIds はラベルの名前から id への対応 */
export function gmailLabelChangesOf(actions: GmailRuleActions, labelIds: ReadonlyMap<string, string>) {
  return {
    add: (actions.labels ?? []).flatMap((name) => (labelIds.has(name) ? [labelIds.get(name)!] : [])),
    remove: [...(actions.markRead === true ? ["UNREAD"] : []), ...(actions.archive === true ? ["INBOX"] : [])],
  };
}
