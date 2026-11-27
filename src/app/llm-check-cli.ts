import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { EnvSecretStore } from "../core/config/secret-store.js";
import { loadAppConfigFile } from "./config/app-config.js";
import { checkLlmProfile } from "./llm-check.js";

class LlmCheckFailedError extends Schema.TaggedError<LlmCheckFailedError>()("LlmCheckFailedError", { message: Schema.String }) {}

// 使い方: pnpm llm:check [LLM Profile の名前]（省略すると defaultLlmProfile）
// API キーは環境変数（.env.local）から読む。アプリの設定画面で保存したキー（キーチェーン）は読まない
const program = Effect.gen(function* () {
  const config = yield* loadAppConfigFile(yield* Config.String("LIVE_TODO_CONFIG").pipe(Config.withDefault("./config.json")));
  const name = process.argv[2] ?? config.defaultLlmProfile;
  const profile = config.llmProfiles[name];
  if (profile === undefined) {
    return yield* new LlmCheckFailedError({ message: `LLM Profile「${name}」がない。あるのは: ${Object.keys(config.llmProfiles).join(", ")}` });
  }

  console.log(`LLM Profile「${name}」: ${profile.provider} / ${profile.model}${profile.azure === undefined ? "" : ` / ${profile.azure.endpoint}`}`);
  if (profile.decisions !== undefined) console.log(`  decisions: ${profile.decisions.provider} / ${profile.decisions.model ?? "（既定のモデル）"}`);
  const results = yield* checkLlmProfile(profile);
  for (const result of results) console.log(`  ${result.ok ? "✓" : "✗"} ${result.name}: ${result.detail}`);

  const failed = results.filter((result) => !result.ok).length;
  if (failed > 0) return yield* new LlmCheckFailedError({ message: `${failed} 件が失敗した` });
});

NodeRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(EnvSecretStore, FetchHttpClient.layer, NodeFileSystem.layer))));
