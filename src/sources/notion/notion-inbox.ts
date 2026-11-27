import { DateTime, Effect, Option, Schema } from "effect";
import { DEFAULT_TODO_THRESHOLDS, makeTodoJudge, type TodoJudgeThresholds } from "../../core/judge/todo-judge.js";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import type { SourceChange } from "../../core/sync/source-change.js";
import type { SourceBinding } from "../../core/sync/sync-source.js";
import { NotionClient, type NotionClientError } from "./notion-client.js";
import { compactId, type NotionRecordMap, richTextToPlain, type RichTextNames } from "./notion-records.js";

export type NotionInboxKind = "mention" | "comment" | "reminder";

export type NotionInboxItem = {
  externalId: string;
  kind: NotionInboxKind;
  pageId: string;
  pageTitle: string;
  /** コメントの通知なら、そのスレッド */
  discussionId: string | undefined;
  author: string | undefined;
  /** コメントの本文、またはメンションされたブロックの文 */
  text: string;
  /** 通知の時刻（Unix ミリ秒） */
  at: number;
  /** スレッドが解決された、自分があとから同じスレッドに書いた、または通知が無効になった */
  resolved: boolean;
  title: string;
  url: string;
};

export const NotionInboxCursorSchema = Schema.Struct({
  /** これより前（Unix ミリ秒）の通知は Task にしない。最初の取り込みで決め、あとでタイトルが変わっても古い通知を Task にしないため */
  since: Schema.optionalKey(Schema.Number),
  items: Schema.Record(Schema.String, Schema.Struct({ fingerprint: Schema.String, state: Schema.Literals(["open", "resolved"]) })),
});
export type NotionInboxCursor = typeof NotionInboxCursorSchema.Type;

const Time = Schema.Union([Schema.String, Schema.Number]);
const Notification = Schema.Struct({
  id: Schema.String,
  activity_id: Schema.String,
  navigable_block_id: Schema.optional(Schema.String),
  invalid: Schema.optional(Schema.Boolean),
  end_time: Schema.optional(Time),
});
const Edit = Schema.Struct({
  authors: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
  discussion_id: Schema.optional(Schema.String),
  comment_data: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.Unknown) })),
});
const Activity = Schema.Struct({
  type: Schema.String,
  navigable_block_id: Schema.optional(Schema.String),
  mentioned_block_id: Schema.optional(Schema.String),
  // 表の行のセルや DB のプロパティでのメンションなら、そのプロパティのキー（ページタイトルなら "title"）
  mentioned_property: Schema.optional(Schema.String),
  end_time: Schema.optional(Time),
  edits: Schema.optional(Schema.Array(Edit)),
});
const Block = Schema.Struct({ id: Schema.String, properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) });
const User = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  given_name: Schema.optional(Schema.String),
  family_name: Schema.optional(Schema.String),
});
const Discussion = Schema.Struct({ resolved: Schema.optional(Schema.Boolean), comments: Schema.optional(Schema.Array(Schema.String)) });
const Comment = Schema.Struct({ created_by_id: Schema.optional(Schema.String), created_time: Schema.optional(Schema.Number) });

const KINDS: Readonly<Record<string, NotionInboxKind>> = { "user-mentioned": "mention", commented: "comment", reminder: "reminder" };
const KIND_LABELS: Record<NotionInboxKind, string> = { mention: "自分へのメンション", comment: "自分が関わるページかスレッドへのコメント", reminder: "自分で付けたリマインダー" };
const FALLBACK_LINES: Record<NotionInboxKind, string> = { mention: "Notion のメンション", comment: "Notion のコメント", reminder: "Notion のリマインダー" };
const FALLBACK_PAGE_TITLE = "Notion のページ";
const NOTION_LINK_ORIGIN = "https://www.notion.so";

// 1 回に取る件数（ワークスペースごと）。通知は新しい順なので、同期の間隔（3 分）に届く数より十分に多ければ足りる
const PAGE_SIZE = 50;
// 最初の取り込みで Task にする期間。それより前は見たことだけ覚える（Slack の受信と同じ）
const FIRST_RUN_DAYS = 3;
const NOTION_TODO_QUESTION = "信頼できる情報にある Notion のユーザー本人が、この通知の内容に返信・作業・判断などの対応をする必要があるか？";

export const notionInboxSourceName = (accountId: string) => `notion:${accountId}:inbox`;

const recordOf = <A>(recordMap: NotionRecordMap, table: string, id: string | undefined, schema: Schema.Decoder<A>): Option.Option<A> =>
  id === undefined ? Option.none() : Option.flatMap(Option.fromNullishOr(recordMap[table]?.[id]), Schema.decodeUnknownOption(schema));

const firstLine = (text: string) => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";

function namesIn(recordMap: NotionRecordMap): RichTextNames {
  const users = new Map<string, string>();
  for (const record of Object.values(recordMap["notion_user"] ?? {})) {
    const user = Schema.decodeUnknownOption(User)(record);
    if (Option.isNone(user)) continue;
    const name = user.value.name ?? [user.value.family_name, user.value.given_name].filter((part) => part !== undefined).join(" ");
    if (name !== "") users.set(user.value.id, name);
  }
  const pages = new Map<string, string>();
  for (const record of Object.values(recordMap["block"] ?? {})) {
    const block = Schema.decodeUnknownOption(Block)(record);
    if (Option.isNone(block)) continue;
    const title = richTextToPlain(block.value.properties?.["title"], { users, pages: new Map() }).trim();
    if (title !== "") pages.set(block.value.id, title);
  }
  return { users, pages };
}

/**
 * メンションされたブロックの文。ページタイトル以外のプロパティでのメンション（DB の担当者・表のセルなど）は、
 * そのセルだけでは「@自分」しか残らないので、ページならタイトル、表の行なら行のセル全部を使う
 */
function mentionedText(block: typeof Block.Type, property: string | undefined, names: RichTextNames): string {
  const properties = block.properties ?? {};
  const title = richTextToPlain(properties["title"], names).trim();
  if (property === undefined || property === "title" || title !== "") return title;
  return Object.values(properties)
    .map((value) => richTextToPlain(value, names).trim())
    .filter((text) => text !== "")
    .join(" / ");
}

/** 受信トレイの応答から、メンション・コメント・リマインダーの通知を項目にする。それ以外と、形の分からない通知は除く */
export function inboxItemsFrom(me: string, log: { notificationIds: ReadonlyArray<string>; recordMap: NotionRecordMap }): { items: NotionInboxItem[]; malformed: number } {
  const { recordMap } = log;
  const names = namesIn(recordMap);
  const items: NotionInboxItem[] = [];
  let malformed = 0;
  for (const notificationId of log.notificationIds) {
    const notification = recordOf(recordMap, "notification", notificationId, Notification);
    const activity = Option.flatMap(notification, (found) => recordOf(recordMap, "activity", found.activity_id, Activity));
    if (Option.isNone(notification) || Option.isNone(activity)) {
      malformed++;
      continue;
    }
    const kind = KINDS[activity.value.type];
    const pageId = notification.value.navigable_block_id ?? activity.value.navigable_block_id;
    if (kind === undefined || pageId === undefined) continue;

    const edits = activity.value.edits ?? [];
    const commentEdit = edits.findLast((edit) => edit.comment_data?.text !== undefined || edit.discussion_id !== undefined);
    const mentionedBlock = recordOf(recordMap, "block", activity.value.mentioned_block_id, Block);
    const commentText = commentEdit?.comment_data?.text;
    const text =
      commentText !== undefined
        ? richTextToPlain(commentText, names).trim()
        : Option.match(mentionedBlock, { onNone: () => "", onSome: (block) => mentionedText(block, activity.value.mentioned_property, names) });
    const at = Number(notification.value.end_time ?? activity.value.end_time ?? 0);
    const authorId = (commentEdit ?? edits[0])?.authors?.[0]?.id;
    const discussionId = commentEdit?.discussion_id;

    const discussion = recordOf(recordMap, "discussion", discussionId, Discussion);
    const answered = Option.exists(discussion, (found) =>
      (found.comments ?? []).some((commentId) =>
        Option.exists(recordOf(recordMap, "comment", commentId, Comment), (comment) => comment.created_by_id === me && (comment.created_time ?? 0) > at),
      ),
    );
    const resolved = notification.value.invalid === true || Option.exists(discussion, (found) => found.resolved === true) || answered;

    const pageTitle = names.pages.get(pageId) ?? FALLBACK_PAGE_TITLE;
    const line = firstLine(text);
    items.push({
      externalId: notification.value.id,
      kind,
      pageId,
      pageTitle,
      discussionId,
      author: authorId === undefined || authorId === me ? undefined : names.users.get(authorId),
      text,
      at,
      resolved,
      // DB のページの担当者に入ったときなど、本文がページ名そのものならページ名だけにする
      title: line === pageTitle ? pageTitle : `${pageTitle}: ${line === "" ? FALLBACK_LINES[kind] : line}`,
      url: `${NOTION_LINK_ORIGIN}/${compactId(pageId)}${discussionId === undefined ? "" : `?d=${compactId(discussionId)}`}`,
    });
  }
  return { items, malformed };
}

// タイトルも含める理由: タイトルの作り方を直したときに、変化として Task まで伝えるため
const fingerprintOf = (item: NotionInboxItem) => JSON.stringify([item.resolved, item.title]);

/** Notion の受信トレイ（メンション・コメント・リマインダー）を Source にする（ADR-0015） */
export const makeNotionInboxBinding = Effect.fnUntraced(function* (options: { accountId: string; thresholds?: TodoJudgeThresholds }) {
  const client = yield* NotionClient;
  // 判定に渡す「自分」。取り込みのたびに取り直したものを使う
  let myName = "";

  const adapter: SourceAdapter<NotionInboxItem, NotionInboxCursor, NotionClientError> = {
    fetchChanges: (cursor) =>
      Effect.gen(function* () {
        const previous = cursor ?? { items: {} };
        // since のないカーソル（境目を残す前に保存したもの）も、今から 3 日前を境目にする
        const since = previous.since ?? DateTime.toEpochMillis(DateTime.subtract(yield* DateTime.now, { days: FIRST_RUN_DAYS }));
        const me = yield* client.me;
        myName = me.name;

        const changes: SourceChange<NotionInboxItem>[] = [];
        // 応答に出てこなくなった通知（件数の外に出たもの）も覚えておく。消えたのではなく、古くなっただけなので
        const nextItems: Record<string, { fingerprint: string; state: "open" | "resolved" }> = { ...previous.items };
        for (const space of me.spaces) {
          const { items, malformed } = inboxItemsFrom(me.userId, yield* client.notifications(space.id, PAGE_SIZE));
          if (malformed > 0) yield* Effect.logWarning("形の分からない Notion の通知を取り込まなかった").pipe(Effect.annotateLogs({ count: malformed }));
          for (const item of items) {
            const fingerprint = fingerprintOf(item);
            if (previous.items[item.externalId]?.fingerprint !== fingerprint && item.at >= since) changes.push({ kind: "upserted", item });
            nextItems[item.externalId] = { fingerprint, state: item.resolved ? "resolved" : "open" };
          }
        }
        return { changes, nextCursor: { since, items: nextItems } };
      }),
  };

  const judge = yield* makeTodoJudge<NotionInboxItem>({
    // リマインダーは自分で付けたものなので、それ自体が自分の todo（LLM に問わない）
    rules: [(item) => item.kind === "reminder"],
    describe: (item) =>
      Effect.succeed({
        context: [`あなた（ユーザー本人）の Notion のユーザー: @${myName}`, `種類: ${KIND_LABELS[item.kind]}`, `ページ: ${item.pageTitle}`].join("\n"),
        input: item.text,
      }),
    question: NOTION_TODO_QUESTION,
    thresholds: options.thresholds ?? DEFAULT_TODO_THRESHOLDS,
  }).pipe(Effect.orDie);

  return {
    source: notionInboxSourceName(options.accountId),
    adapter,
    cursorSchema: NotionInboxCursorSchema,
    externalIdOf: (item: NotionInboxItem) => item.externalId,
    toItemDraft: (item: NotionInboxItem) => ({
      title: item.title,
      url: item.url,
      state: item.resolved ? ("resolved" as const) : ("open" as const),
      fingerprint: fingerprintOf(item),
      ...(item.author === undefined ? {} : { author: item.author }),
    }),
    judge,
    // タイトルは通知から機械的に作るので、作り方を直したら Task にも反映する（自分で書き換えたタイトルは変えない）
    taskTitleFollowsItem: true,
  } satisfies SourceBinding<NotionInboxItem, NotionInboxCursor, NotionClientError, unknown, unknown>;
});
