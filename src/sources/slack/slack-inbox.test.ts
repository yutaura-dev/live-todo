import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { SlackSearchMatch } from "./slack-client.js";
import { inboxItemsFrom, makeSlackInboxBinding, type SlackInboxCursor } from "./slack-inbox.js";
import { slackClientStub } from "./test-client.js";
import { SlackClient } from "./slack-client.js";

const ME = "U1";
const msg = (overrides: Partial<SlackSearchMatch>): SlackSearchMatch => ({
  channel: "C1",
  channelName: "general",
  isDirect: false,
  ts: "100.0",
  threadTs: undefined,
  user: "U2",
  text: "見てください",
  ...overrides,
});
const empty = { mentions: [], groupMentions: [], dms: [], threads: [], mine: [], savedKeys: new Set<string>() };

describe("inboxItemsFrom（返事や対応が要りそうな Slack のメッセージを集める）", () => {
  it("自分へのメンション・グループへのメンション・自分宛ての DM を集める。自分の発言は除く", () => {
    const items = inboxItemsFrom(ME, {
      ...empty,
      mentions: [msg({ ts: "1.0" }), msg({ ts: "2.0", user: ME })],
      groupMentions: [msg({ ts: "3.0" })],
      dms: [msg({ channel: "D1", channelName: "", isDirect: true, ts: "4.0" })],
    });

    assert.deepStrictEqual(
      [...items.values()].map((item) => [item.externalId, item.kind, item.resolved]),
      [
        ["C1:1.0", "mention", false],
        ["C1:3.0", "group_mention", false],
        ["D1:4.0", "dm", false],
      ],
    );
  });

  it("同じメッセージが何通りにも当たったら、1 つにまとめる（メンションを優先）", () => {
    const items = inboxItemsFrom(ME, { ...empty, mentions: [msg({ ts: "1.0" })], groupMentions: [msg({ ts: "1.0" })] });

    assert.deepStrictEqual([...items.values()].map((item) => item.kind), ["mention"]);
  });

  it("あとから自分がそのスレッドで返信したメンションは、済んだことにする（前の返信では済まない）", () => {
    const items = inboxItemsFrom(ME, {
      ...empty,
      mentions: [msg({ ts: "10.0" }), msg({ ts: "20.0", threadTs: "15.0" })],
      mine: [msg({ ts: "11.0", threadTs: "10.0", user: ME }), msg({ ts: "14.0", threadTs: "15.0", user: ME })],
    });

    assert.deepStrictEqual([...items.values()].map((item) => [item.externalId, item.resolved]), [
      ["C1:10.0", true],
      ["C1:20.0", false],
    ]);
  });

  it("DM は、あとから自分が同じ DM で書いたら済んだことにする", () => {
    const dm = (ts: string, user = "U2") => msg({ channel: "D1", channelName: "", isDirect: true, ts, user });
    const items = inboxItemsFrom(ME, { ...empty, dms: [dm("10.0"), dm("30.0")], mine: [dm("20.0", ME)] });

    assert.deepStrictEqual([...items.values()].map((item) => [item.externalId, item.resolved]), [
      ["D1:10.0", true],
      ["D1:30.0", false],
    ]);
  });

  it("自分が書いたスレッド（親か返信）に、そのあとで他の人が返信したら集める。自分のいないスレッドや、自分が書く前の返信は集めない", () => {
    const items = inboxItemsFrom(ME, {
      ...empty,
      mine: [msg({ ts: "10.0", user: ME }), msg({ ts: "52.0", threadTs: "50.0", user: ME })],
      threads: [
        msg({ ts: "11.0", threadTs: "10.0" }),
        msg({ ts: "51.0", threadTs: "50.0" }),
        msg({ ts: "53.0", threadTs: "50.0" }),
        msg({ ts: "71.0", threadTs: "70.0" }),
      ],
    });

    assert.deepStrictEqual([...items.values()].map((item) => [item.externalId, item.kind, item.resolved]), [
      ["C1:11.0", "thread_reply", false],
      ["C1:53.0", "thread_reply", false],
    ]);
  });

  it("自分で To-do・Saved にしたメッセージは、To-do の Task に任せて済んだことにする", () => {
    const items = inboxItemsFrom(ME, { ...empty, mentions: [msg({ ts: "1.0" })], savedKeys: new Set(["C1:1.0"]) });

    assert.isTrue([...items.values()][0]?.resolved);
  });
});

describe("Slack のメンション・DM・スレッドの返信の取り込み", () => {
  const recording = (groups: Array<{ id: string; handle: string }>) => {
    const queries: string[] = [];
    let groupCalls = 0;
    const client = slackClientStub({
      authTest: Effect.succeed({ userId: ME, user: "me", team: "Home" }),
      myUserGroups: () =>
        Effect.sync(() => {
          groupCalls++;
          return groups;
        }),
      searchMessages: (query) =>
        Effect.sync(() => {
          queries.push(query.replace(/ after:\S+/, ""));
          return { total: query.startsWith("<@U1>") ? 1 : 0, pages: 1, matches: query.startsWith("<@U1>") ? [msg({ ts: "1.0", text: "<@U1> 確認お願いします" })] : [] };
        }),
    });
    return { queries, groupCalls: () => groupCalls, client };
  };

  it.effect("取り込みのたびにユーザーグループを取り直し、入っているグループへのメンションも探す（グループは増えたり減ったりするため）", () =>
    Effect.gen(function* () {
      const slack = recording([{ id: "S1", handle: "dev" }]);
      const binding = yield* makeSlackInboxBinding({ accountId: "home", workspace: "home.slack.com" }).pipe(Effect.provideService(SlackClient, slack.client));

      const first = yield* binding.adapter.fetchChanges(null);
      yield* binding.adapter.fetchChanges(first.nextCursor);

      assert.strictEqual(slack.groupCalls(), 2);
      assert.includeMembers(slack.queries, ["<@U1>", "<!subteam^S1>", "to:me", "from:me", "is:thread"]);
      assert.notInclude(slack.queries.join(" "), "<!here>");
    }));

  it.effect("変わったものだけを変化として返し、タイトルはチャンネル名つきの読める 1 行にする", () =>
    Effect.gen(function* () {
      const slack = recording([]);
      const binding = yield* makeSlackInboxBinding({ accountId: "home", workspace: "home.slack.com" }).pipe(Effect.provideService(SlackClient, slack.client));

      const first = yield* binding.adapter.fetchChanges(null);
      const second = yield* binding.adapter.fetchChanges(first.nextCursor);

      assert.strictEqual(binding.source, "slack:home:inbox");
      assert.deepStrictEqual(
        first.changes.map((change) => (change.kind === "upserted" ? [binding.toItemDraft(change.item).title, binding.toItemDraft(change.item).state] : [])),
        [["#general: @U1 確認お願いします", "open"]],
      );
      assert.lengthOf(second.changes, 0);
    }));

  it.effect("最初の取り込みでは、直近 3 日より前のものは Task にせず、見たことだけ覚える（2 週間分が一度に入らないように）", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-26T00:00:00Z"));
      const old = String(Date.parse("2026-11-20T00:00:00Z") / 1000);
      const recent = String(Date.parse("2026-11-25T00:00:00Z") / 1000);
      const client = slackClientStub({
        authTest: Effect.succeed({ userId: ME, user: "me", team: "Home" }),
        searchMessages: (query) =>
          Effect.succeed({ total: 2, pages: 1, matches: query.startsWith("<@U1>") ? [msg({ ts: old }), msg({ ts: recent })] : [] }),
      });
      const binding = yield* makeSlackInboxBinding({ accountId: "home", workspace: "home.slack.com" }).pipe(Effect.provideService(SlackClient, client));

      const first = yield* binding.adapter.fetchChanges(null);

      assert.deepStrictEqual(first.changes.map((change) => (change.kind === "upserted" ? binding.externalIdOf(change.item) : "")), [`C1:${recent}`]);
      assert.property(first.nextCursor.items, `C1:${old}`);
    }));

  it.effect("探す期間から外れた項目も、前の状態のまま覚えておく（消えたことにしない）", () =>
    Effect.gen(function* () {
      const slack = recording([]);
      const binding = yield* makeSlackInboxBinding({ accountId: "home", workspace: "home.slack.com" }).pipe(Effect.provideService(SlackClient, slack.client));
      const old: SlackInboxCursor = { items: { "C9:1.0": { fingerprint: "x", state: "open" } } };

      const result = yield* binding.adapter.fetchChanges(old);

      assert.isFalse(result.changes.some((change) => change.kind === "removed"));
      assert.property(result.nextCursor.items, "C9:1.0");
    }));
});
