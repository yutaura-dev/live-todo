import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { DateTime, Effect, Option, Schema } from "effect";
import { Database } from "../../core/db/database.js";
import { gmailMessages } from "../../core/db/schema.js";
import { type MailClassification, MailClassifier } from "../../core/judge/mail-classifier.js";

/** 保存する仕分けの結果。sender は、同じ送り主の前の結果を使い回したもの */
type StoredClassification = Omit<MailClassification, "method"> & { method: MailClassification["method"] | "sender" };
import { SourceItemRepository } from "../../core/source/source-item-repository.js";
import { GmailClient, type GmailMessage } from "./gmail-client.js";
import { senderKeyOf, senderNameOf } from "./gmail-mailbox.js";
import { inviteEndOf } from "./ics.js";

// 最初に取り込む範囲。送ったメール（返信したか）も含める
const FIRST_QUERY = "newer_than:14d -in:drafts -in:chats";
const MAX_PAGES = 5;
const FETCH_CONCURRENCY = 4;
// 前の判定をこの確率以上で決めていた送り主だけ、仕分けずに結果を使い回す
const REUSE_MIN_PROBABILITY = 0.8;

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

const labelsOf = (message: GmailMessage, now: string) => ({ inInbox: has(message, "INBOX"), unread: has(message, "UNREAD"), trashed: has(message, "TRASH"), updatedAt: now });

/** 仕分けの結果を使い回せるまとまり。同じ送り主でも、配信の解除の案内の有無が違えば別に仕分ける */
const isBulk = (message: GmailMessage) => message.headers["list-unsubscribe"] !== undefined;
const signatureOf = (message: GmailMessage) => (isBulk(message) ? JSON.stringify([senderKeyOf(message.headers), true]) : JSON.stringify(["single", message.id]));

const previousClassification = Effect.fnUntraced(function* (accountId: string, message: GmailMessage) {
  const db = yield* Database;
  const [row] = yield* db
    .select({ kind: gmailMessages.kind, probability: gmailMessages.probability, listUnsubscribe: gmailMessages.listUnsubscribe })
    .from(gmailMessages)
    .where(and(eq(gmailMessages.accountId, accountId), eq(gmailMessages.senderKey, senderKeyOf(message.headers)), ne(gmailMessages.kind, "mine"), isNotNull(gmailMessages.probability)))
    .orderBy(desc(gmailMessages.receivedAt))
    .limit(1)
    .pipe(Effect.orDie);
  if (row === undefined || row.kind === "mine" || row.probability === null || row.probability < REUSE_MIN_PROBABILITY) return Option.none<StoredClassification>();
  if ((row.listUnsubscribe !== null) !== isBulk(message)) return Option.none<StoredClassification>();
  // 案内のないメールに使い回すのは、人からのメールという結果だけ（読む側に倒れるので、見落としにならない）
  if (!isBulk(message) && row.kind !== "personal") return Option.none<StoredClassification>();
  return Option.some<StoredClassification>({ kind: row.kind, probability: row.probability, method: "sender" });
});

// 予定のファイルを読むのは受信トレイの招待のメールだけで、1 通につき 1 回（本文の全体を取るので数を絞る）
const INVITE_QUERY = "in:inbox filename:ics";

const checkInvites = Effect.fnUntraced(function* (accountId: string, ids: ReadonlyArray<string>, now: string) {
  const client = yield* GmailClient;
  const db = yield* Database;
  if (ids.length === 0) return;
  const unchecked = yield* db
    .select({ messageId: gmailMessages.messageId })
    .from(gmailMessages)
    .where(and(eq(gmailMessages.accountId, accountId), eq(gmailMessages.inviteChecked, false), inArray(gmailMessages.messageId, [...ids])))
    .pipe(Effect.orDie);
  yield* Effect.forEach(
    unchecked,
    ({ messageId }) =>
      Effect.gen(function* () {
        const result = yield* client.calendar(messageId).pipe(Effect.result);
        // 読めなかったら次の回にやり直す（予定のファイル 1 通のために、取り込み全体を止めない）
        if (result._tag === "Failure") return yield* Effect.logWarning("招待の予定のファイルを読めなかった").pipe(Effect.annotateLogs({ reason: result.failure.message }));
        const calendar = result.success;
        const end = Option.map(calendar, inviteEndOf);
        yield* db
          .update(gmailMessages)
          .set({
            inviteChecked: true,
            inviteState: Option.isSome(end) ? end.value.kind : null,
            inviteEndsAt: Option.isSome(end) && end.value.kind === "ends" ? end.value.at : null,
            updatedAt: now,
          })
          .where(and(eq(gmailMessages.accountId, accountId), eq(gmailMessages.messageId, messageId)))
          .pipe(Effect.orDie);
      }),
    { concurrency: FETCH_CONCURRENCY },
  );
});

/** 受信トレイのメルマガ・お知らせが、受け取った本人に対応を求めているかを 1 通ずつ判定する（送り主ごとに使い回さない） */
const checkActions = Effect.fnUntraced(function* (accountId: string, now: string) {
  const classifier = yield* MailClassifier;
  const db = yield* Database;
  const rows = yield* db
    .select({
      messageId: gmailMessages.messageId,
      senderName: gmailMessages.senderName,
      senderKey: gmailMessages.senderKey,
      subject: gmailMessages.subject,
      listUnsubscribe: gmailMessages.listUnsubscribe,
      actionChecked: gmailMessages.actionChecked,
    })
    .from(gmailMessages)
    .where(
      and(
        eq(gmailMessages.accountId, accountId),
        or(eq(gmailMessages.actionChecked, false), isNull(gmailMessages.topic)),
        eq(gmailMessages.inInbox, true),
        inArray(gmailMessages.kind, ["newsletter", "notification"]),
      ),
    )
    .pipe(Effect.orDie);
  yield* Effect.forEach(
    rows,
    (row) =>
      Effect.gen(function* () {
        const answer = yield* classifier.needsAction({
          input: [`差出人: ${row.senderName} <${row.senderKey}>`, `件名: ${row.subject}`].join("\n"),
          context: `List-Unsubscribe: ${row.listUnsubscribe === null ? "なし" : "あり"}`,
        });
        yield* db
          .update(gmailMessages)
          // 判定済みのメールは用件だけを足す（対応が要るかは、スレッドを読んで決め直したものを上書きしない）
          .set(row.actionChecked ? { topic: answer.topic, updatedAt: now } : { actionChecked: true, actionProbability: answer.probability ?? null, topic: answer.topic, updatedAt: now })
          .where(and(eq(gmailMessages.accountId, accountId), eq(gmailMessages.messageId, row.messageId)))
          .pipe(Effect.orDie);
      }),
    { concurrency: FETCH_CONCURRENCY },
  );
});

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
  const inviteIds = (yield* client.listMessages(INVITE_QUERY)).ids;
  const ids = [...new Set([...changed.ids, ...inviteIds])];
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

  const fetched = yield* Effect.forEach(ids, (id) => client.message(id).pipe(Effect.map((found) => [id, found] as const)), { concurrency: FETCH_CONCURRENCY });
  const fresh: GmailMessage[] = [];
  for (const [id, found] of fetched) {
    if (Option.isNone(found)) {
      yield* markTrashed([id]);
      continue;
    }
    const message = found.value;
    if (known.has(id)) {
      yield* db
        .update(gmailMessages)
        .set(labelsOf(message, now))
        .where(and(eq(gmailMessages.accountId, options.accountId), eq(gmailMessages.messageId, id)))
        .pipe(Effect.orDie);
    } else if (!has(message, "DRAFT")) fresh.push(message);
  }

  // 配信の解除の案内があるメールは送り主ごとに 1 回だけ仕分ける（大量配信の送り主は、ほぼ必ずこの案内を付けるため）。
  // 案内がないメールは 1 通ずつ仕分ける: 最初がカレンダーの招待だった同僚や、差出人を偽ったメールの結果で、人が書いたメールを埋もれさせないため。
  // 複数のメールを 1 回の呼び出しにまとめないのは、あるメールに書かれた文で隣のメールの判定まで動かされないようにするため
  const bySignature = new Map<string, GmailMessage[]>();
  for (const message of fresh) {
    if (has(message, "SENT")) continue;
    const key = signatureOf(message);
    bySignature.set(key, [...(bySignature.get(key) ?? []), message]);
  }
  const classified = new Map(
    yield* Effect.forEach(
      [...bySignature],
      ([key, messages]) =>
        Effect.gen(function* () {
          const reused = yield* previousClassification(options.accountId, messages[0]!);
          if (Option.isSome(reused)) return [key, { first: reused.value, rest: reused.value }] as const;
          const first = yield* classifier.classify(classificationRequest(messages.at(-1)!));
          const rest: StoredClassification = first.method === "decisions" ? { ...first, method: "sender" } : first;
          return [key, { first: first as StoredClassification, rest }] as const;
        }),
      { concurrency: FETCH_CONCURRENCY },
    ),
  );

  for (const message of fresh) {
    const group = has(message, "SENT") ? undefined : classified.get(signatureOf(message));
    const classification = group === undefined ? undefined : bySignature.get(signatureOf(message))!.at(-1) === message ? group.first : group.rest;
    yield* db
      .insert(gmailMessages)
      .values({
        accountId: options.accountId,
        messageId: message.id,
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
        ...labelsOf(message, now),
      })
      .onConflictDoNothing()
      .pipe(Effect.orDie);
  }
  yield* markTrashed(changed.deleted);
  yield* checkInvites(options.accountId, inviteIds, now);
  yield* checkActions(options.accountId, now);
  yield* items.saveCursor(source, { historyId: changed.historyId });
  return { fetched: ids.length };
});
