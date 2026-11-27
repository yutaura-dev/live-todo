import type { RuleCondition } from "./rule-condition.js";

/**
 * 利用者が決めたルール（ADR-0014、ADR-0019）。「どういう時」と「何をする」を言葉で書き、どちらも Decisions でアプリの判定・操作に結びつける。
 * ルールの中身はアプリに組み込まず、設定に持つ。操作は Source ごとに決める（今は Gmail のラベル・既読・アーカイブだけ）
 */
export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  /** これより前に届いたものには当てない（過去のものにまとめて書き込まない） */
  createdAt: string;
  /** どういう時（言葉で書く。届いたものごとに Decisions で当てはまるかを判定する） */
  when: string;
  /** when を分けた問い。Task に当てるときは、文を読み直さずにこれで判定する（ADR-0019） */
  condition?: RuleCondition | undefined;
  /** condition を分けた when の文。when を書き換えたら分け直す */
  conditionFrom?: string | undefined;
  /** 何をする（言葉で書く。保存するときに Decisions でアプリの操作に結びつけ、actions に持つ） */
  then: string;
  /** then から読み取ったアプリの操作。当てるときはこれを使い、文を読み直さない */
  actions: { task?: "done" | "dismissed" | "todo" | undefined; gmail?: GmailRuleActions | undefined };
  /** actions を読み取った then の文。then を書き換えたら読み取り直す */
  interpretedFrom: string;
};

/** Gmail の操作はラベルの付け外しだけ。ゴミ箱に入れる・送るはルールではできない */
export type GmailRuleActions = { labels?: ReadonlyArray<string> | undefined; markRead?: boolean | undefined; archive?: boolean | undefined };

/** これ以上の確率で当てはまるときだけ当てる（自動で書き込むので、迷うものには当てない） */
export const RULE_MATCH_PROBABILITY = 0.8;

const hasGmailActions = (actions: GmailRuleActions | undefined) =>
  actions !== undefined && ((actions.labels ?? []).length > 0 || actions.markRead === true || actions.archive === true);

/** メールを、このルールの条件で判定する対象にするか */
export const isRuleCandidate = (mail: { receivedAt: number; kind: string }, rule: Rule) =>
  rule.enabled && mail.kind !== "mine" && rule.interpretedFrom === rule.then && hasGmailActions(rule.actions.gmail) && mail.receivedAt >= Date.parse(rule.createdAt);

// Gmail のシステムのラベル。付けると、ゴミ箱に入れる・迷惑メールにするなど、ルールでは許していない操作になってしまう
const RESERVED_LABELS = new Set(["INBOX", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT"]);
export const isReservedLabelName = (name: string) => RESERVED_LABELS.has(name.trim().toUpperCase()) || /^CATEGORY_/i.test(name.trim());
const isUserLabelId = (id: string) => id.startsWith("Label_");

/** Gmail の操作を、ラベルの付け外しにする。labelIds はラベルの名前から id への対応。付けるのは利用者のラベルだけ */
export function gmailLabelChangesOf(actions: GmailRuleActions, labelIds: ReadonlyMap<string, string>) {
  return {
    add: (actions.labels ?? []).flatMap((name) => {
      const id = labelIds.get(name);
      return id !== undefined && isUserLabelId(id) && !isReservedLabelName(name) ? [id] : [];
    }),
    remove: [...(actions.markRead === true ? ["UNREAD"] : []), ...(actions.archive === true ? ["INBOX"] : [])],
  };
}
