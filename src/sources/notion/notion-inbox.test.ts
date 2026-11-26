import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { StructuredClassifier, type JudgeRequest } from "../../core/judge/todo-judge.js";
import log from "./__fixtures__/notification-log.json" with { type: "json" };
import { NotionClient } from "./notion-client.js";
import { makeNotionInboxBinding, type NotionInboxCursor } from "./notion-inbox.js";
import { unwrapRecordMap } from "./notion-records.js";
import { notionClientStub } from "./test-client.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PAGE = "33333333-3333-4333-8333-333333333333";
const SPACE = "44444444-4444-4444-8444-444444444444";
// フィクスチャの通知の時刻（1764100000000）の約 4 時間後
const NOW = Date.parse("2025-11-26T00:00:00.000Z");

type Raw = typeof log;
const stub = (raw: Raw = log, spaces = [{ id: SPACE, name: "私用" }]) => {
  const calls: string[] = [];
  const client = notionClientStub({
    me: Effect.succeed({ userId: ME, name: "yutaura", spaces }),
    notifications: (spaceId, size) =>
      Effect.sync(() => {
        calls.push(`${spaceId}:${size}`);
        return { notificationIds: raw.notificationIds, recordMap: unwrapRecordMap(raw.recordMap) };
      }),
  });
  return { calls, client };
};

const fetch = (client: NotionClient["Service"], cursor: NotionInboxCursor | null) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const binding = yield* makeNotionInboxBinding({ accountId: "home" }).pipe(Effect.provideService(NotionClient, client));
    return { binding, result: yield* binding.adapter.fetchChanges(cursor) };
  });

const drafts = (outcome: Effect.Success<ReturnType<typeof fetch>>) =>
  outcome.result.changes.flatMap((change) => (change.kind === "upserted" ? [[outcome.binding.externalIdOf(change.item), outcome.binding.toItemDraft(change.item)] as const] : []));

const withRecord = (table: keyof Raw["recordMap"], id: string, patch: Record<string, unknown>): Raw => {
  const records = log.recordMap[table] as Record<string, { value: Record<string, unknown> }>;
  const record = records[id]!;
  const inner = "value" in record.value && typeof record.value["value"] === "object" ? { ...record.value, value: { ...(record.value["value"] as object), ...patch } } : { ...record.value, ...patch };
  return { ...log, recordMap: { ...log.recordMap, [table]: { ...records, [id]: { ...record, value: inner } } } } as Raw;
};

describe("Notion の受信トレイ", () => {
  it.effect("メンション・コメント・リマインダーの通知を、ページ名と本文の 1 行目のタイトル・ページ（コメントならそのスレッド）へのリンクの項目にする", () =>
    Effect.gen(function* () {
      const outcome = yield* fetch(stub().client, null);

      assert.deepStrictEqual(
        drafts(outcome).map(([id, draft]) => [id, draft.title, draft.url, draft.state]),
        [
          ["n-mention-comment", "リリース計画: @yutaura 来週までにレビューお願いします", "https://www.notion.so/33333333333343338333333333333333?d=d1", "open"],
          ["n-reply-answered", "リリース計画: この数字で合っていますか？", "https://www.notion.so/33333333333343338333333333333333?d=d2", "resolved"],
          ["n-resolved", "リリース計画: 表記を直しました", "https://www.notion.so/33333333333343338333333333333333?d=d3", "resolved"],
          ["n-reminder", "リリース計画: 請求書を送る 2026-11-28", "https://www.notion.so/33333333333343338333333333333333", "open"],
          ["n-mention-page", "リリース計画: @yutaura 議事録を確認してください", "https://www.notion.so/33333333333343338333333333333333", "open"],
        ],
      );
      assert.strictEqual(outcome.binding.source, "notion:home:inbox");
    }));

  it.effect("通知を送った人を項目の作成者にする", () =>
    Effect.gen(function* () {
      const [[, draft]] = drafts(yield* fetch(stub().client, null)) as unknown as [[string, { author?: string }]];

      assert.strictEqual(draft.author, "田中");
    }));

  it.effect("ページの編集など、メンション・コメント・リマインダー以外の通知は取り込まない", () =>
    Effect.gen(function* () {
      const outcome = yield* fetch(stub().client, null);

      assert.notInclude(drafts(outcome).map(([id]) => id), "n-edited");
      assert.notProperty(outcome.result.nextCursor.items, "n-edited");
    }));

  it.effect("最初の取り込みでは直近 3 日より前の通知を Task にせず、見たことだけ覚える", () =>
    Effect.gen(function* () {
      const outcome = yield* fetch(stub().client, null);

      assert.notInclude(drafts(outcome).map(([id]) => id), "n-old");
      assert.property(outcome.result.nextCursor.items, "n-old");
    }));

  it.effect("自分が入っているワークスペースごとに、直近 50 件を取る", () =>
    Effect.gen(function* () {
      const { calls, client } = stub(log, [{ id: SPACE, name: "私用" }, { id: "s2", name: "趣味" }]);

      yield* fetch(client, null);

      assert.deepStrictEqual(calls, [`${SPACE}:50`, "s2:50"]);
    }));

  it.effect("変わっていない通知は変化にしない。コメントのスレッドが解決されたら、済んだことにする", () =>
    Effect.gen(function* () {
      const first = yield* fetch(stub().client, null);
      const second = yield* fetch(stub(withRecord("discussion", "d1", { resolved: true })).client, first.result.nextCursor);

      assert.deepStrictEqual(drafts(second).map(([id, draft]) => [id, draft.state]), [["n-mention-comment", "resolved"]]);
    }));

  it.effect("前回より前に取り込んだ通知は、応答に出てこなくても覚えたままにする", () =>
    Effect.gen(function* () {
      const first = yield* fetch(stub().client, null);
      const second = yield* fetch(stub({ ...log, notificationIds: [] }).client, first.result.nextCursor);

      assert.deepStrictEqual(second.result.changes, []);
      assert.deepStrictEqual(Object.keys(second.result.nextCursor.items).toSorted(), Object.keys(first.result.nextCursor.items).toSorted());
    }));

  it.effect("無効になった通知（元のコメントが消えたなど）は、済んだことにする", () =>
    Effect.gen(function* () {
      const outcome = yield* fetch(stub(withRecord("notification", "n-mention-page", { invalid: true })).client, null);

      assert.deepInclude(drafts(outcome).map(([id, draft]) => [id, draft.state]), ["n-mention-page", "resolved"]);
    }));

  it.effect("リマインダーは自分で付けたものなので、規則で todo にする（LLM に送らない）", () =>
    Effect.gen(function* () {
      const outcome = yield* fetch(stub().client, null);
      const reminder = outcome.result.changes.find((change) => change.kind === "upserted" && outcome.binding.externalIdOf(change.item) === "n-reminder");
      if (reminder?.kind !== "upserted") return assert.fail("リマインダーがない");

      const judgment = yield* outcome.binding.judge(reminder.item).pipe(
        Effect.provideService(StructuredClassifier, StructuredClassifier.of({ classifyTodo: () => Effect.die("呼ばれないはず") })),
      );

      assert.deepStrictEqual(judgment, { verdict: "todo", method: "rule" });
    }));

  it.effect("メンションとコメントは、自分が誰か・通知の種類・ページを添えて本文を LLM で判定する", () =>
    Effect.gen(function* () {
      const outcome = yield* fetch(stub().client, null);
      const mention = outcome.result.changes[0]!;
      if (mention.kind !== "upserted") return assert.fail("メンションがない");
      const requests: JudgeRequest[] = [];

      const judgment = yield* outcome.binding.judge(mention.item).pipe(
        Effect.provideService(
          StructuredClassifier,
          StructuredClassifier.of({
            classifyTodo: (request) => {
              requests.push(request);
              return Effect.succeed<unknown>({ verdict: "todo" });
            },
          }),
        ),
      );

      assert.strictEqual(judgment.verdict, "todo");
      assert.include(requests[0]?.context ?? "", "@yutaura");
      assert.include(requests[0]?.context ?? "", "自分へのメンション");
      assert.include(requests[0]?.context ?? "", "リリース計画");
      assert.include(requests[0]?.input ?? "", "来週までにレビューお願いします\n詳細は下に");
    }));
});
