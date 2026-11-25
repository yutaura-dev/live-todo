import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { makeTokenInfoStore } from "./token-info-store.js";

const inTempDir = <A, E>(use: (path: string) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* use(`${yield* fs.makeTempDirectoryScoped()}/github-tokens.json`);
  }).pipe(Effect.provide(NodeFileSystem.layer));

const info = { login: "octocat", scopes: ["repo"], expiresAt: "2026-12-05T00:00:00.000Z", verifiedAt: "2026-11-25T00:00:00.000Z" };

describe("makeTokenInfoStore", () => {
  it.effect("ファイルがなければ空として扱う", () =>
    inTempDir((path) =>
      Effect.gen(function* () {
        const store = yield* makeTokenInfoStore(path);

        assert.deepStrictEqual(yield* store.all, {});
      }),
    ));

  it.effect("アカウントごとに検証の結果を保存し、作り直しても読める", () =>
    inTempDir((path) =>
      Effect.gen(function* () {
        yield* (yield* makeTokenInfoStore(path)).save("work", info);

        assert.deepStrictEqual(yield* (yield* makeTokenInfoStore(path)).all, { work: info });
      }),
    ));

  it.effect("期限のないトークンの結果も保存できる", () =>
    inTempDir((path) =>
      Effect.gen(function* () {
        const store = yield* makeTokenInfoStore(path);
        const { expiresAt: _omitted, ...withoutExpiry } = info;

        yield* store.save("work", withoutExpiry);

        assert.deepStrictEqual(yield* store.all, { work: withoutExpiry });
      }),
    ));

  it.effect("削除したアカウントの結果は消える", () =>
    inTempDir((path) =>
      Effect.gen(function* () {
        const store = yield* makeTokenInfoStore(path);
        yield* store.save("work", info);
        yield* store.save("personal", info);

        yield* store.remove("work");

        assert.deepStrictEqual(Object.keys(yield* store.all), ["personal"]);
      }),
    ));
});
