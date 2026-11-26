import { asc, eq } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";
import { Database } from "../../core/db/database.js";
import { gmailMessages, sourceItems, taskLinks, tasks } from "../../core/db/schema.js";
import { MAIL_TOPIC_LABELS } from "../../core/judge/mail-classifier.js";
import { TaskRepository } from "../../core/task/task-repository.js";
import type { TodoJudgment } from "../../core/judge/todo-judge.js";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import { diffSnapshot, type DuplicateExternalIdError } from "../../core/sync/snapshot-differ.js";
import type { SourceBinding } from "../../core/sync/sync-source.js";
import { effectiveKind, isPastInvite, type PersonalThread, personalThreads, type SenderGroup, senderGroups, type StoredMail } from "./gmail-mailbox.js";

export const gmailSendersSource = (accountId: string) => `gmail:${accountId}:senders`;
export const gmailThreadsSource = (accountId: string) => `gmail:${accountId}:threads`;

const SnapshotCursor = Schema.Struct({ fingerprints: Schema.Record(Schema.String, Schema.String) });
type SnapshotCursor = typeof SnapshotCursor.Type;

// アカウントを URL に入れない理由: メールアドレスを URL に持たせず、ブラウザで開いているアカウントに任せるため
const GMAIL_URL = "https://mail.google.com/mail/u/0/";

export const loadMails = Effect.fnUntraced(function* (accountId: string) {
  const db = yield* Database;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const rows = yield* db.select().from(gmailMessages).where(eq(gmailMessages.accountId, accountId)).orderBy(asc(gmailMessages.receivedAt)).pipe(Effect.orDie);
  return rows.map(
    (row): StoredMail => ({
      messageId: row.messageId,
      threadId: row.threadId,
      senderKey: row.senderKey,
      senderName: row.senderName,
      subject: row.subject,
      receivedAt: row.receivedAt,
      kind: effectiveKind(row),
      bulk: row.kind === "newsletter" || row.kind === "notification",
      topic: row.topic,
      inInbox: row.inInbox,
      unread: row.unread,
      trashed: row.trashed,
      pastInvite: isPastInvite(row, now),
    }),
  );
});

const snapshotAdapter = <TItem>(snapshot: Effect.Effect<ReadonlyArray<TItem>>, identify: (item: TItem) => { externalId: string; fingerprint: string }): SourceAdapter<TItem, SnapshotCursor, DuplicateExternalIdError> => ({
  fetchChanges: (cursor) =>
    Effect.gen(function* () {
      const { changes, nextFingerprints } = yield* diffSnapshot(new Map(Object.entries(cursor?.fingerprints ?? {})), yield* snapshot, identify);
      return { changes, nextCursor: { fingerprints: Object.fromEntries(nextFingerprints) } };
    }),
});

export type SenderItem = SenderGroup & { title: string };

const MAX_SUBJECT = 50;
const MAX_BRIEF_SUBJECTS = 10;
const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const subjectText = (subject: string) => (subject.trim() === "" ? "（件名なし）" : subject.trim());

// 最新の件名を入れる理由: 送り主の名前と通数だけでは、何のお知らせか開くまで分からないため
const senderTitle = (group: SenderGroup) => {
  const label = `${group.senderName} の${group.topic === "other" ? (group.kind === "newsletter" ? "メルマガ" : "お知らせ") : MAIL_TOPIC_LABELS[group.topic]}`;
  const [latest] = group.pendingSubjects;
  if (latest === undefined) return label;
  const others = group.pendingSubjects.length - 1;
  return `${label}: ${shorten(subjectText(latest), MAX_SUBJECT)}${others > 0 ? `（ほか ${others} 通）` : ""}`;
};

// 端末のタイムゾーンでの月日（届いた日が分かるように）
const monthDay = (millis: number) => new Date(millis).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });

const senderBrief = (group: SenderGroup) => {
  const shown = group.pendingSubjects.slice(0, MAX_BRIEF_SUBJECTS).map((subject, index) => `- ${monthDay(group.pendingReceivedAt[index] ?? 0)} ${subjectText(subject)}`);
  const rest = group.pendingSubjects.length - shown.length;
  return ["受信トレイに残っているメール（新しい順）:", ...shown, ...(rest > 0 ? [`- ほか ${rest} 通`] : [])].join("\n");
};

/**
 * 送り主の Task の状況（brief）に、受信トレイに残っているメールの件名を並べ直す。
 * Source Item には状況の欄がないので、まとめ直したあとに別に書く。変わるたびに書くので履歴には残さない
 */
export const refreshSenderBriefs = Effect.fnUntraced(function* (accountId: string) {
  const db = yield* Database;
  const groups = senderGroups(yield* loadMails(accountId), DateTime.toEpochMillis(yield* DateTime.now));
  const linked = yield* db
    .select({ taskId: tasks.id, brief: tasks.brief, externalId: sourceItems.externalId })
    .from(taskLinks)
    .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(eq(sourceItems.source, gmailSendersSource(accountId)))
    .pipe(Effect.orDie);
  const bySender = new Map(groups.map((group) => [group.groupKey, group]));
  const taskRepository = yield* TaskRepository;
  for (const row of linked) {
    const group = bySender.get(row.externalId);
    if (group === undefined || group.pendingSubjects.length === 0) continue;
    const brief = senderBrief(group);
    if (brief !== row.brief) yield* taskRepository.updateTask(row.taskId, { brief });
  }
});
const senderSearch = (senderKey: string) => (senderKey.includes("@") ? `from:${senderKey}` : `list:${senderKey}`);
const senderFingerprint = (item: SenderItem) => JSON.stringify([item.title, item.pending, item.suggestUnsubscribe]);
const RULE_JUDGMENT: TodoJudgment = { verdict: "todo", method: "rule" };

/** メルマガ・お知らせを送り主ごとの Source Item にする。未処理のメールがある間は open */
export const makeGmailSendersBinding = Effect.fnUntraced(function* (options: { accountId: string }) {
  const db = yield* Database;
  const snapshot = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return senderGroups(yield* loadMails(options.accountId), now).map((group): SenderItem => ({ ...group, title: senderTitle(group) }));
  }).pipe(Effect.provideService(Database, db));
  const identify = (item: SenderItem) => ({ externalId: item.groupKey, fingerprint: senderFingerprint(item) });

  return {
    source: gmailSendersSource(options.accountId),
    adapter: snapshotAdapter(snapshot, identify),
    cursorSchema: SnapshotCursor,
    externalIdOf: (item: SenderItem) => item.groupKey,
    toItemDraft: (item: SenderItem) => ({
      title: item.title,
      url: `${GMAIL_URL}#search/${encodeURIComponent(`in:inbox ${senderSearch(item.senderKey)}`)}`,
      state: item.pending.length > 0 ? ("open" as const) : ("resolved" as const),
      fingerprint: senderFingerprint(item),
    }),
    // メルマガ・お知らせは受信トレイに残っていれば片付ける対象なので、判定せずに Task にする
    judge: () => Effect.succeed(RULE_JUDGMENT),
    taskTitleFollowsItem: true,
  } satisfies SourceBinding<SenderItem, SnapshotCursor, DuplicateExternalIdError, never, never>;
});

const threadFingerprint = (thread: PersonalThread) => JSON.stringify([thread.subject, thread.open, thread.messageIds]);

/** 人からのメールをスレッドごとの Source Item にする。何をする Task かは、あとで Claude Code がスレッドを読んで決める */
export const makeGmailThreadsBinding = Effect.fnUntraced(function* (options: { accountId: string }) {
  const db = yield* Database;
  const snapshot = loadMails(options.accountId).pipe(Effect.map(personalThreads), Effect.provideService(Database, db));
  const identify = (thread: PersonalThread) => ({ externalId: thread.threadId, fingerprint: threadFingerprint(thread) });

  return {
    source: gmailThreadsSource(options.accountId),
    adapter: snapshotAdapter(snapshot, identify),
    cursorSchema: SnapshotCursor,
    externalIdOf: (thread: PersonalThread) => thread.threadId,
    toItemDraft: (thread: PersonalThread) => ({
      title: thread.subject.trim() === "" ? "（件名なし）" : thread.subject,
      url: `${GMAIL_URL}#all/${thread.threadId}`,
      state: thread.open ? ("open" as const) : ("resolved" as const),
      fingerprint: threadFingerprint(thread),
    }),
    judge: () => Effect.succeed(RULE_JUDGMENT),
    deferTriage: true,
  } satisfies SourceBinding<PersonalThread, SnapshotCursor, DuplicateExternalIdError, never, never>;
});
