import { Effect, Option, Schema } from "effect";
import type { TodoJudgment } from "../../core/judge/todo-judge.js";
import { diffSnapshot } from "../../core/sync/snapshot-differ.js";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import type { SourceBinding } from "../../core/sync/sync-source.js";
import { SlackClient, type SlackClientError } from "./slack-client.js";
import { mentionedIds, slackTitleLine } from "./slack-text.js";

export type SlackSavedItem = {
  externalId: string;
  channel: string;
  ts: string;
  todoState: "saved" | "to_do" | "completed";
  /** 期限（Unix 秒）。なければ undefined */
  dueAt: number | undefined;
  title: string;
  url: string;
};

export const SlackSavedCursorSchema = Schema.Struct({
  fingerprints: Schema.Record(Schema.String, Schema.String),
  titles: Schema.Record(Schema.String, Schema.String),
  /** タイトルの作り方の版。変えたら、覚えているタイトルを作り直す */
  titleVersion: Schema.optionalKey(Schema.Number),
});
const TITLE_VERSION = 2;
export type SlackSavedCursor = typeof SlackSavedCursorSchema.Type;

const SavedItem = Schema.Struct({
  item_id: Schema.String,
  item_type: Schema.String,
  ts: Schema.String,
  todo_state: Schema.Literals(["saved", "to_do", "completed"]),
  date_due: Schema.optional(Schema.NullOr(Schema.Number)),
});
const decodeSavedItem = Schema.decodeUnknownOption(SavedItem);

// 1 回の取得でたどるページ数の上限（1 ページ 50 件）。想定外に多いときに、レート制限を使い切らないため
const MAX_PAGES = 20;
const FALLBACK_TITLE = "Slack のメッセージ";
const INVISIBLE_TITLE = "見られないチャンネルのメッセージ";
// 自分で To-do・Saved にしたものは、それ自体が自分の todo なので LLM に問わない（ADR-0010）
const SAVED_JUDGMENT: TodoJudgment = { verdict: "todo", method: "rule" };

export const slackSourceName = (accountId: string) => `slack:${accountId}`;

const permalink = (workspace: string, channel: string, ts: string) => `https://${workspace}/archives/${channel}/p${ts.replace(".", "")}`;

// タイトルも含める理由: タイトルの作り方を直したときに、変化として Task まで伝えるため
const fingerprintOf = (item: SlackSavedItem) => JSON.stringify([item.todoState, item.dueAt ?? 0, item.title]);

/** Slack の To-do・Saved（saved.list）を、全件を取って前回と比べる Source にする（ADR-0010） */
export const makeSlackSavedBinding = Effect.fnUntraced(function* (options: { accountId: string; workspace: string }) {
  const client = yield* SlackClient;

  const listAll = Effect.fnUntraced(function* (filter: "completed" | undefined) {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = yield* client.savedList({ ...(filter === undefined ? {} : { filter }), ...(cursor === undefined ? {} : { cursor }) });
      items.push(...result.items);
      if (result.nextCursor === "") return items;
      cursor = result.nextCursor;
    }
    yield* Effect.logWarning("To-do・Saved のページ数の上限に達した。残りは取らない").pipe(Effect.annotateLogs({ filter: filter ?? "open" }));
    return items;
  });

  const adapter: SourceAdapter<SlackSavedItem, SlackSavedCursor, SlackClientError> = {
    fetchChanges: (cursor) =>
      Effect.gen(function* () {
        const previous = cursor ?? { fingerprints: {}, titles: {} };
        const knownTitles = previous.titleVersion === TITLE_VERSION ? previous.titles : {};
        const channels = new Map<string, Option.Option<{ name: string; isDirect: boolean }>>();
        const users = new Map<string, string>();
        const channelOf = (id: string) =>
          Effect.gen(function* () {
            const cached = channels.get(id);
            if (cached !== undefined) return cached;
            const found = yield* client.channel(id);
            channels.set(id, found);
            return found;
          });
        const titleFor = (saved: typeof SavedItem.Type, externalId: string) =>
          Effect.gen(function* () {
            const channel = yield* channelOf(saved.item_id);
            if (Option.isNone(channel)) return INVISIBLE_TITLE;
            const prefix = channel.value.isDirect ? "DM" : `#${channel.value.name}`;
            // 本文は未完了のものだけ取る。完了済みは Task にならないので、取らない
            if (saved.todo_state === "completed") return `${prefix}: ${FALLBACK_TITLE}`;
            const message = yield* client.message(saved.item_id, saved.ts).pipe(
              Effect.catchTag("SlackRequestError", (error) =>
                Effect.logWarning("Slack のメッセージの本文を取れない").pipe(
                  Effect.annotateLogs({ externalId, reason: error.error ?? "unknown" }),
                  Effect.as(Option.none<{ text: string; user: string | undefined }>()),
                ),
              ),
            );
            if (Option.isNone(message)) return `${prefix}: ${FALLBACK_TITLE}`;
            for (const id of mentionedIds(message.value.text)) {
              if (users.has(id)) continue;
              const name = yield* client.userName(id);
              if (Option.isSome(name)) users.set(id, name.value);
            }
            const line = slackTitleLine(message.value.text, { users });
            return `${prefix}: ${line === "" ? FALLBACK_TITLE : line}`;
          });
        // 取得の途中で完了されたものは両方に出るので、あとに取る完了済みの方を使う（仕様書）
        const raw = [...(yield* listAll(undefined)), ...(yield* listAll("completed"))];
        const byKey = new Map<string, typeof SavedItem.Type>();
        for (const entry of raw) {
          const decoded = decodeSavedItem(entry);
          // メッセージ以外（ファイル・チャンネルなど）は本文の取り方が違うので、いまは扱わない
          if (Option.isNone(decoded) || decoded.value.item_type !== "message") continue;
          byKey.set(`${decoded.value.item_id}:${decoded.value.ts}`, decoded.value);
        }

        const titles: Record<string, string> = {};
        const items: SlackSavedItem[] = [];
        for (const [externalId, saved] of byKey) {
          titles[externalId] = knownTitles[externalId] ?? (yield* titleFor(saved, externalId));
          items.push({
            externalId,
            channel: saved.item_id,
            ts: saved.ts,
            todoState: saved.todo_state,
            dueAt: saved.date_due === undefined || saved.date_due === null || saved.date_due === 0 ? undefined : saved.date_due,
            title: titles[externalId]!,
            url: permalink(options.workspace, saved.item_id, saved.ts),
          });
        }

        const diff = yield* diffSnapshot(new Map(Object.entries(previous.fingerprints)), items, (item) => ({
          externalId: item.externalId,
          fingerprint: fingerprintOf(item),
        })).pipe(Effect.orDie);
        return { changes: diff.changes, nextCursor: { fingerprints: Object.fromEntries(diff.nextFingerprints), titles, titleVersion: TITLE_VERSION } };
      }),
  };

  return {
    source: slackSourceName(options.accountId),
    adapter,
    cursorSchema: SlackSavedCursorSchema,
    externalIdOf: (item: SlackSavedItem) => item.externalId,
    toItemDraft: (item: SlackSavedItem) => ({
      title: item.title,
      url: item.url,
      state: item.todoState === "completed" ? ("resolved" as const) : ("open" as const),
      fingerprint: fingerprintOf(item),
    }),
    judge: () => Effect.succeed(SAVED_JUDGMENT),
    // タイトルはメッセージから機械的に作るので、作り方を直したら Task にも反映する（自分で書き換えたタイトルは変えない）
    taskTitleFollowsItem: true,
  } satisfies SourceBinding<SlackSavedItem, SlackSavedCursor, SlackClientError, never, never>;
});
