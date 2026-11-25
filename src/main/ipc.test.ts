import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { decodeMoveRequest, decodeTaskId, isAllowedExternalUrl } from "./ipc.js";

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
