import { Context, Effect, FileSystem, Layer, Option, Redacted, Schema, Semaphore } from "effect";
import { EnvSecretStore, SecretStore } from "./secret-store.js";

/** OS の暗号化（Electron の safeStorage。macOS ではキーチェーンの鍵）を差し替えられるようにした口 */
export interface SecretCipher {
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<Uint8Array>;
  decrypt(data: Uint8Array): Promise<string>;
}

export class SecretVaultError extends Schema.TaggedError<SecretVaultError>()("SecretVaultError", {
  message: Schema.String,
}) {}

/** 秘密情報を書き換える口。読む側（SecretStore）と分け、書けるのは設定画面の処理だけにする */
export class SecretVault extends Context.Service<SecretVault, {
  set(key: string, value: Redacted.Redacted<string>): Effect.Effect<void, SecretVaultError>;
  remove(key: string): Effect.Effect<void, SecretVaultError>;
  /** 保存してあるキー（値は返さない） */
  readonly storedKeys: Effect.Effect<ReadonlyArray<string>>;
}>()("live-todo/core/config/SecretVault") {}

const SecretsFile = Schema.Struct({ secrets: Schema.Record(Schema.String, Schema.String) });
const decodeSecretsFile = Schema.decodeUnknownOption(Schema.fromJsonString(SecretsFile));

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export const encryptedFileSecretStore = (options: { path: string; cipher: SecretCipher }) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const env = yield* Effect.gen(function* () {
        return yield* SecretStore;
      }).pipe(Effect.provide(EnvSecretStore));
      const writes = yield* Semaphore.make(1);
      const fail = (message: string) => () => new SecretVaultError({ message });

      const readAll: Effect.Effect<Record<string, string>> = Effect.gen(function* () {
        if (!(yield* fs.exists(options.path).pipe(Effect.orElseSucceed(() => false)))) return {};
        const text = yield* fs.readFileString(options.path).pipe(Effect.orElseSucceed(() => ""));
        return Option.match(decodeSecretsFile(text), {
          onNone: () => ({}),
          onSome: (file): Record<string, string> => ({ ...file.secrets }),
        });
      });

      // 一時ファイルに書いてから置き換える理由: 書いている途中で落ちても、保存済みの秘密情報を壊さないため
      const writeAll = (secrets: Record<string, string>) =>
        Effect.gen(function* () {
          const temporary = `${options.path}.tmp`;
          yield* fs.writeFileString(temporary, JSON.stringify({ secrets }, null, 2), { mode: 0o600 });
          yield* fs.chmod(temporary, 0o600);
          yield* fs.rename(temporary, options.path);
        }).pipe(Effect.mapError(fail(`秘密情報を保存できない: ${options.path}`)));

      const get = (key: string) =>
        Effect.gen(function* () {
          const stored = (yield* readAll)[key];
          if (stored === undefined) return yield* env.get(key);
          return yield* Effect.tryPromise({
            try: async () => Option.some(Redacted.make(await options.cipher.decrypt(fromBase64(stored)))),
            catch: () => undefined,
          }).pipe(
            Effect.catch(() =>
              Effect.logWarning("保存した秘密情報を復号できない").pipe(Effect.annotateLogs({ key }), Effect.as(Option.none())),
            ),
          );
        });

      const store = SecretStore.of({
        get,
        require: (key) =>
          get(key).pipe(
            Effect.flatMap(
              Option.match({ onNone: () => env.require(key), onSome: (value) => Effect.succeed(value) }),
            ),
          ),
      });

      const vault = SecretVault.of({
        set: (key, value) =>
          Semaphore.withPermits(
            writes,
            1,
            Effect.gen(function* () {
              const available = yield* Effect.promise(() => options.cipher.isAvailable().catch(() => false));
              if (!available) {
                return yield* new SecretVaultError({ message: "OS の暗号化が使えないため、秘密情報を保存しない" });
              }
              const encrypted = yield* Effect.tryPromise({
                try: async () => toBase64(await options.cipher.encrypt(Redacted.value(value))),
                catch: fail("秘密情報を暗号化できない"),
              });
              yield* writeAll({ ...(yield* readAll), [key]: encrypted });
            }),
          ),
        remove: (key) =>
          Semaphore.withPermits(
            writes,
            1,
            Effect.gen(function* () {
              const { [key]: _removed, ...rest } = yield* readAll;
              yield* writeAll(rest);
            }),
          ),
        storedKeys: Effect.map(readAll, (secrets) => Object.keys(secrets).sort()),
      });

      return Context.make(SecretStore, store).pipe(Context.add(SecretVault, vault));
    }),
  );
