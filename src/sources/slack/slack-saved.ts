import { Effect, Option, Schema } from "effect";
import type { TodoJudgment } from "../../core/judge/todo-judge.js";
import { diffSnapshot } from "../../core/sync/snapshot-differ.js";
import type { SourceAdapter } from "../../core/sync/source-adapter.js";
import type { SourceBinding } from "../../core/sync/sync-source.js";
import { SlackClient, type SlackClientError } from "./slack-client.js";

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
});
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
const TITLE_LENGTH = 80;
const FALLBACK_TITLE = "Slack のメッセージ";
// 自分で To-do・Saved にしたものは、それ自体が自分の todo なので LLM に問わない（ADR-0010）
const SAVED_JUDGMENT: TodoJudgment = { verdict: "todo", method: "rule" };

export const slackSourceName = (accountId: string) => `slack:${accountId}`;

const permalink = (workspace: string, channel: string, ts: string) => `https://${workspace}/archives/${channel}/p${ts.replace(".", "")}`;

const titleOf = (text: string) => {
  const firstLine = text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  if (firstLine === "") return FALLBACK_TITLE;
  return firstLine.length > TITLE_LENGTH ? `${firstLine.slice(0, TITLE_LENGTH)}…` : firstLine;
};

const fingerprintOf = (item: SlackSavedItem) => JSON.stringify([item.todoState, item.dueAt ?? 0]);

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
          let title = previous.titles[externalId];
          // 本文は初めて見た未完了のものだけ取る。完了済みは Task にならないので、取らない
          if (title === undefined && saved.todo_state !== "completed") {
            const message = yield* client.message(saved.item_id, saved.ts).pipe(
              Effect.catchTag("SlackRequestError", (error) =>
                Effect.logWarning("Slack のメッセージの本文を取れない").pipe(
                  Effect.annotateLogs({ externalId, reason: error.error ?? "unknown" }),
                  Effect.as(Option.none<{ text: string; user: string | undefined }>()),
                ),
              ),
            );
            title = Option.match(message, { onNone: () => FALLBACK_TITLE, onSome: (found) => titleOf(found.text) });
          }
          titles[externalId] = title ?? FALLBACK_TITLE;
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
        return { changes: diff.changes, nextCursor: { fingerprints: Object.fromEntries(diff.nextFingerprints), titles } };
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
  } satisfies SourceBinding<SlackSavedItem, SlackSavedCursor, SlackClientError, never, never>;
});
