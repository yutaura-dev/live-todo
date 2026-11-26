import { assert, describe, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Option } from "effect";
import { decodeAppConfig, InvalidAppConfigError, loadAppConfigFile, readAppConfigDocument, saveAppConfigFile } from "./app-config.js";

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
      assert.isFalse(config.accounts[0]?.reviewDependencyPrs);
      assert.isFalse(config.accounts[0]?.planNextActions);
    }));

  it.effect("依存更新の PR を Claude Code で調べるかをアカウントごとに書ける", () =>
    Effect.gen(function* () {
      const config = yield* decodeAppConfig({ ...validConfig, accounts: [{ kind: "github", id: "personal", reviewDependencyPrs: true }] });

      assert.isTrue(config.accounts[0]?.reviewDependencyPrs);
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

describe("Slack のアカウント", () => {
  const slack = { kind: "slack", id: "home", workspace: "yutaura.slack.com", userAgent: "Mozilla/5.0 TestBrowser" };

  it.effect("ワークスペースのドメインとブラウザの User-Agent で Slack のアカウントを書ける。書かなければ空", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* decodeAppConfig(validConfig)).slackAccounts, []);

      const config = yield* decodeAppConfig({ ...validConfig, slackAccounts: [slack] });

      assert.deepInclude(config.slackAccounts[0], { id: "home", workspace: "yutaura.slack.com", planNextActions: false });
    }));

  it.effect("Slack のドメインでないワークスペースと、空の User-Agent はエラーにする", () =>
    Effect.gen(function* () {
      yield* invalidReason({ ...validConfig, slackAccounts: [{ ...slack, workspace: "evil.example.com" }] });
      yield* invalidReason({ ...validConfig, slackAccounts: [{ ...slack, userAgent: "" }] });
    }));

  it.effect("id は GitHub のアカウントとも重ならないようにする（秘密情報のキーや Source 名の区別に使うため）", () =>
    Effect.gen(function* () {
      const reason = yield* invalidReason({ ...validConfig, slackAccounts: [{ ...slack, id: "work" }] });

      assert.include(reason, "重複");
    }));
});

describe("Decisions の閾値", () => {
  it.effect("decisions に閾値を書ける", () =>
    Effect.gen(function* () {
      const config = yield* decodeAppConfig({
        ...validConfig,
        llmProfiles: { ...validConfig.llmProfiles, work: { provider: "none", model: "-", decisions: { provider: "openai", thresholds: { todo: 0.7, review: 0.2 } } } },
      });

      assert.deepStrictEqual(config.llmProfiles["work"]?.decisions?.thresholds, { todo: 0.7, review: 0.2 });
    }));

  it.effect("閾値が 0 から 1 の範囲外ならエラーにする", () =>
    Effect.gen(function* () {
      yield* invalidReason({
        ...validConfig,
        llmProfiles: { ...validConfig.llmProfiles, work: { provider: "none", model: "-", decisions: { provider: "openai", thresholds: { todo: 1.5, review: 0.2 } } } },
      });
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

describe("saveAppConfigFile", () => {
  const inTempDir = <A, E>(use: (path: string) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* use(`${yield* fs.makeTempDirectoryScoped()}/config.json`);
    }).pipe(Effect.provide(NodeFileSystem.layer));

  it.effect("正しい設定を保存し、読み直すと同じ設定になる", () =>
    inTempDir((path) =>
      Effect.gen(function* () {
        yield* saveAppConfigFile(path, validConfig);

        const config = yield* loadAppConfigFile(path);
        assert.deepStrictEqual(config.accounts[0]?.repositories, { include: ["acme/*"], exclude: ["acme/legacy"] });
        assert.strictEqual(config.accounts[1]?.llmProfile, "personal");
      }),
    ));

  it.effect("正しくない設定は保存せず、前の設定を残す", () =>
    inTempDir((path) =>
      Effect.gen(function* () {
        yield* saveAppConfigFile(path, validConfig);

        const error = yield* Effect.flip(saveAppConfigFile(path, { ...validConfig, defaultLlmProfile: "missing" }));

        assert.instanceOf(error, InvalidAppConfigError);
        assert.strictEqual((yield* loadAppConfigFile(path)).defaultLlmProfile, "work");
      }),
    ));
});

describe("readAppConfigDocument", () => {
  it.effect("設定ファイルがなければ none を返す（設定画面で一から作れるように）", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const document = yield* readAppConfigDocument(`${yield* fs.makeTempDirectoryScoped()}/config.json`);

      assert.isTrue(Option.isNone(document));
    }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.effect("検証に通らない設定でも、JSON として読めればそのまま返す（画面で直せるように）", () =>
    Effect.gen(function* () {
      const document = yield* readAppConfigDocument("/config.json");

      assert.deepStrictEqual(document, Option.some({ accounts: "broken" }));
    }).pipe(Effect.provide(FileSystem.layerNoop({ exists: () => Effect.succeed(true), readFileString: () => Effect.succeed('{"accounts":"broken"}') }))));
});
