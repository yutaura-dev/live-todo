import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { answered } from "../shared/answer.js";
import { AgentRunner, AgentRunRequest, toolsFor } from "./agent.js";
import { agentTest } from "./test-double.js";

const task = { id: "t1", title: "PR #42 を直す", brief: "CI が落ちている", status: "やること", completion: "まだ", due: null, blocksOthers: false, plan: [], facts: [] } as const;

describe("Agent に渡す道具の段", () => {
  it("PR を直す・コンフリクトを直す・直す Action Item をやるときだけ、直す道具を渡す", () => {
    assert.deepStrictEqual(
      (["質問に答える", "Action Item をやる（読むだけ）", "Action Item をやる（直す）", "依存の更新を調べる", "PR を直す", "コンフリクトを直す"] as const).map(toolsFor),
      ["読むだけ", "読むだけ", "直す", "読むだけ", "直す", "直す"],
    );
  });

  it("作業の種類と合わない道具の段の依頼は作れない", () => {
    const request = { runId: "ar1", kind: "質問に答える", tools: "直す", workspace: null, sessionId: null, task, request: "なぜ落ちた？", item: null };
    assert.throws(() => Schema.decodeUnknownSync(AgentRunRequest)(request));
  });

  it("外へ書き込む道具の段はない（外への書き込みは Approval を通してアプリが行う）", () => {
    const request = { runId: "ar1", kind: "PR を直す", tools: "書き込む", workspace: "~/w", sessionId: null, task, request: "直す", item: null };
    assert.throws(() => Schema.decodeUnknownSync(AgentRunRequest)(request));
  });
});

describe("テスト用の Agent", () => {
  it.effect("決めた順に出来事を流し、頼まれた依頼を残す", () => {
    const fake = agentTest({
      run: () => [
        { type: "始まった", sessionId: "s1" },
        { type: "終わった", outcome: { type: "回答", text: "依存の型が変わったため" } },
      ],
      askToStop: () => answered("やめる"),
    });
    return Effect.gen(function* () {
      const agent = yield* AgentRunner;
      const request = Schema.decodeUnknownSync(AgentRunRequest)({ runId: "ar1", kind: "質問に答える", tools: "読むだけ", workspace: null, sessionId: null, task, request: "なぜ落ちた？", item: null });
      const events = yield* Stream.runCollect(agent.run(request));
      assert.deepStrictEqual(events.map((event) => event.type), ["始まった", "終わった"]);
      assert.deepStrictEqual(yield* agent.askToStop({ runId: "ar1", sessionId: "s1", notice: "PR が merge された" }), answered("やめる"));
      assert.deepStrictEqual(fake.requests.map((r) => r.runId), ["ar1"]);
    }).pipe(Effect.provide(fake.layer));
  });
});
