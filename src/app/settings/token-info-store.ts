import { Effect, FileSystem, Option, Schema, Semaphore } from "effect";

const TokenInfo = Schema.Struct({
  login: Schema.String,
  scopes: Schema.Array(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
  verifiedAt: Schema.String,
});
export type StoredTokenInfo = typeof TokenInfo.Type;

const TokenInfoFile = Schema.Struct({ accounts: Schema.Record(Schema.String, TokenInfo) });
const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(TokenInfoFile));

/**
 * GitHub のトークンを検証した結果（持ち主・権限・有効期限）をアカウントごとに残す。
 * 期限の警告を出すたびに GitHub へ確かめに行かずに済むようにするため。秘密情報ではないので暗号化しない。
 */
export const makeTokenInfoStore = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const writes = yield* Semaphore.make(1);

  const all: Effect.Effect<Record<string, StoredTokenInfo>> = Effect.gen(function* () {
    if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return {};
    const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    return Option.match(decodeFile(text), { onNone: () => ({}), onSome: (file) => ({ ...file.accounts }) });
  });

  const update = (change: (accounts: Record<string, StoredTokenInfo>) => Record<string, StoredTokenInfo>) =>
    Semaphore.withPermits(
      writes,
      1,
      Effect.gen(function* () {
        const accounts = change(yield* all);
        yield* fs.writeFileString(path, `${JSON.stringify({ accounts }, null, 2)}\n`);
      }),
    );

  return {
    all,
    save: (accountId: string, info: StoredTokenInfo) => update((accounts) => ({ ...accounts, [accountId]: info })),
    remove: (accountId: string) =>
      update((accounts) => {
        const { [accountId]: _removed, ...rest } = accounts;
        return rest;
      }),
  };
});
