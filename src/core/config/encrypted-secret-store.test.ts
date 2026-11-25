import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Redacted } from "effect";
import { encryptedFileSecretStore, type SecretCipher, SecretVault } from "./encrypted-secret-store.js";
import { SecretStore } from "./secret-store.js";

/** 本物の safeStorage の代わり。可逆だが平文のままにはしない */
const fakeCipher = (available = true): SecretCipher => ({
  isAvailable: async () => available,
  encrypt: async (plain) => new TextEncoder().encode(`enc:${[...plain].reverse().join("")}`),
  decrypt: async (data) => [...new TextDecoder().decode(data).replace(/^enc:/, "")].reverse().join(""),
});

const withStore = (options: { cipher?: SecretCipher; env?: Record<string, string> } = {}) =>
  <A, E>(effect: (path: string) => Effect.Effect<A, E, SecretStore | SecretVault | FileSystem.FileSystem>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = `${yield* fs.makeTempDirectoryScoped()}/secrets.json`;
      return yield* effect(path).pipe(
        Effect.provide(encryptedFileSecretStore({ path, cipher: options.cipher ?? fakeCipher() })),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: options.env ?? {} })),
      );
    }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer)));

const valueOf = (secret: Option.Option<Redacted.Redacted<string>>) => Option.getOrUndefined(Option.map(secret, Redacted.value));

describe("encryptedFileSecretStore", () => {
  it.effect("保存した秘密情報を読める", () =>
    withStore()(() =>
      Effect.gen(function* () {
        yield* (yield* SecretVault).set("github.work.token", Redacted.make("ghp_secret"));

        assert.strictEqual(valueOf(yield* (yield* SecretStore).get("github.work.token")), "ghp_secret");
      }),
    ));

  it.effect("ファイルには平文を書かない", () =>
    withStore()((path) =>
      Effect.gen(function* () {
        yield* (yield* SecretVault).set("github.work.token", Redacted.make("ghp_secret"));

        const text = yield* (yield* FileSystem.FileSystem).readFileString(path);
        assert.notInclude(text, "ghp_secret");
      }),
    ));

  it.effect("ファイルは持ち主だけが読み書きできる権限で作る", () =>
    withStore()((path) =>
      Effect.gen(function* () {
        yield* (yield* SecretVault).set("github.work.token", Redacted.make("ghp_secret"));

        const info = yield* (yield* FileSystem.FileSystem).stat(path);
        assert.strictEqual(info.mode & 0o777, 0o600);
      }),
    ));

  it.effect("削除したら読めなくなり、登録済みのキーからも消える", () =>
    withStore()(() =>
      Effect.gen(function* () {
        const vault = yield* SecretVault;
        yield* vault.set("github.work.token", Redacted.make("ghp_secret"));
        yield* vault.set("llm.openai.api_key", Redacted.make("sk_secret"));

        yield* vault.remove("github.work.token");

        assert.isTrue(Option.isNone(yield* (yield* SecretStore).get("github.work.token")));
        assert.deepStrictEqual(yield* vault.storedKeys, ["llm.openai.api_key"]);
      }),
    ));

  it.effect("保存していないキーは環境変数から読む（コマンドラインからの実行と同じ設定を使えるように）", () =>
    withStore({ env: { LIVE_TODO_SECRET_GITHUB_WORK_TOKEN: "ghp_from_env" } })(() =>
      Effect.gen(function* () {
        assert.strictEqual(valueOf(yield* (yield* SecretStore).get("github.work.token")), "ghp_from_env");
      }),
    ));

  it.effect("保存した値は環境変数より優先する", () =>
    withStore({ env: { LIVE_TODO_SECRET_GITHUB_WORK_TOKEN: "ghp_from_env" } })(() =>
      Effect.gen(function* () {
        yield* (yield* SecretVault).set("github.work.token", Redacted.make("ghp_saved"));

        assert.strictEqual(valueOf(yield* (yield* SecretStore).get("github.work.token")), "ghp_saved");
      }),
    ));

  it.effect("OS の暗号化が使えないときは、平文で保存せずにエラーにする", () =>
    withStore({ cipher: fakeCipher(false) })((path) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* SecretVault).set("github.work.token", Redacted.make("ghp_secret")));

        assert.strictEqual(error._tag, "SecretVaultError");
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(path));
      }),
    ));
});
