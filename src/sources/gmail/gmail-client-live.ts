import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  GmailClient,
  GmailHistoryExpiredError,
  type GmailMessage,
  GmailRequestError,
  type GmailThreadMessage,
  MAIL_HEADERS,
  type MailHeader,
} from "./gmail-client.js";

export type GwsResult = { exitCode: number; stdout: string };

/** gws CLI を動かす。テストでは偽物に差し替える */
export class Gws extends Context.Service<Gws, {
  run(args: ReadonlyArray<string>): Effect.Effect<GwsResult, GmailRequestError>;
}>()("live-todo/sources/gmail/Gws") {
  static readonly layer = Layer.effect(
    Gws,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const failed = () => new GmailRequestError({ message: "gws を動かせない（gws が入っていて、認証済みか確かめてください）" });
      const run = Effect.fn("Gws.run")(function* (args: ReadonlyArray<string>) {
        const handle = yield* spawner.spawn(ChildProcess.make("gws", [...args])).pipe(Effect.mapError(failed));
        const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString, Effect.mapError(failed));
        const exitCode = yield* handle.exitCode.pipe(Effect.mapError(failed));
        return { exitCode: Number(exitCode), stdout };
      }, Effect.scoped);
      return Gws.of({ run });
    }),
  );
}

const Header = Schema.Struct({ name: Schema.String, value: Schema.String });
type Part = {
  mimeType?: string | undefined;
  headers?: ReadonlyArray<typeof Header.Type> | undefined;
  body?: { data?: string | undefined; attachmentId?: string | undefined } | undefined;
  parts?: ReadonlyArray<Part> | undefined;
};
const Part: Schema.Codec<Part> = Schema.Struct({
  mimeType: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Array(Header)),
  body: Schema.optional(Schema.Struct({ data: Schema.optional(Schema.String), attachmentId: Schema.optional(Schema.String) })),
  parts: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<Part> => Part))),
});
const Message = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  internalDate: Schema.String,
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  payload: Schema.optional(Part),
});
const MessageList = Schema.Struct({ messages: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))), nextPageToken: Schema.optional(Schema.String) });
const Ids = Schema.optional(Schema.Array(Schema.Struct({ message: Schema.Struct({ id: Schema.String }) })));
const HistoryPage = Schema.Struct({
  historyId: Schema.String,
  nextPageToken: Schema.optional(Schema.String),
  history: Schema.optional(Schema.Array(Schema.Struct({ messagesAdded: Ids, labelsAdded: Ids, labelsRemoved: Ids, messagesDeleted: Ids }))),
});
const Thread = Schema.Struct({ messages: Schema.optional(Schema.Array(Message)) });
const Profile = Schema.Struct({ historyId: Schema.String });
const ErrorBody = Schema.Struct({ error: Schema.Struct({ code: Schema.Number }) });

const decodeJson = <S extends Schema.Decoder<unknown>>(schema: S, stdout: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(stdout).pipe(Effect.mapError(() => new GmailRequestError({ message: "gws の出力を読めない" })));

const statusOf = (stdout: string) => Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))(stdout))?.error.code;

const WANTED: ReadonlySet<string> = new Set(MAIL_HEADERS);
const headersOf = (part: Part | undefined) => {
  const headers: Partial<Record<MailHeader, string>> = {};
  for (const header of part?.headers ?? []) {
    const name = header.name.toLowerCase();
    if (WANTED.has(name) && headers[name as MailHeader] === undefined) headers[name as MailHeader] = header.value;
  }
  return headers;
};

const toMessage = (message: typeof Message.Type): GmailMessage => ({
  id: message.id,
  threadId: message.threadId,
  receivedAt: Number(message.internalDate),
  labelIds: message.labelIds ?? [],
  headers: headersOf(message.payload),
});

const decodeBody = (data: string | undefined) => (data === undefined ? "" : Buffer.from(data, "base64url").toString("utf8"));
const findPart = (part: Part, mimeType: string): Part | undefined =>
  part.mimeType === mimeType && part.body?.data !== undefined ? part : (part.parts ?? []).map((child) => findPart(child, mimeType)).find((found) => found !== undefined);
const findCalendar = (part: Part): Part | undefined =>
  part.mimeType === "text/calendar" && (part.body?.data !== undefined || part.body?.attachmentId !== undefined)
    ? part
    : (part.parts ?? []).map(findCalendar).find((found) => found !== undefined);
const Attachment = Schema.Struct({ data: Schema.String });
// HTML のメールを正しく描かずにタグを除くだけにする理由: Claude Code に読ませる文脈として足りればよく、描画用の依存を増やさないため
const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
const textOf = (payload: Part | undefined) => {
  if (payload === undefined) return "";
  const plain = findPart(payload, "text/plain");
  if (plain !== undefined) return decodeBody(plain.body?.data).trim();
  const html = findPart(payload, "text/html");
  return html === undefined ? "" : htmlToText(decodeBody(html.body?.data));
};

export const GmailClientLive = Layer.effect(
  GmailClient,
  Effect.gen(function* () {
    const gws = yield* Gws;
    const call = Effect.fnUntraced(function* (path: ReadonlyArray<string>, params: Record<string, unknown>, body?: unknown) {
      const result = yield* gws.run(["gmail", "users", ...path, "--params", JSON.stringify({ userId: "me", ...params }), ...(body === undefined ? [] : ["--json", JSON.stringify(body)])]);
      if (result.exitCode === 0) return result.stdout;
      const status = statusOf(result.stdout);
      return yield* new GmailRequestError({ message: `gws gmail ${path.join(" ")} が失敗した${status === undefined ? "" : `（${status}）`}`, ...(status === undefined ? {} : { status }) });
    });

    const message = Effect.fn("GmailClient.message")(function* (id: string) {
      const stdout = yield* call(["messages", "get"], { id, format: "metadata" }).pipe(Effect.result);
      if (stdout._tag === "Failure") return stdout.failure.status === 404 ? Option.none<GmailMessage>() : yield* stdout.failure;
      return Option.some(toMessage(yield* decodeJson(Message, stdout.success)));
    });

    const history = Effect.fn("GmailClient.history")(function* (startHistoryId: string) {
      const added: string[] = [];
      const labelsChanged: string[] = [];
      const deleted: string[] = [];
      let historyId = startHistoryId;
      let pageToken: string | undefined;
      do {
        const stdout = yield* call(["history", "list"], { startHistoryId, ...(pageToken === undefined ? {} : { pageToken }) }).pipe(
          Effect.catchIf(
            (error) => error.status === 404,
            () => Effect.fail(new GmailHistoryExpiredError()),
          ),
        );
        const page = yield* decodeJson(HistoryPage, stdout);
        historyId = page.historyId;
        for (const entry of page.history ?? []) {
          added.push(...(entry.messagesAdded ?? []).map((change) => change.message.id));
          labelsChanged.push(...[...(entry.labelsAdded ?? []), ...(entry.labelsRemoved ?? [])].map((change) => change.message.id));
          deleted.push(...(entry.messagesDeleted ?? []).map((change) => change.message.id));
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
      return { historyId, added, labelsChanged, deleted };
    });

    return GmailClient.of({
      historyId: call(["getProfile"], {}).pipe(Effect.flatMap((stdout) => decodeJson(Profile, stdout)), Effect.map((profile) => profile.historyId)),
      listMessages: Effect.fn("GmailClient.listMessages")(function* (query: string, pageToken?: string) {
        const page = yield* decodeJson(MessageList, yield* call(["messages", "list"], { q: query, maxResults: 100, ...(pageToken === undefined ? {} : { pageToken }) }));
        return { ids: (page.messages ?? []).map((entry) => entry.id), nextPageToken: page.nextPageToken };
      }),
      message,
      history,
      calendar: Effect.fn("GmailClient.calendar")(function* (id: string) {
        const message = yield* decodeJson(Message, yield* call(["messages", "get"], { id, format: "full" }));
        const part = message.payload === undefined ? undefined : findCalendar(message.payload);
        if (part === undefined) return Option.none<string>();
        if (part.body?.data !== undefined) return Option.some(decodeBody(part.body.data));
        const attachment = yield* decodeJson(Attachment, yield* call(["messages", "attachments", "get"], { messageId: id, id: part.body?.attachmentId }));
        return Option.some(decodeBody(attachment.data));
      }),
      thread: Effect.fn("GmailClient.thread")(function* (threadId: string) {
        const thread = yield* decodeJson(Thread, yield* call(["threads", "get"], { id: threadId, format: "full" }));
        return (thread.messages ?? []).map((entry): GmailThreadMessage => ({ ...toMessage(entry), text: textOf(entry.payload) }));
      }),
      archive: (id: string) => call(["messages", "modify"], { id }, { removeLabelIds: ["INBOX", "UNREAD"] }).pipe(Effect.asVoid),
      trash: (id: string) => call(["messages", "trash"], { id }).pipe(Effect.asVoid),
    });
  }),
);
