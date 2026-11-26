import { Effect, Option } from "effect";
import { GmailClient, GmailHistoryExpiredError, type GmailHistory, type GmailMessage, type GmailThreadMessage } from "./gmail-client.js";

/** テスト用の Gmail。メールを入れておき、履歴の差分は history に入れたものを返す */
export function makeTestGmail(initial: ReadonlyArray<GmailMessage> = []) {
  const state = {
    messages: new Map(initial.map((message) => [message.id, message])),
    texts: new Map<string, string>(),
    calendars: new Map<string, string>(),
    historyId: "100",
    history: undefined as GmailHistory | "expired" | undefined,
    queries: [] as string[],
    fetched: [] as string[],
    trashed: [] as string[],
    archived: [] as string[],
    labels: [] as Array<{ id: string; name: string }>,
    modified: [] as Array<{ id: string; add: ReadonlyArray<string>; remove: ReadonlyArray<string> }>,
  };
  const client = GmailClient.of({
    historyId: Effect.sync(() => state.historyId),
    listMessages: (query) =>
      Effect.sync(() => {
        state.queries.push(query);
        return { ids: [...state.messages.values()].toSorted((a, b) => b.receivedAt - a.receivedAt).map((message) => message.id), nextPageToken: undefined };
      }),
    message: (id) =>
      Effect.sync(() => {
        state.fetched.push(id);
        return Option.fromNullishOr(state.messages.get(id));
      }),
    history: () =>
      state.history === "expired"
        ? Effect.fail(new GmailHistoryExpiredError())
        : Effect.succeed(state.history ?? { historyId: state.historyId, added: [], labelsChanged: [], deleted: [] }),
    calendar: (id) => Effect.sync(() => Option.fromNullishOr(state.calendars.get(id))),
    thread: (threadId) =>
      Effect.sync(() =>
        [...state.messages.values()]
          .filter((message) => message.threadId === threadId)
          .toSorted((a, b) => a.receivedAt - b.receivedAt)
          .map((message): GmailThreadMessage => ({ ...message, text: state.texts.get(message.id) ?? "" })),
      ),
    labels: Effect.sync(() => state.labels),
    createLabel: (name) =>
      Effect.sync(() => {
        const id = `Label_${state.labels.length + 1}`;
        state.labels.push({ id, name });
        return { id };
      }),
    modifyLabels: (id, change) =>
      Effect.sync(() => {
        state.modified.push({ id, ...change });
        const message = state.messages.get(id);
        if (message !== undefined) state.messages.set(id, { ...message, labelIds: [...message.labelIds.filter((label) => !change.remove.includes(label)), ...change.add] });
      }),
    archive: (id) =>
      Effect.sync(() => {
        state.archived.push(id);
        const message = state.messages.get(id);
        if (message !== undefined) state.messages.set(id, { ...message, labelIds: message.labelIds.filter((label) => label !== "INBOX" && label !== "UNREAD") });
      }),
    trash: (id) =>
      Effect.sync(() => {
        state.trashed.push(id);
        const message = state.messages.get(id);
        if (message !== undefined) state.messages.set(id, { ...message, labelIds: [...message.labelIds.filter((label) => label !== "INBOX"), "TRASH"] });
      }),
  });
  return { state, client };
}

export const gmailMessage = (overrides: Partial<GmailMessage> & { id: string }): GmailMessage => ({
  threadId: `t-${overrides.id}`,
  receivedAt: Date.UTC(2026, 10, 25),
  labelIds: ["INBOX", "UNREAD"],
  headers: { from: "Shop <news@shop.example>", subject: `件名 ${overrides.id}` },
  ...overrides,
});
