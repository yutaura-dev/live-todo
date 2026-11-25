import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { decodeAppConfig, InvalidAppConfigError, loadAppConfigFile } from "./app-config.js";

const validConfig = {
  llmProfiles: {
    work: { provider: "azure-openai", model: "gpt-5" },
    personal: { provider: "anthropic", model: "claude-sonnet-5-5", decisions: { provider: "openai" } },
  },
  defaultLlmProfile: "work",
  accounts: [
    { kind: "github", id: "work", repositories: { include: ["acme/*"], exclude: ["acme/legacy"] } },
    { kind: "github", id: "personal", llmProfile: "personal" },
  ],
};

const invalidReason = (input: unknown) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decodeAppConfig(input));
    assert.instanceOf(error, InvalidAppConfigError);
    return error.message;
  });

describe("decodeAppConfig", () => {
  it.effect("正しい設定を読み、省略した項目には既定値を入れる", () =>
    Effect.gen(function* () {
      const config = yield* decodeAppConfig(validConfig);

      assert.strictEqual(config.accounts[0]?.initialLookbackDays, 14);
      assert.deepStrictEqual(config.accounts[0]?.repositories, { include: ["acme/*"], exclude: ["acme/legacy"] });
      assert.deepStrictEqual(config.llmProfiles["personal"]?.decisions, { provider: "openai" });
    }));

  it.effect("対応していない LLM のプロバイダはエラーにする", () =>
    Effect.gen(function* () {
      yield* invalidReason({ ...validConfig, llmProfiles: { work: { provider: "unknown-ai", model: "x" } } });
    }));

  it.effect("defaultLlmProfile が llmProfiles にない名前ならエラーにする", () =>
    Effect.gen(function* () {
      const message = yield* invalidReason({ ...validConfig, defaultLlmProfile: "missing" });

      assert.include(message, "defaultLlmProfile");
      assert.include(message, "missing");
    }));

  it.effect("アカウントが存在しない LLM Profile を指していたらエラーにする", () =>
    Effect.gen(function* () {
      const message = yield* invalidReason({
        ...validConfig,
        accounts: [{ kind: "github", id: "work", llmProfile: "missing" }],
      });

      assert.include(message, "accounts[0].llmProfile");
    }));

  it.effect("アカウントの id が重複していたらエラーにする", () =>
    Effect.gen(function* () {
      const message = yield* invalidReason({
        ...validConfig,
        accounts: [
          { kind: "github", id: "work" },
          { kind: "github", id: "work" },
        ],
      });

      assert.include(message, "work");
    }));

  it.effect.each(["Work Account", "work:1", "", "仕事"])("Source 名に使えない id %j はエラーにする", (id) =>
    Effect.gen(function* () {
      yield* invalidReason({ ...validConfig, accounts: [{ kind: "github", id }] });
    }));

  it.effect("リポジトリのパターンが不正ならエラーにする", () =>
    Effect.gen(function* () {
      const message = yield* invalidReason({
        ...validConfig,
        accounts: [{ kind: "github", id: "work", repositories: { include: ["acme"] } }],
      });

      assert.include(message, "acme");
    }));
});

describe("アカウントの LLM Profile", () => {
  it.effect("アカウントが LLM Profile を指定していればそれを使う", () =>
    Effect.gen(function* () {
      const config = yield* decodeAppConfig(validConfig);

      assert.strictEqual(config.accounts[1]?.resolvedLlmProfile.provider, "anthropic");
    }));

  it.effect("指定していなければ defaultLlmProfile を使う", () =>
    Effect.gen(function* () {
      const config = yield* decodeAppConfig(validConfig);

      assert.strictEqual(config.accounts[0]?.resolvedLlmProfile.provider, "azure-openai");
    }));
});

describe("loadAppConfigFile", () => {
  const withFile = (contents: string) =>
    FileSystem.layerNoop({ readFileString: () => Effect.succeed(contents) });

  it.effect("JSON の設定ファイルを読んで検証する", () =>
    Effect.gen(function* () {
      const config = yield* loadAppConfigFile("/config.json");

      assert.strictEqual(config.defaultLlmProfile, "work");
    }).pipe(Effect.provide(withFile(JSON.stringify(validConfig)))));

  it.effect("JSON として読めなければエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(loadAppConfigFile("/config.json"));

      assert.instanceOf(error, InvalidAppConfigError);
    }).pipe(Effect.provide(withFile("{ not json"))));
});
