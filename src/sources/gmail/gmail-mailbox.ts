import type { MailKind, MailTopic } from "../../core/judge/mail-classifier.js";
import type { MailHeader } from "./gmail-client.js";

/** 保存したメール 1 通。kind の mine は自分が送ったもの（仕分けない） */
export type StoredMail = {
  messageId: string;
  threadId: string;
  senderKey: string;
  senderName: string;
  subject: string;
  receivedAt: number;
  kind: MailKind | "mine";
  inInbox: boolean;
  unread: boolean;
  trashed: boolean;
  /** 日程が過ぎた（または取り消された）予定の招待 */
  pastInvite: boolean;
  /** 日程がまだ先の招待。Calendar に出欠を任せるときは、対応待ちに数えない */
  upcomingInvite?: boolean;
  /** メルマガ・お知らせとして届いた（kind が personal でも、対応が要るとして移したもの） */
  bulk?: boolean;
  /** メルマガ・お知らせの用件。判定していなければ null（「その他」にまとめる） */
  topic?: MailTopic | null;
};

type Headers = Partial<Record<MailHeader, string>>;

const addressOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();

/** 同じ送り主を見分ける鍵。メーリングリストの List-Id は差出人のアドレスが変わっても同じなので優先する */
export const senderKeyOf = (headers: Headers) => {
  const listId = headers["list-id"];
  if (listId !== undefined) return (/<([^>]+)>/.exec(listId)?.[1] ?? listId).trim().toLowerCase();
  return addressOf(headers.from ?? "");
};

export const senderNameOf = (headers: Headers) => {
  const from = headers.from;
  if (from === undefined || from.trim() === "") return "（差出人なし）";
  const name = from.replace(/<[^>]*>/, "").trim().replace(/^"(.*)"$/, "$1").trim();
  return name === "" ? addressOf(from) : name;
};

const STATS_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_RECEIVED_FOR_SUGGESTION = 5;
const DISCARD_RATIO_FOR_SUGGESTION = 0.8;

export type SenderGroup = {
  /** まとまりの鍵（送り主と用件）。Source Item の externalId にする */
  groupKey: string;
  topic: MailTopic;
  senderKey: string;
  senderName: string;
  kind: "newsletter" | "notification";
  /** 受信トレイに残っている（未処理の）メール */
  pending: ReadonlyArray<string>;
  /** その件名（新しい順） */
  pendingSubjects: ReadonlyArray<string>;
  /** その届いた時刻（ミリ秒、新しい順。pendingSubjects と同じ並び） */
  pendingReceivedAt: ReadonlyArray<number>;
  /** 未処理のうち、日程が過ぎた招待 */
  pastInvites: ReadonlyArray<string>;
  /** 送り主の全体で、直近 60 日に届いた数（用件ではなく送り主で数える。配信の解除は送り主の単位なので） */
  received: number;
  /** そのうち、削除した（ゴミ箱）か、読まずにアーカイブした数 */
  discarded: number;
  suggestUnsubscribe: boolean;
};

const isPending = (mail: StoredMail) => mail.inInbox && !mail.trashed;
const isDiscarded = (mail: StoredMail) => mail.trashed || (!mail.inInbox && mail.unread);
const byReceived = (a: StoredMail, b: StoredMail) => a.receivedAt - b.receivedAt;

export const groupKeyOf = (senderKey: string, topic: MailTopic) => `${senderKey}#${topic}`;
const isBulk = (mail: StoredMail) => mail.kind === "newsletter" || mail.kind === "notification";

export function senderGroups(mails: ReadonlyArray<StoredMail>, now: number): SenderGroup[] {
  const bySender = new Map<string, StoredMail[]>();
  const byGroup = new Map<string, { senderKey: string; topic: MailTopic; mails: StoredMail[] }>();
  for (const mail of mails) {
    if (!isBulk(mail) && mail.bulk !== true) continue;
    bySender.set(mail.senderKey, [...(bySender.get(mail.senderKey) ?? []), mail]);
    const topic = mail.topic ?? "other";
    const key = groupKeyOf(mail.senderKey, topic);
    const entry = byGroup.get(key) ?? { senderKey: mail.senderKey, topic, mails: [] };
    entry.mails.push(mail);
    byGroup.set(key, entry);
  }
  const statsOf = (senderKey: string) => {
    const all = bySender.get(senderKey) ?? [];
    const bulk = all.filter(isBulk);
    const recent = (bulk.length === 0 ? all : bulk).filter((mail) => now - mail.receivedAt <= STATS_DAYS * DAY_MS);
    return { received: recent.length, discarded: recent.filter(isDiscarded).length };
  };
  return [...byGroup].map(([groupKey, { senderKey, topic, mails: all }]) => {
    // 人からのメールの側に移したものは、まとまりを残すためだけに数え、未処理や名前・種類には使わない
    const group = all.filter(isBulk);
    const sorted = (group.length === 0 ? all : group).toSorted(byReceived);
    const { received, discarded } = statsOf(senderKey);
    const notifications = group.filter((mail) => mail.kind === "notification").length;
    return {
      groupKey,
      topic,
      senderKey,
      senderName: sorted.at(-1)!.senderName,
      kind: notifications * 2 > group.length ? "notification" : "newsletter",
      pending: group.toSorted(byReceived).filter(isPending).map((mail) => mail.messageId),
      pendingSubjects: group.toSorted(byReceived).filter(isPending).map((mail) => mail.subject).toReversed(),
      pendingReceivedAt: group.toSorted(byReceived).filter(isPending).map((mail) => mail.receivedAt).toReversed(),
      pastInvites: group.toSorted(byReceived).filter((mail) => isPending(mail) && mail.pastInvite).map((mail) => mail.messageId),
      received,
      discarded,
      suggestUnsubscribe: received >= MIN_RECEIVED_FOR_SUGGESTION && discarded >= received * DISCARD_RATIO_FOR_SUGGESTION,
    };
  });
}

export type PersonalThread = {
  threadId: string;
  subject: string;
  messageIds: ReadonlyArray<string>;
  /** 受信トレイに残っていて、最後のメールが自分のものではない */
  open: boolean;
  /** 受信トレイに残っている、日程が過ぎた招待 */
  pastInvites: ReadonlyArray<string>;
};

export function personalThreads(mails: ReadonlyArray<StoredMail>, options: { invitesHandledElsewhere?: boolean } = {}): PersonalThread[] {
  const awaitsReply = (mail: StoredMail) => isPending(mail) && !(options.invitesHandledElsewhere === true && mail.upcomingInvite === true);
  const byThread = new Map<string, StoredMail[]>();
  for (const mail of mails) {
    if (mail.kind !== "personal" && mail.kind !== "mine") continue;
    byThread.set(mail.threadId, [...(byThread.get(mail.threadId) ?? []), mail]);
  }
  return [...byThread].flatMap(([threadId, group]) => {
    const sorted = group.toSorted(byReceived);
    const personal = sorted.filter((mail) => mail.kind === "personal");
    if (personal.length === 0) return [];
    const live = sorted.filter((mail) => !mail.trashed);
    const last = live.at(-1);
    return [
      {
        threadId,
        subject: personal.at(-1)!.subject,
        messageIds: sorted.map((mail) => mail.messageId),
        open: last !== undefined && last.kind !== "mine" && personal.some(awaitsReply),
        pastInvites: sorted.filter((mail) => isPending(mail) && mail.pastInvite).map((mail) => mail.messageId),
      },
    ];
  });
}

/** 日程が過ぎた（または取り消された）招待か。終わりが決まっていない予定は過ぎない */
export const isPastInvite = (invite: { inviteState: "ends" | "open" | "cancelled" | null; inviteEndsAt: number | null }, now: number) =>
  invite.inviteState === "cancelled" || (invite.inviteState === "ends" && invite.inviteEndsAt !== null && invite.inviteEndsAt < now);

/** 日程がまだ先の招待か。終わりが決まっていない予定もまだ先とみなす */
export const isUpcomingInvite = (invite: { inviteState: "ends" | "open" | "cancelled" | null; inviteEndsAt: number | null }, now: number) =>
  invite.inviteState === "open" || (invite.inviteState === "ends" && invite.inviteEndsAt !== null && invite.inviteEndsAt >= now);

// これ以上の確率で対応を求めていれば、メルマガ・お知らせでも人からのメールとして読ませる（迷うものは読む側に倒す）
const ACTION_MIN_PROBABILITY = 0.5;

/** 対応を求めるメルマガ・お知らせ（住所の確認のお願いなど）は、送り主にまとめず人からのメールとして扱う */
export const effectiveKind = (mail: { kind: StoredMail["kind"]; actionChecked: boolean; actionProbability: number | null }): StoredMail["kind"] =>
  (mail.kind === "newsletter" || mail.kind === "notification") && mail.actionChecked && (mail.actionProbability === null || mail.actionProbability >= ACTION_MIN_PROBABILITY)
    ? "personal"
    : mail.kind;
