import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { isNotionUrl, notionSessionFrom, withNotionSession } from "./notion-session.js";

const USER = "11111111-1111-4111-8111-111111111111";

describe("notionSessionFrom（ログイン画面の Cookie からセッションを読む）", () => {
  it("token_v2 と notion_user_id があれば、それと接続先（notion.so なら www.notion.so）を返す", () => {
    const session = notionSessionFrom([
      { name: "token_v2", value: "v02:secret", domain: ".www.notion.so" },
      { name: "notion_user_id", value: USER, domain: ".www.notion.so" },
    ]);

    assert.deepStrictEqual(session, Option.some({ token: "v02:secret", userId: USER, origin: "https://www.notion.so" as const }));
  });

  it("notion.com の Cookie なら、接続先を app.notion.com にする", () => {
    const session = notionSessionFrom([
      { name: "token_v2", value: "v02:secret", domain: ".notion.com" },
      { name: "notion_user_id", value: USER, domain: ".notion.com" },
    ]);

    assert.strictEqual(Option.getOrThrow(session).origin, "https://app.notion.com");
  });

  it("notion_user_id がなければ、notion_users（ログイン中のユーザーの一覧）の先頭を使う", () => {
    const session = notionSessionFrom([
      { name: "token_v2", value: "v02:secret", domain: ".www.notion.so" },
      { name: "notion_users", value: encodeURIComponent(JSON.stringify([USER])), domain: ".www.notion.so" },
    ]);

    assert.strictEqual(Option.getOrThrow(session).userId, USER);
  });

  it("ログインが済んでいない（token_v2 がない・空・ユーザーが分からない）なら none", () => {
    assert.isTrue(Option.isNone(notionSessionFrom([{ name: "notion_user_id", value: USER, domain: ".www.notion.so" }])));
    assert.isTrue(Option.isNone(notionSessionFrom([{ name: "token_v2", value: "", domain: ".www.notion.so" }, { name: "notion_user_id", value: USER, domain: ".www.notion.so" }])));
    assert.isTrue(Option.isNone(notionSessionFrom([{ name: "token_v2", value: "v02:secret", domain: ".www.notion.so" }])));
  });

  it("Notion 以外のドメインの Cookie は使わない", () => {
    const session = notionSessionFrom([
      { name: "token_v2", value: "v02:secret", domain: ".notion.so.evil.example" },
      { name: "notion_user_id", value: USER, domain: ".notion.so.evil.example" },
    ]);

    assert.isTrue(Option.isNone(session));
  });
});

describe("withNotionSession", () => {
  it("Notion のアカウントがなければ足し、あればユーザー・User-Agent・接続先だけを書き換える", () => {
    const session = { id: "home", userId: USER, userAgent: "Mozilla/5.0", origin: "https://www.notion.so" as const };

    const added = withNotionSession({ accounts: [] }, session);
    const updated = withNotionSession({ accounts: [], notionAccounts: [{ kind: "notion", id: "home", userId: "old", userAgent: "old", llmProfile: "personal" }] }, session);

    assert.deepStrictEqual(added["notionAccounts"], [{ kind: "notion", id: "home", userId: USER, userAgent: "Mozilla/5.0", origin: "https://www.notion.so" }]);
    assert.deepStrictEqual(updated["notionAccounts"], [{ kind: "notion", id: "home", userId: USER, userAgent: "Mozilla/5.0", origin: "https://www.notion.so", llmProfile: "personal" }]);
  });
});

describe("isNotionUrl", () => {
  it.each(["https://www.notion.so/login", "https://notion.so/", "https://app.notion.com/", "https://www.notion.com/login"])("Notion の https のページ: %s", (url) => {
    assert.isTrue(isNotionUrl(url));
  });

  it.each(["http://www.notion.so/", "https://notion.so.evil.example/", "https://evil-notion.so/", "not a url"])("それ以外: %s", (url) => {
    assert.isFalse(isNotionUrl(url));
  });
});
