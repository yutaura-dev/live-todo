import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { decodeMergeRequest, decodeFilterPreviewRequest, decodeMoveRequest, decodeSecretInput, decodeSecretKey, decodeTaskId, isAllowedExternalUrl } from "./ipc.js";

describe("isAllowedExternalUrl", () => {
  it.each(["https://github.com/acme/app/pull/42", "https://github.com/acme/app/issues/7#issuecomment-1"])(
    "github.com の https の URL は開いてよい: %s",
    (url) => {
      assert.isTrue(isAllowedExternalUrl(url));
    },
  );

  it.each([
    "http://github.com/acme/app",
    "https://github.com.evil.example/x",
    "https://evil.example/https://github.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ])("それ以外の URL は開かない: %s", (url) => {
    assert.isFalse(isAllowedExternalUrl(url));
  });
});

describe("decodeMoveRequest", () => {
  it.effect("Task の id と、動かせるステータスを受け取る", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodeMoveRequest({ taskId: 3, status: "dismissed" }), { taskId: 3, status: "dismissed" });
    }));

  it.effect.each([
    { taskId: "3", status: "todo" },
    { taskId: 1.5, status: "todo" },
    { taskId: 3, status: "archived" },
    { taskId: 3, status: "deleted" },
    null,
  ])("想定外の値はエラーにする: %j", (input) =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* Effect.option(decodeMoveRequest(input))));
    }));
});

describe("decodeTaskId", () => {
  it.effect("正の整数だけを Task の id として受け取る", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decodeTaskId(5), 5);
      assert.isTrue(Option.isNone(yield* Effect.option(decodeTaskId(-1))));
    }));
});

describe("decodeSecretKey", () => {
  it.effect.each(["github.work.token", "github.my-account.token", "llm.anthropic.api_key", "llm.openai.api_key"])(
    "アプリが使う秘密情報のキーを受け取る: %s",
    (key) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* decodeSecretKey(key), key);
      }),
  );

  it.effect.each(["github.work", "github.Work.token", "github.a:b.token", "llm.gemini.api_key", "anything", 1])(
    "それ以外のキーはエラーにする: %s",
    (key) =>
      Effect.gen(function* () {
        assert.isTrue(Option.isNone(yield* Effect.option(decodeSecretKey(key))));
      }),
  );
});

describe("decodeSecretInput", () => {
  it.effect("前後の空白を除いた値を受け取る", () =>
    Effect.gen(function* () {
      const input = yield* decodeSecretInput({ key: "github.work.token", value: "  ghp_x \n" });
      assert.strictEqual(input.value, "ghp_x");
    }));

  it.effect("空の値はエラーにする（消すときは削除の操作を使う）", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* Effect.option(decodeSecretInput({ key: "github.work.token", value: "   " }))));
    }));
});

describe("decodeFilterPreviewRequest", () => {
  it.effect("アカウント・フィルタ・確かめたい対象を受け取る", () =>
    Effect.gen(function* () {
      const request = yield* decodeFilterPreviewRequest({
        accountId: "work",
        filter: { include: ["acme/*"], exclude: [] },
        targets: ["https://github.com/acme/app/pull/1"],
      });
      assert.deepStrictEqual(request.targets, ["https://github.com/acme/app/pull/1"]);
    }));

  it.effect("確かめる対象が多すぎるとエラーにする", () =>
    Effect.gen(function* () {
      const targets = Array.from({ length: 101 }, (_, index) => `acme/repo-${index}`);
      assert.isTrue(Option.isNone(yield* Effect.option(decodeFilterPreviewRequest({ accountId: "work", filter: {}, targets }))));
    }));
});

describe("decodeMergeRequest", () => {
  const sha = "a".repeat(40);

  it.effect("Task の id・merge の方法・確認した commit を受け取る", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodeMergeRequest({ taskId: 3, method: "squash", sha }), { taskId: 3, method: "squash", sha });
    }));

  it.effect.each([
    { taskId: 3, method: "fast-forward", sha },
    { taskId: 3, method: "squash", sha: "abc" },
    { taskId: 3, method: "squash", sha: "z".repeat(40) },
    { taskId: 3, method: "squash" },
  ])("想定外の値はエラーにする: %j", (input) =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* Effect.option(decodeMergeRequest(input))));
    }));
});
