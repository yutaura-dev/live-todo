import { Effect, Layer } from "effect";
import type { Answer } from "../shared/answer.js";
import type { AiUnreachableError } from "../shared/errors.js";
import { Generation, type GenerationResult } from "./generation.js";

type Script = Readonly<Record<string, (input: unknown) => Answer<unknown> | Effect.Effect<Answer<unknown>, AiUnreachableError>>>;

/**
 * テスト用の Generation（テストから実 API を呼ばないため）。書き物の ID ごとに答えを決める。
 * 決めていない書き物を頼まれたら die にする。答えは出力の Schema でデコードしないので、テストの側で形を合わせる。
 */
export function generationTest(script: Script) {
  const calls: Array<{ purpose: string; input: unknown }> = [];
  const layer = Layer.succeed(
    Generation,
    Generation.of({
      write: (writing, input) =>
        Effect.gen(function* () {
          calls.push({ purpose: writing.purpose, input });
          const reply = script[writing.purpose];
          if (reply === undefined) return yield* Effect.die(new Error(`テストで答えを決めていない書き物: ${writing.purpose}`));
          const produced = reply(input);
          const answer = Effect.isEffect(produced) ? yield* produced : produced;
          return {
            answer,
            record: {
              role: "Generation",
              purpose: writing.purpose,
              version: writing.version,
              modelId: "test",
              answers: { output: answer._tag === "Answered" ? { _tag: "Answered", probabilities: {} } : { _tag: "Unanswered", reason: answer.reason } },
              usage: { inputTokens: null, outputTokens: null },
            },
          } as GenerationResult<never>;
        }),
    }),
  );
  return { calls, layer };
}
