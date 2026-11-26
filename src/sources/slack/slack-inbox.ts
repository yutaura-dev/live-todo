import { DateTime, Effect, Option, Schema } from "effect";
import { DEFAULT_TODO_THRESHOLDS, makeTodoJudge, type TodoJudgeThresholds } from "../../core/judge/todo-judge.js";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import type { SourceChange } from "../../core/sync/source-change.js";
import type { SourceBinding } from "../../core/sync/sync-source.js";
import { SlackClient, type SlackClientError, type SlackSearchMatch } from "./slack-client.js";
import { mentionedIds, slackTitleLine } from "./slack-text.js";

export type InboxKind = "mention" | "group_mention" | "dm" | "thread_reply";

export type SlackInboxItem = {
  externalId: string;
  channel: string;
  channelName: string;
  isDirect: boolean;
  ts: string;
  threadTs: string | undefined;
  kind: InboxKind;
  author: string | undefined;
  text: string;
  /** 自分があとから返信した、または To-do・Saved にした */
  resolved: boolean;
  title: string;
  url: string;
};

export const SlackInboxCursorSchema = Schema.Struct({
  items: Schema.Record(Schema.String, Schema.Struct({ fingerprint: Schema.String, state: Schema.Literals(["open", "resolved"]) })),
});
export type SlackInboxCursor = typeof SlackInboxCursorSchema.Type;

export type InboxSources = {
  mentions: ReadonlyArray<SlackSearchMatch>;
  groupMentions: ReadonlyArray<SlackSearchMatch>;
  dms: ReadonlyArray<SlackSearchMatch>;
  threads: ReadonlyArray<SlackSearchMatch>;
  /** 自分の発言（返信して済んだか・どのスレッドにいるかを決める） */
  mine: ReadonlyArray<SlackSearchMatch>;
  /** To-do・Saved にしたメッセージ（item_id:ts） */
  savedKeys: ReadonlySet<string>;
};

const rootOf = (message: { ts: string; threadTs: string | undefined }) => message.threadTs ?? message.ts;
const after = (a: string, b: string) => Number(a) > Number(b);

/** 返事や対応が要りそうなメッセージを集め、自分があとから返信したか・To-do にしたかで済んだかを決める */
export function inboxItemsFrom(me: string, sources: InboxSources): Map<string, Omit<SlackInboxItem, "title" | "url">> {
  const items = new Map<string, Omit<SlackInboxItem, "title" | "url">>();
  const add = (message: SlackSearchMatch, kind: InboxKind) => {
    const externalId = `${message.channel}:${message.ts}`;
    if (message.user === me || items.has(externalId)) return;
    const resolved =
      sources.savedKeys.has(externalId) ||
      sources.mine.some(
        (mine) =>
          mine.channel === message.channel &&
          after(mine.ts, message.ts) &&
          // DM はスレッドでなくても、あとから同じ DM で書けば返事をしたとみなす
          ((message.isDirect && message.threadTs === undefined) || rootOf(mine) === rootOf(message)),
      );
    items.set(externalId, {
      externalId,
      channel: message.channel,
      channelName: message.channelName,
      isDirect: message.isDirect,
      ts: message.ts,
      threadTs: message.threadTs,
      kind,
      author: message.user,
      text: message.text,
      resolved,
    });
  };

  for (const message of sources.mentions) add(message, "mention");
  for (const message of sources.groupMentions) add(message, "group_mention");
  for (const message of sources.dms) add(message, "dm");

  // 自分が書いたスレッド（親か返信）と、そこに最初に書いた時刻
  const joined = new Map<string, string>();
  for (const mine of sources.mine) {
    const key = `${mine.channel}:${rootOf(mine)}`;
    const first = joined.get(key);
    if (first === undefined || after(first, mine.ts)) joined.set(key, mine.ts);
  }
  for (const message of sources.threads) {
    if (message.threadTs === undefined || message.threadTs === message.ts) continue;
    const since = joined.get(`${message.channel}:${message.threadTs}`);
    if (since !== undefined && after(message.ts, since)) add(message, "thread_reply");
  }
  return items;
}

// 探す期間。これより前のものは、前の状態のまま覚えておく
const LOOKBACK_DAYS = 14;
// 最初の取り込みで Task にする期間。それより前は見たことだけ覚える
const FIRST_RUN_DAYS = 3;
const MAX_PAGES = 3;
const KIND_LABELS: Record<InboxKind, string> = {
  mention: "自分へのメンション",
  group_mention: "自分が入っているユーザーグループへのメンション",
  dm: "自分宛ての DM",
  thread_reply: "自分が書いたスレッドへの返信",
};
const SLACK_TODO_QUESTION =
  "信頼できる情報にある Slack のユーザー本人が、このメッセージに返信・作業・判断などの対応をする必要があるか？";

export const slackInboxSourceName = (accountId: string) => `slack:${accountId}:inbox`;

const permalink = (workspace: string, item: { channel: string; ts: string; threadTs: string | undefined }) =>
  `https://${workspace}/archives/${item.channel}/p${item.ts.replace(".", "")}${
    item.threadTs !== undefined && item.threadTs !== item.ts ? `?thread_ts=${item.threadTs}&cid=${item.channel}` : ""
  }`;

const fingerprintOf = (item: SlackInboxItem) => JSON.stringify([item.resolved, item.title]);

/**
 * Slack のメンション・DM・自分のいるスレッドへの返信を、検索 API で取る Source（ADR-0010）。
 * ユーザーグループは増えたり減ったりするので、取り込みのたびに取り直す
 */
export const makeSlackInboxBinding = Effect.fnUntraced(function* (options: { accountId: string; workspace: string; thresholds?: TodoJudgeThresholds }) {
  const client = yield* SlackClient;
  // 判定に渡す「自分」。取り込みのたびに auth.test で取り直したものを使う
  let myUserId = "";

  const searchAll = Effect.fnUntraced(function* (query: string) {
    const matches: SlackSearchMatch[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = yield* client.searchMessages(query, page);
      matches.push(...result.matches);
      if (page >= result.pages) break;
    }
    return matches;
  });

  const savedKeys = Effect.gen(function* () {
    const keys = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = yield* client.savedList(cursor === undefined ? {} : { cursor });
      for (const entry of result.items) {
        if (typeof entry === "object" && entry !== null && "item_id" in entry && "ts" in entry) keys.add(`${String(entry.item_id)}:${String(entry.ts)}`);
      }
      if (result.nextCursor === "") break;
      cursor = result.nextCursor;
    }
    return keys;
  });

  const adapter: SourceAdapter<SlackInboxItem, SlackInboxCursor, SlackClientError> = {
    fetchChanges: (cursor) =>
      Effect.gen(function* () {
        const previous = cursor ?? { items: {} };
        const firstRunFrom = cursor === null ? DateTime.toEpochMillis(DateTime.subtract(yield* DateTime.now, { days: FIRST_RUN_DAYS })) / 1000 : 0;
        const me = yield* client.authTest;
        myUserId = me.userId;
        const groups = yield* client.myUserGroups(me.userId);
        const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: LOOKBACK_DAYS })).slice(0, 10);
        const within = (query: string) => searchAll(`${query} after:${since}`);

        const sources: InboxSources = {
          mentions: yield* within(`<@${me.userId}>`),
          groupMentions: (yield* Effect.forEach(groups, (group) => within(`<!subteam^${group.id}>`))).flat(),
          dms: yield* within("to:me"),
          mine: yield* within("from:me"),
          threads: yield* within("is:thread"),
          savedKeys: yield* savedKeys,
        };

        const names = new Map<string, string>();
        const changes: SourceChange<SlackInboxItem>[] = [];
        const nextItems: Record<string, { fingerprint: string; state: "open" | "resolved" }> = { ...previous.items };
        for (const found of inboxItemsFrom(me.userId, sources).values()) {
          for (const id of mentionedIds(found.text)) {
            if (names.has(id)) continue;
            const name = yield* client.userName(id).pipe(Effect.orElseSucceed(() => Option.none<string>()));
            if (Option.isSome(name)) names.set(id, name.value);
          }
          const line = slackTitleLine(found.text, { users: names });
          const prefix = found.isDirect ? "DM" : `#${found.channelName}`;
          const item: SlackInboxItem = { ...found, title: `${prefix}: ${line === "" ? "Slack のメッセージ" : line}`, url: permalink(options.workspace, found) };
          const fingerprint = fingerprintOf(item);
          if (previous.items[item.externalId]?.fingerprint !== fingerprint && Number(item.ts) >= firstRunFrom) changes.push({ kind: "upserted", item });
          nextItems[item.externalId] = { fingerprint, state: item.resolved ? "resolved" : "open" };
        }
        return { changes, nextCursor: { items: nextItems } };
      }),
  };

  const judge = yield* makeTodoJudge<SlackInboxItem>({
    rules: [],
    describe: (item) =>
      Effect.succeed({
        context: [`あなた（ユーザー本人）の Slack のユーザー: <@${myUserId}>`, `種類: ${KIND_LABELS[item.kind]}`, `場所: ${item.isDirect ? "DM" : `#${item.channelName}`}`].join("\n"),
        input: item.text,
      }),
    question: SLACK_TODO_QUESTION,
    thresholds: options.thresholds ?? DEFAULT_TODO_THRESHOLDS,
  }).pipe(Effect.orDie);

  return {
    source: slackInboxSourceName(options.accountId),
    adapter,
    cursorSchema: SlackInboxCursorSchema,
    externalIdOf: (item: SlackInboxItem) => item.externalId,
    toItemDraft: (item: SlackInboxItem) => ({
      title: item.title,
      url: item.url,
      state: item.resolved ? ("resolved" as const) : ("open" as const),
      fingerprint: fingerprintOf(item),
      ...(item.author === undefined ? {} : { author: item.author }),
    }),
    judge,
    taskTitleFollowsItem: true,
  } satisfies SourceBinding<SlackInboxItem, SlackInboxCursor, SlackClientError, unknown, unknown>;
});
