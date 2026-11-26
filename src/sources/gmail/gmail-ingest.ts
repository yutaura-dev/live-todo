import { and, eq, inArray } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { Database } from "../../core/db/database.js";
import { gmailMessages } from "../../core/db/schema.js";
import { MailClassifier } from "../../core/judge/mail-classifier.js";
import { SourceItemRepository } from "../../core/source/source-item-repository.js";
import { GmailClient, type GmailMessage } from "./gmail-client.js";
import { senderKeyOf, senderNameOf } from "./gmail-mailbox.js";

// 最初に取り込む範囲。送ったメール（返信したか）も含める
const FIRST_QUERY = "newer_than:14d -in:drafts -in:chats";
const MAX_PAGES = 5;
const FETCH_CONCURRENCY = 4;

const CATEGORY_LABELS: Record<string, string> = {
  CATEGORY_PERSONAL: "メイン",
  CATEGORY_PROMOTIONS: "プロモーション",
  CATEGORY_UPDATES: "新着",
  CATEGORY_SOCIAL: "ソーシャル",
  CATEGORY_FORUMS: "フォーラム",
};

const HistoryCursor = Schema.Struct({ historyId: Schema.String });

export const gmailHistorySource = (accountId: string) => `gmail:${accountId}:history`;

const has = (message: GmailMessage, label: string) => message.labelIds.includes(label);

const classificationRequest = (message: GmailMessage) => {
  const { headers } = message;
  const categories = message.labelIds.flatMap((label) => (CATEGORY_LABELS[label] === undefined ? [] : [CATEGORY_LABELS[label]]));
  return {
    input: [`差出人: ${headers.from ?? ""}`, `件名: ${headers.subject ?? ""}`].join("\n"),
    context: [
      `Gmail のカテゴリ: ${categories.length === 0 ? "なし" : categories.join("・")}`,
      `List-Unsubscribe: ${headers["list-unsubscribe"] === undefined ? "なし" : "あり"}`,
      `List-Id: ${headers["list-id"] === undefined ? "なし" : "あり"}`,
      ...(headers.precedence === undefined ? [] : [`Precedence: ${headers.precedence}`]),
      ...(headers["auto-submitted"] === undefined ? [] : [`Auto-Submitted: ${headers["auto-submitted"]}`]),
    ].join("\n"),
  };
};

/**
 * Gmail のメールを取り込み、新しいメールを仕分けて gmail_messages に保存する。2 回目からは履歴の差分だけを見る。
 * 送り主ごと・スレッドごとの Source Item は、この表から別に作る
 */
export const ingestGmail = Effect.fnUntraced(function* (options: { accountId: string }) {
  const client = yield* GmailClient;
  const classifier = yield* MailClassifier;
  const db = yield* Database;
  const items = yield* SourceItemRepository;
  const source = gmailHistorySource(options.accountId);

  const listRecent = Effect.gen(function* () {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = yield* client.listMessages(FIRST_QUERY, pageToken);
      ids.push(...result.ids);
      pageToken = result.nextPageToken;
      if (pageToken === undefined) break;
    }
    return ids;
  });

  const cursor = Option.flatMap(yield* items.loadCursor(source), Schema.decodeUnknownOption(HistoryCursor));
  // 一覧を取る前に履歴の位置を覚える（取っている間に届いたメールを次の差分で拾うため）
  const startedAt = yield* client.historyId;
  const changed = Option.isNone(cursor)
    ? { historyId: startedAt, ids: yield* listRecent, deleted: [] as ReadonlyArray<string> }
    : yield* client.history(cursor.value.historyId).pipe(
        Effect.map((history) => ({ historyId: history.historyId, ids: [...history.added, ...history.labelsChanged], deleted: history.deleted })),
        Effect.catchTag("GmailHistoryExpiredError", () => listRecent.pipe(Effect.map((ids) => ({ historyId: startedAt, ids, deleted: [] as ReadonlyArray<string> })))),
      );

  const now = DateTime.formatIso(yield* DateTime.now);
  const ids = [...new Set(changed.ids)];
  const known = new Set(
    ids.length === 0
      ? []
      : (yield* db
          .select({ messageId: gmailMessages.messageId })
          .from(gmailMessages)
          .where(and(eq(gmailMessages.accountId, options.accountId), inArray(gmailMessages.messageId, ids)))
          .pipe(Effect.orDie)).map((row) => row.messageId),
  );

  const markTrashed = (messageIds: ReadonlyArray<string>) =>
    messageIds.length === 0
      ? Effect.void
      : db
          .update(gmailMessages)
          .set({ trashed: true, inInbox: false, updatedAt: now })
          .where(and(eq(gmailMessages.accountId, options.accountId), inArray(gmailMessages.messageId, [...messageIds])))
          .pipe(Effect.orDie, Effect.asVoid);

  yield* Effect.forEach(
    ids,
    (id) =>
      Effect.gen(function* () {
        const found = yield* client.message(id);
        if (Option.isNone(found)) return yield* markTrashed([id]);
        const message = found.value;
        const labels = { inInbox: has(message, "INBOX"), unread: has(message, "UNREAD"), trashed: has(message, "TRASH"), updatedAt: now };
        if (known.has(id)) {
          yield* db
            .update(gmailMessages)
            .set(labels)
            .where(and(eq(gmailMessages.accountId, options.accountId), eq(gmailMessages.messageId, id)))
            .pipe(Effect.orDie);
          return;
        }
        if (has(message, "DRAFT")) return;
        const classification = has(message, "SENT") ? undefined : yield* classifier.classify(classificationRequest(message));
        yield* db
          .insert(gmailMessages)
          .values({
            accountId: options.accountId,
            messageId: id,
            threadId: message.threadId,
            senderKey: senderKeyOf(message.headers),
            senderName: senderNameOf(message.headers),
            subject: message.headers.subject ?? "",
            receivedAt: message.receivedAt,
            kind: classification?.kind ?? "mine",
            probability: classification?.probability ?? null,
            method: classification?.method ?? null,
            listUnsubscribe: message.headers["list-unsubscribe"] ?? null,
            listUnsubscribePost: message.headers["list-unsubscribe-post"] ?? null,
            ...labels,
          })
          .onConflictDoNothing()
          .pipe(Effect.orDie);
      }),
    { concurrency: FETCH_CONCURRENCY },
  );
  yield* markTrashed(changed.deleted);
  yield* items.saveCursor(source, { historyId: changed.historyId });
  return { fetched: ids.length };
});
