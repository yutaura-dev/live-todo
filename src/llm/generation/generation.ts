import { Context, Effect, Layer, Schema } from "effect";
import { LanguageModel } from "effect/ai";
import { type Answer, answered, fromAiError } from "../shared/answer.js";
import { AiUnreachableError } from "../shared/errors.js";
import type { CallRecord } from "../shared/record.js";
import type { Writing, WritingInput, WritingOutput } from "./writing.js";

export interface GenerationResult<A> {
  readonly answer: Answer<A>;
  readonly record: CallRecord;
}

/** AI 設定の Generation（文章を伴う Structured Output）。書けなかったら Answer の値で、届かなかったら AiUnreachableError で返す */
export class Generation extends Context.Service<
  Generation,
  {
    write<I extends WritingInput, O extends WritingOutput>(writing: Writing<I, O>, input: I["Type"]): Effect.Effect<GenerationResult<O["Type"]>, AiUnreachableError>;
  }
>()("live-todo/llm/generation/Generation") {}

const recordOf = (
  writing: { readonly purpose: string; readonly version: number },
  answer: Answer<unknown>,
  usage: { inputTokens: number | null; outputTokens: number | null },
): CallRecord => ({
  role: "Generation",
  purpose: writing.purpose,
  version: writing.version,
  modelId: null,
  answers: { output: answer._tag === "Answered" ? { _tag: "Answered", probabilities: {} } : { _tag: "Unanswered", reason: answer.reason } },
  usage,
});

/** effect/ai の LanguageModel で Generation を提供する。provider（Anthropic・OpenAI・Azure など）は LanguageModel を提供する側で決める */
export const generationFromModel = Layer.effect(
  Generation,
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel;
    const write = <I extends WritingInput, O extends WritingOutput>(writing: Writing<I, O>, input: I["Type"]): Effect.Effect<GenerationResult<O["Type"]>, AiUnreachableError> =>
      Effect.gen(function* () {
        // 入力は定義の Schema でエンコードしてから渡す（DateTime などを JSON の形にそろえる）。失敗するのは定義の誤りなので die にする
        const encoded = yield* Schema.encodeUnknownEffect(Schema.toCodecJson(writing.input))(input).pipe(Effect.orDie);
        const response = yield* model.generateObject({
          objectName: writing.objectName,
          schema: writing.output,
          prompt: [
            { role: "system", content: writing.instructions(input) },
            { role: "user", content: JSON.stringify(encoded) },
          ],
        });
        const usage = { inputTokens: response.usage.inputTokens.total ?? null, outputTokens: response.usage.outputTokens.total ?? null };
        const answer = answered(response.value as O["Type"]);
        return { answer, record: recordOf(writing, answer, usage) };
      }).pipe(
        Effect.catchTag("AiError", (error) => {
          const classified = fromAiError(error);
          if (classified._tag === "Unreachable") {
            return Effect.fail(new AiUnreachableError({ role: "Generation", purpose: writing.purpose, reason: classified.reason }));
          }
          return Effect.succeed({ answer: classified, record: recordOf(writing, classified, { inputTokens: null, outputTokens: null }) });
        }),
      ) as Effect.Effect<GenerationResult<O["Type"]>, AiUnreachableError>;
    return Generation.of({ write });
  }),
);
