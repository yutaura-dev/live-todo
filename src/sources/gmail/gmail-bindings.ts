import { asc, eq } from "drizzle-orm";
import { DateTime, Effect, Schema } from "effect";
import { Database } from "../../core/db/database.js";
import { gmailMessages } from "../../core/db/schema.js";
import type { TodoJudgment } from "../../core/judge/todo-judge.js";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import { diffSnapshot, type DuplicateExternalIdError } from "../../core/sync/snapshot-differ.js";
import type { SourceBinding } from "../../core/sync/sync-source.js";
import { type PersonalThread, personalThreads, type SenderGroup, senderGroups, type StoredMail } from "./gmail-mailbox.js";

export const gmailSendersSource = (accountId: string) => `gmail:${accountId}:senders`;
export const gmailThreadsSource = (accountId: string) => `gmail:${accountId}:threads`;

const SnapshotCursor = Schema.Struct({ fingerprints: Schema.Record(Schema.String, Schema.String) });
type SnapshotCursor = typeof SnapshotCursor.Type;

// アカウントを URL に入れない理由: メールアドレスを URL に持たせず、ブラウザで開いているアカウントに任せるため
const GMAIL_URL = "https://mail.google.com/mail/u/0/";

const loadMails = Effect.fnUntraced(function* (accountId: string) {
  const db = yield* Database;
  const rows = yield* db.select().from(gmailMessages).where(eq(gmailMessages.accountId, accountId)).orderBy(asc(gmailMessages.receivedAt)).pipe(Effect.orDie);
  return rows.map(
    (row): StoredMail => ({
      messageId: row.messageId,
      threadId: row.threadId,
      senderKey: row.senderKey,
      senderName: row.senderName,
      subject: row.subject,
      receivedAt: row.receivedAt,
      kind: row.kind,
      inInbox: row.inInbox,
      unread: row.unread,
      trashed: row.trashed,
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

const senderTitle = (group: SenderGroup) => `${group.senderName} の${group.kind === "newsletter" ? "メルマガ" : "お知らせ"}（未処理 ${group.pending.length} 通）`;
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
  const identify = (item: SenderItem) => ({ externalId: item.senderKey, fingerprint: senderFingerprint(item) });

  return {
    source: gmailSendersSource(options.accountId),
    adapter: snapshotAdapter(snapshot, identify),
    cursorSchema: SnapshotCursor,
    externalIdOf: (item: SenderItem) => item.senderKey,
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
