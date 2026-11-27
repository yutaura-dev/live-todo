import { Config, ConfigProvider, Context, Effect, Layer, Option, type Redacted, Schema } from "effect";

export class MissingSecretError extends Schema.TaggedError<MissingSecretError>()("MissingSecretError", {
  key: Schema.String,
}) {
  override get message() {
    return `秘密情報「${this.key}」が登録されていない`;
  }
}

export class SecretStore extends Context.Service<SecretStore, {
  /** key の例: "github.work.token"。値は Redacted なので、ログやエラーに出しても中身は出ない */
  get(key: string): Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  require(key: string): Effect.Effect<Redacted.Redacted<string>, MissingSecretError>;
}>()("live-todo/core/config/SecretStore") {}

const envNameOf = (key: string) => `LIVE_TODO_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** 環境変数（.env.local）から秘密情報を読む実装。開発用で、Electron に載せるときに safeStorage 版に差し替える。 */
export const EnvSecretStore = Layer.effect(
  SecretStore,
  Effect.gen(function* () {
    const provider = yield* ConfigProvider.ConfigProvider;

    const get = (key: string) =>
      Config.option(Config.Redacted(envNameOf(key))).parse(provider).pipe(Effect.orDie);

    return SecretStore.of({
      get,
      require: (key) =>
        get(key).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(new MissingSecretError({ key })), onSome: Effect.succeed })),
        ),
    });
  }),
);
