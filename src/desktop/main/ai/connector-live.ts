import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiDecisionModel, OpenAiLanguageModel } from "@effect/ai-openai";
import { type Context, Effect, Layer, Redacted, Schema } from "effect";
import { Decision, type LanguageModel } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import type { AiUse, Choice } from "../../../domain/ai-settings/ai-settings.js";
import { Decisions, decisionsFromModel } from "../../../llm/decision/decisions.js";
import { defineQuestion } from "../../../llm/decision/question.js";
import { Generation, generationFromModel } from "../../../llm/generation/generation.js";
import { defineWriting } from "../../../llm/generation/writing.js";
import type { AiUnreachableError } from "../../../llm/shared/errors.js";
import { optionFor } from "./catalog.js";
import { AiConnector, type ConnectResult } from "./connector.js";

// 認証を確かめるための、いちばん小さい呼び出し（中身に意味はなく、答えが返れば通った）
const checkQuestion = defineQuestion({
  purpose: "ai-settings.check",
  version: 1,
  input: Schema.Struct({ text: Schema.String }),
  decisions: () => ({ ok: Decision.probability({ instructions: "この文は挨拶か" }) }),
});
const checkWriting = defineWriting({
  purpose: "ai-settings.check",
  version: 1,
  objectName: "check",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ reply: Schema.String }),
  instructions: () => "「はい」とだけ返してください",
});

const serviceOf = <I, S>(tag: Context.Service<I, S>) =>
  Effect.gen(function* () {
    return yield* tag;
  });

const unreachableMessage = (error: AiUnreachableError) =>
  error.reason === "Authentication" ? "認証が通りません。API キーを確かめてください" : `AI に届きませんでした（${error.reason}）。少し待ってから確かめ直してください`;

const languageModelOf = (choice: Choice, apiKey: Redacted.Redacted<string>): Layer.Layer<LanguageModel.LanguageModel> | null => {
  const model = choice.model ?? "";
  if (choice.provider === "anthropic") {
    return AnthropicLanguageModel.layer({ model, config: { max_tokens: 4096 } }).pipe(Layer.provide(AnthropicClient.layer({ apiKey })), Layer.provide(FetchHttpClient.layer));
  }
  if (choice.provider === "openai") return OpenAiLanguageModel.layer({ model }).pipe(Layer.provide(OpenAiClient.layer({ apiKey })), Layer.provide(FetchHttpClient.layer));
  return null;
};

/**
 * 実際の provider につなぐ。キーは env（.env.local を読み込んだ process.env）から取り、renderer には渡さない。
 * commandSucceeds は Agent（CLI）があるかを確かめるため（テストでは差し替える）。
 */
export const liveConnector = (deps: { env: Readonly<Record<string, string | undefined>>; commandSucceeds: (command: string, args: ReadonlyArray<string>) => Effect.Effect<boolean> }) => {
  const connect = Effect.fnUntraced(function* (use: AiUse, choice: Choice, options: { verify: boolean }): Effect.fn.Return<ConnectResult> {
          const option = optionFor(use, choice);
          if (option === undefined) return { ok: false, message: "選べない AI です" };
          const key = option.secret === null ? undefined : deps.env[option.secret];
          if (option.secret !== null && (key === undefined || key.trim() === "")) return { ok: false, message: `${option.secret} を .env.local に書いてください` };
          const apiKey = Redacted.make(key ?? "");

          if (use === "decisions") {
            const layer = decisionsFromModel.pipe(
              Layer.provide(OpenAiDecisionModel.layer({ model: choice.model ?? "gpt-6-luna" })),
              Layer.provide(OpenAiClient.layer({ apiKey })),
              Layer.provide(FetchHttpClient.layer),
            );
            const decisions = yield* Effect.provide(serviceOf(Decisions), layer);
            if (options.verify) {
              const failed = yield* decisions.ask(checkQuestion, { text: "こんにちは" }).pipe(
                Effect.as(null),
                Effect.catchTag("AiUnreachableError", (error) => Effect.succeed(unreachableMessage(error))),
              );
              if (failed !== null) return { ok: false, message: failed };
            }
            return { ok: true, connected: { decisions } };
          }

          if (use === "generation") {
            const model = languageModelOf(choice, apiKey);
            if (model === null) return { ok: false, message: "選べない AI です" };
            const generation = yield* Effect.provide(serviceOf(Generation), generationFromModel.pipe(Layer.provide(model)));
            if (options.verify) {
              const failed = yield* generation.write(checkWriting, { text: "確かめ" }).pipe(
                Effect.as(null),
                Effect.catchTag("AiUnreachableError", (error) => Effect.succeed(unreachableMessage(error))),
              );
              if (failed !== null) return { ok: false, message: failed };
            }
            return { ok: true, connected: { generation } };
          }

          // Agent は呼ぶ口がまだないので、CLI があることだけを確かめる
          if (!options.verify) return { ok: true, connected: {} };
          const found = yield* deps.commandSucceeds("claude", ["--version"]);
          return found ? { ok: true, connected: {} } : { ok: false, message: "claude コマンドが見つかりません。Claude Code を入れて、ログインしてください" };
  });
  return Layer.succeed(AiConnector, AiConnector.of({ connect: (use, choice, options) => connect(use, choice, options ?? { verify: true }) }));
};
