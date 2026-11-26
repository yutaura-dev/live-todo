import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import completed from "./__fixtures__/saved-list-completed.json" with { type: "json" };
import open from "./__fixtures__/saved-list-open.json" with { type: "json" };
import { SlackClient } from "./slack-client.js";
import { makeSlackSavedBinding, type SlackSavedCursor } from "./slack-saved.js";

const page = (body: { saved_items: unknown[]; counts: { total_count: number }; response_metadata: { next_cursor: string } }) => ({
  items: body.saved_items,
  nextCursor: body.response_metadata.next_cursor,
  totalCount: body.counts.total_count,
});

const stub = (options: { open?: unknown; completed?: unknown; texts?: Record<string, string> } = {}) => {
  const calls: string[] = [];
  const client = SlackClient.of({
    savedList: ({ filter, cursor }) =>
      Effect.sync(() => {
        calls.push(`saved.list:${filter ?? "-"}:${cursor ?? "-"}`);
        return page((filter === "completed" ? (options.completed ?? completed) : (options.open ?? open)) as never);
      }),
    message: (channel, ts) =>
      Effect.sync(() => {
        calls.push(`message:${channel}:${ts}`);
        const text = (options.texts ?? { "C0123ABCD:1764000000.123456": "リリース前に API の互換を確認してほしい\n詳細はスレッドで", "D0456EFGH:1764000500.000100": "週次の振り返りのメモ" })[`${channel}:${ts}`];
        return text === undefined ? Option.none() : Option.some({ text, user: "U1" });
      }),
    authTest: Effect.succeed({ userId: "U1", user: "me", team: "Acme" }),
  });
  return { calls, client };
};

const fetch = (client: SlackClient["Service"], cursor: SlackSavedCursor | null) =>
  Effect.gen(function* () {
    const binding = yield* makeSlackSavedBinding({ accountId: "home", workspace: "acme.slack.com" }).pipe(Effect.provideService(SlackClient, client));
    return { binding, result: yield* binding.adapter.fetchChanges(cursor) };
  });

describe("Slack の To-do・Saved", () => {
  it.effect("未完了と完了済みの一覧をすべて取り、メッセージだけを、本文の 1 行目をタイトル・メッセージへのリンクを URL にした項目にする", () =>
    Effect.gen(function* () {
      const { calls, client } = stub();

      const { binding, result } = yield* fetch(client, null);

      const drafts = result.changes.flatMap((change) => (change.kind === "upserted" ? [binding.toItemDraft(change.item)] : []));
      assert.deepStrictEqual(
        drafts.map((draft) => [draft.title, draft.url, draft.state]),
        [
          ["リリース前に API の互換を確認してほしい", "https://acme.slack.com/archives/C0123ABCD/p1764000000123456", "open"],
          ["週次の振り返りのメモ", "https://acme.slack.com/archives/D0456EFGH/p1764000500000100", "open"],
          ["Slack のメッセージ", "https://acme.slack.com/archives/C0123ABCD/p1763900000000001", "resolved"],
        ],
      );
      assert.deepStrictEqual(calls.slice(0, 2), ["saved.list:-:-", "saved.list:completed:-"]);
      assert.strictEqual(binding.source, "slack:home");
    }));

  it.effect("変わっていない項目は変化にせず、本文も取り直さない。完了したら解消、一覧から消えたら removed にする", () =>
    Effect.gen(function* () {
      const first = yield* fetch(stub().client, null);
      const { calls, client } = stub({
        open: { ...open, saved_items: [open.saved_items[0]] },
        completed: { ...completed, saved_items: [...completed.saved_items, { ...open.saved_items[1], todo_state: "completed", date_completed: 1764100000 }] },
      });

      const { binding, result } = yield* fetch(client, first.result.nextCursor);

      assert.deepStrictEqual(
        result.changes.map((change) => (change.kind === "upserted" ? [change.kind, binding.toItemDraft(change.item).state, binding.externalIdOf(change.item)] : [change.kind, change.externalId])),
        [["upserted", "resolved", "D0456EFGH:1764000500.000100"]],
      );
      assert.isFalse(calls.some((call) => call.startsWith("message:")));
    }));

  it.effect("自分で To-do・Saved にしたものなので、判定は規則で todo にする（LLM に送らない）", () =>
    Effect.gen(function* () {
      const { binding, result } = yield* fetch(stub().client, null);
      const change = result.changes[0]!;
      assert.strictEqual(change.kind, "upserted");
      if (change.kind !== "upserted") return;

      assert.deepStrictEqual(yield* binding.judge(), { verdict: "todo", method: "rule" });
    }));

  it.effect("本文が取れなくても、項目にはする（タイトルは「Slack のメッセージ」）", () =>
    Effect.gen(function* () {
      const { binding, result } = yield* fetch(stub({ texts: {} }).client, null);

      assert.strictEqual(result.changes.length, 3);
      const first = result.changes[0]!;
      assert.strictEqual(first.kind === "upserted" ? binding.toItemDraft(first.item).title : "", "Slack のメッセージ");
    }));
});
