import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
import { EnvSecretStore, MissingSecretError, SecretStore } from "./secret-store.js";

const withEnv = (env: Record<string, string>) =>
  <A, E>(effect: Effect.Effect<A, E, SecretStore>) =>
    effect.pipe(
      Effect.provide(EnvSecretStore),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    );

describe("EnvSecretStore", () => {
  it.effect("キーを LIVE_TODO_SECRET_ で始まる環境変数の名前に変えて読む", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretStore;

      const token = yield* secrets.get("github.work.token");

      assert.strictEqual(Option.map(token, Redacted.value).pipe(Option.getOrUndefined), "ghp_secret");
    }).pipe(withEnv({ LIVE_TODO_SECRET_GITHUB_WORK_TOKEN: "ghp_secret" })));

  it.effect("読んだ値は文字列にしても中身が出ない", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretStore;

      const token = yield* secrets.require("github.work.token");

      assert.notInclude(String(token), "ghp_secret");
    }).pipe(withEnv({ LIVE_TODO_SECRET_GITHUB_WORK_TOKEN: "ghp_secret" })));

  it.effect("ない秘密情報は none を返す", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretStore;

      assert.isTrue(Option.isNone(yield* secrets.get("github.work.token")));
    }).pipe(withEnv({})));

  it.effect("require でない秘密情報を求めたら、どのキーがないかを示すエラーにする", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretStore;

      const error = yield* Effect.flip(secrets.require("github.work.token"));

      assert.instanceOf(error, MissingSecretError);
      assert.strictEqual(error.key, "github.work.token");
    }).pipe(withEnv({})));
});
