import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { GmailClient } from "./gmail-client.js";
import { GmailClientLive, Gws, type GwsResult } from "./gmail-client-live.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function fakeGws(route: (args: ReadonlyArray<string>) => GwsResult) {
  const calls: Array<ReadonlyArray<string>> = [];
  const gws = Layer.succeed(Gws, Gws.of({ run: (args) => Effect.sync(() => (calls.push(args), route(args))) }));
  return { calls, layer: GmailClientLive.pipe(Layer.provide(gws)) };
}
const ok = (body: unknown): GwsResult => ({ exitCode: 0, stdout: JSON.stringify(body) });
const fail = (code: number): GwsResult => ({ exitCode: 1, stdout: JSON.stringify({ error: { code, message: "x", reason: "y" } }) });
const paramsOf = (args: ReadonlyArray<string>) => JSON.parse(args[args.indexOf("--params") + 1] ?? "{}") as Record<string, unknown>;

const client = Effect.gen(function* () {
  return yield* GmailClient;
});

describe("GmailClientLive（gws でGmail を読む）", () => {
  it.effect("メールのヘッダーを小文字の名前で、仕分けに使うものだけ取り、ラベルと受け取った時刻を返す", () => {
    const fake = fakeGws(() =>
      ok({
        id: "m1",
        threadId: "t1",
        internalDate: "1764120000000",
        labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
        payload: { headers: [{ name: "From", value: "Shop <news@shop.example>" }, { name: "List-Unsubscribe", value: "<mailto:u@shop.example>" }, { name: "Received", value: "..." }] },
      }),
    );
    return Effect.gen(function* () {
      const message = yield* (yield* client).message("m1");

      assert.deepStrictEqual(Option.getOrThrow(message), {
        id: "m1",
        threadId: "t1",
        receivedAt: 1764120000000,
        labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
        headers: { from: "Shop <news@shop.example>", "list-unsubscribe": "<mailto:u@shop.example>" },
      });
      assert.deepInclude(paramsOf(fake.calls[0]!), { userId: "me", id: "m1", format: "metadata" });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("消えたメール（404）は none", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* (yield* client).message("gone")));
    }).pipe(Effect.provide(fakeGws(() => fail(404)).layer)));

  it.effect("検索に当たったメールの id と、続きのページの印を返す", () =>
    Effect.gen(function* () {
      const page = yield* (yield* client).listMessages("newer_than:14d");
      assert.deepStrictEqual(page, { ids: ["m1", "m2"], nextPageToken: "next" });
    }).pipe(Effect.provide(fakeGws(() => ok({ messages: [{ id: "m1", threadId: "t" }, { id: "m2", threadId: "t" }], nextPageToken: "next" })).layer)));

  it.effect("当たりがなければ空", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* (yield* client).listMessages("x"), { ids: [], nextPageToken: undefined });
    }).pipe(Effect.provide(fakeGws(() => ok({ resultSizeEstimate: 0 })).layer)));

  it.effect("履歴から、届いた・ラベルが変わった・消えたメールの id をまとめ、ページをたどる", () => {
    const fake = fakeGws((args) =>
      paramsOf(args)["pageToken"] === undefined
        ? ok({ historyId: "200", nextPageToken: "p2", history: [{ id: "150", messagesAdded: [{ message: { id: "m1" } }], labelsRemoved: [{ message: { id: "m2" } }] }] })
        : ok({ historyId: "200", history: [{ id: "160", labelsAdded: [{ message: { id: "m3" } }], messagesDeleted: [{ message: { id: "m4" } }] }] }),
    );
    return Effect.gen(function* () {
      const history = yield* (yield* client).history("100");
      assert.deepStrictEqual(history, { historyId: "200", added: ["m1"], labelsChanged: ["m2", "m3"], deleted: ["m4"] });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("履歴の起点が古すぎる（404）ときは GmailHistoryExpiredError", () =>
    Effect.gen(function* () {
      const error = yield* (yield* client).history("1").pipe(Effect.flip);
      assert.strictEqual(error._tag, "GmailHistoryExpiredError");
    }).pipe(Effect.provide(fakeGws(() => fail(404)).layer)));

  it.effect("スレッドのメールを本文つきで返す（text/plain を優先し、なければ HTML からタグを除く）", () =>
    Effect.gen(function* () {
      const messages = yield* (yield* client).thread("t1");
      assert.deepStrictEqual(messages.map((message) => message.text), ["こんにちは", "見出し 本文"]);
    }).pipe(
      Effect.provide(
        fakeGws(() =>
          ok({
            messages: [
              {
                id: "m1",
                threadId: "t1",
                internalDate: "1",
                labelIds: [],
                payload: { mimeType: "multipart/alternative", headers: [], parts: [{ mimeType: "text/html", body: { data: b64("<p>x</p>") } }, { mimeType: "text/plain", body: { data: b64("こんにちは") } }] },
              },
              { id: "m2", threadId: "t1", internalDate: "2", labelIds: [], payload: { mimeType: "text/html", headers: [], body: { data: b64("<h1>見出し</h1><p>本文</p>") } } },
            ],
          }),
        ).layer,
      ),
    ));

  it.effect("確認済みにするときは、受信トレイと未読のラベルを外す（アーカイブして既読にする）", () => {
    const fake = fakeGws(() => ok({ id: "m1" }));
    return Effect.gen(function* () {
      yield* (yield* client).archive("m1");
      const args = fake.calls[0]!;
      assert.deepStrictEqual(args.slice(0, 4), ["gmail", "users", "messages", "modify"]);
      assert.deepInclude(paramsOf(args), { userId: "me", id: "m1" });
      assert.deepStrictEqual(JSON.parse(args[args.indexOf("--json") + 1]!), { removeLabelIds: ["INBOX", "UNREAD"] });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("招待のメールの予定のファイルを、添付として付いていれば取りに行って返す", () => {
    const fake = fakeGws((args) =>
      args[3] === "get" && args[2] === "messages"
        ? ok({ id: "m1", threadId: "t1", internalDate: "1", payload: { mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", body: { data: b64("x") } }, { mimeType: "text/calendar", filename: "invite.ics", body: { attachmentId: "att1" } }] } })
        : ok({ data: b64("BEGIN:VCALENDAR"), size: 15 }),
    );
    return Effect.gen(function* () {
      const calendar = yield* (yield* client).calendar("m1");
      assert.deepStrictEqual(calendar, Option.some("BEGIN:VCALENDAR"));
      assert.deepStrictEqual(fake.calls[1]!.slice(0, 5), ["gmail", "users", "messages", "attachments", "get"]);
      assert.deepInclude(paramsOf(fake.calls[1]!), { userId: "me", messageId: "m1", id: "att1" });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("予定のファイルがなければ none", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* (yield* client).calendar("m1")));
    }).pipe(Effect.provide(fakeGws(() => ok({ id: "m1", threadId: "t1", internalDate: "1", payload: { mimeType: "text/plain", body: { data: b64("x") } } })).layer)));

  it.effect("ゴミ箱に入れる", () => {
    const fake = fakeGws(() => ok({ id: "m1" }));
    return Effect.gen(function* () {
      yield* (yield* client).trash("m1");
      assert.deepStrictEqual(fake.calls[0]!.slice(0, 4), ["gmail", "users", "messages", "trash"]);
      assert.deepInclude(paramsOf(fake.calls[0]!), { userId: "me", id: "m1" });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("gws が失敗したら、Gmail のステータスつきの GmailRequestError（出力の本文はメッセージに入れない）", () =>
    Effect.gen(function* () {
      const error = yield* (yield* client).trash("m1").pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "GmailRequestError", status: 403 });
    }).pipe(Effect.provide(fakeGws(() => fail(403)).layer)));
});
