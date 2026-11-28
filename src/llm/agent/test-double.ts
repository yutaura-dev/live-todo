import { Effect, Layer, Stream } from "effect";
import type { Answer } from "../shared/answer.js";
import { type AgentEvent, AgentRunner, type AgentRunRequest } from "./agent.js";

/** テスト用の Agent（テストから Claude Code を動かさないため）。依頼ごとに流す出来事と、やめるかの答えを決める */
export function agentTest(script: {
  run: (request: AgentRunRequest) => ReadonlyArray<AgentEvent>;
  askToStop: (input: { runId: string; sessionId: string; notice: string }) => Answer<"やめる" | "続ける">;
}) {
  const requests: AgentRunRequest[] = [];
  const layer = Layer.succeed(
    AgentRunner,
    AgentRunner.of({
      run: (request) =>
        Stream.suspend(() => {
          requests.push(request);
          return Stream.fromIterable(script.run(request));
        }),
      askToStop: (input) => Effect.sync(() => script.askToStop(input)),
    }),
  );
  return { requests, layer };
}
