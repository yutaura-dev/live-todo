import { Effect } from "effect";
import { NotionClient } from "./notion-client.js";

/** テスト用の NotionClient。指定しなかったメソッドは空の応答を返す */
export const notionClientStub = (overrides: Partial<NotionClient["Service"]> = {}): NotionClient["Service"] =>
  NotionClient.of({
    me: Effect.succeed({ userId: "11111111-1111-4111-8111-111111111111", name: "me", spaces: [] }),
    notifications: () => Effect.succeed({ notificationIds: [], recordMap: {} }),
    ...overrides,
  });
