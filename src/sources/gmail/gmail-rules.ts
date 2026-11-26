import type { MailKind, MailTopic } from "../../core/judge/mail-classifier.js";

/**
 * 利用者が決めた Gmail のルール（請求書にラベルを付けて既読にする、など）。ルールの中身はアプリに組み込まず、設定に持つ（ADR-0014）。
 * 操作はラベルの付け外し（ラベル・既読・アーカイブ）だけ。ゴミ箱に入れる・送るはルールではできない
 */
export type GmailRule = {
  id: string;
  name: string;
  enabled: boolean;
  /** これより前に届いたメールには当てない（過去のメールにまとめて書き込まない） */
  createdAt: string;
  when: {
    topics?: ReadonlyArray<MailTopic> | undefined;
    kinds?: ReadonlyArray<MailKind> | undefined;
    fromContains?: string | undefined;
    subjectContains?: string | undefined;
  };
  then: { labels?: ReadonlyArray<string> | undefined; markRead?: boolean | undefined; archive?: boolean | undefined };
};

export type RuleTarget = {
  kind: MailKind | "mine";
  topic: MailTopic | null;
  senderName: string;
  senderKey: string;
  subject: string;
  receivedAt: number;
};

const contains = (text: string, part: string | undefined) => part === undefined || part.trim() === "" || text.toLowerCase().includes(part.trim().toLowerCase());

export function matchesRule(mail: RuleTarget, rule: GmailRule): boolean {
  if (!rule.enabled || mail.kind === "mine" || mail.receivedAt < Date.parse(rule.createdAt)) return false;
  const { topics, kinds, fromContains, subjectContains } = rule.when;
  if (topics !== undefined && topics.length > 0 && (mail.topic === null || !topics.includes(mail.topic))) return false;
  if (kinds !== undefined && kinds.length > 0 && !kinds.includes(mail.kind)) return false;
  return contains(`${mail.senderName} ${mail.senderKey}`, fromContains) && contains(mail.subject, subjectContains);
}

/** ルールの操作を、Gmail のラベルの付け外しにする。labelIds はラベルの名前から id への対応 */
export function labelChangesOf(then: GmailRule["then"], labelIds: ReadonlyMap<string, string>) {
  return {
    add: (then.labels ?? []).flatMap((name) => (labelIds.has(name) ? [labelIds.get(name)!] : [])),
    remove: [...(then.markRead === true ? ["UNREAD"] : []), ...(then.archive === true ? ["INBOX"] : [])],
  };
}
