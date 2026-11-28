import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { AiError, LanguageModel } from "effect/ai";
import { answered, unanswered } from "../shared/answer.js";
import { Generation, generationFromModel } from "./generation.js";
import { defineWriting } from "./writing.js";

const writing = defineWriting({
  purpose: "test.summary",
  version: 2,
  objectName: "summary",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ summary: Schema.String }),
  instructions: () => "要約を 1 文で書く",
});

function modelReplying(reply: () => Effect.Effect<string, AiError.AiError>) {
  const prompts: LanguageModel.ProviderOptions["prompt"][] = [];
  const model = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) => {
        prompts.push(options.prompt);
        return reply().pipe(Effect.map((text) => [{ type: "text" as const, text }]));
      },
      streamText: () => {
        throw new Error("使わない");
      },
    }),
  );
  return { prompts, layer: generationFromModel.pipe(Layer.provide(model)) };
}

const run = Effect.gen(function* () {
  return yield* (yield* Generation).write(writing, { text: "外の人が書いた本文" });
});

describe("Generation（Structured Output で、決まった形の文章を書く）", () => {
  it.effect("出力の Schema に合う答えを返し、書き物の ID と版を記録する", () => {
    const fake = modelReplying(() => Effect.succeed(JSON.stringify({ summary: "まとめ" })));
    return Effect.gen(function* () {
      const result = yield* run;
      assert.deepStrictEqual(result.answer, answered({ summary: "まとめ" }));
      assert.deepStrictEqual({ role: result.record.role, purpose: result.record.purpose, version: result.record.version }, { role: "Generation", purpose: "test.summary", version: 2 });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("指示は system に、入力は user に分けて渡す（外の人が書いた文を指示と取り違えないため）", () => {
    const fake = modelReplying(() => Effect.succeed(JSON.stringify({ summary: "まとめ" })));
    return Effect.gen(function* () {
      yield* run;
      const messages = fake.prompts[0]!.content;
      assert.strictEqual(messages[0]?.role, "system");
      assert.include(JSON.stringify(messages[0]), "要約を 1 文で書く");
      assert.notInclude(JSON.stringify(messages[0]), "外の人が書いた本文");
      assert.include(JSON.stringify(messages.at(-1)), "外の人が書いた本文");
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("出力の形に合わなければ、答えなかった（Invalid）にする", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* run).answer, unanswered("Invalid"));
    }).pipe(Effect.provide(modelReplying(() => Effect.succeed(JSON.stringify({ wrong: 1 }))).layer)));

  it.effect("内容のせいで断られたら、答えなかった（Refused）にする", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* run).answer, unanswered("Refused"));
    }).pipe(
      Effect.provide(
        modelReplying(() => Effect.fail(new AiError.AiError({ module: "test", method: "generate", reason: new AiError.ContentPolicyError({ description: "x" }) }))).layer,
      ),
    ));

  it.effect("AI に届かなかったら、AiUnreachableError で失敗する", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run);
      assert.deepStrictEqual({ role: error.role, reason: error.reason }, { role: "Generation", reason: "Network" });
    }).pipe(
      Effect.provide(
        modelReplying(() =>
          Effect.fail(new AiError.AiError({ module: "test", method: "generate", reason: new AiError.NetworkError({ reason: "TransportError", method: "POST", url: "https://example.test" }) })),
        ).layer,
      ),
    ));
});
