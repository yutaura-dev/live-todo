import { Effect, Option } from "effect";
import { SlackClient } from "./slack-client.js";

/** テスト用の SlackClient。指定しなかったメソッドは空の応答を返す */
export const slackClientStub = (overrides: Partial<SlackClient["Service"]> = {}): SlackClient["Service"] =>
  SlackClient.of({
    savedList: () => Effect.succeed({ items: [], nextCursor: "", totalCount: 0 }),
    message: () => Effect.succeed(Option.none()),
    userName: () => Effect.succeed(Option.none()),
    channel: () => Effect.succeed(Option.none()),
    completeSaved: () => Effect.void,
    searchMessages: () => Effect.succeed({ total: 0, pages: 1, matches: [] }),
    myUserGroups: () => Effect.succeed([]),
    conversation: () => Effect.succeed([]),
    removeSaved: () => Effect.void,
    authTest: Effect.succeed({ userId: "U1", user: "me", team: "Acme" }),
    ...overrides,
  });
