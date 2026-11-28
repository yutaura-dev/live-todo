import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/agent-thread.spec.ts";
import { lose, openThread, renew } from "./agent-thread.js";

const app = { kind: "app" } as const;
const user = { kind: "user" } as const;
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);
const opened = openThread(app, { taskId: "t1", sessionId: "s1", workspace: "/work/t1" });

describe("最初の作業で、会話を始める（spec の initial）", () => {
  it.effect("会話の ID を先に決めて、続けられる会話にする", () =>
    Effect.gen(function* () {
      const thread = yield* opened;
      assert.deepStrictEqual({ status: thread.status, sessionId: thread.sessionId, provider: thread.provider }, { status: "続けられる", sessionId: "s1", provider: "claude-code" });
    }));

  it.effect("会話を始めるのはアプリだけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(openThread(user, { taskId: "t1", sessionId: "s1", workspace: "/work/t1" })), "アプリだけ");
    }));
});

describe(specOf(Spec.lose), () => {
  it.effect("動いている作業がなければ、続けられないにする", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* lose(yield* opened, app, "動いている作業がない")).status, "続けられない");
    }));

  it.effect(specOf(Spec.lose, "アプリだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(lose(yield* opened, user, "動いている作業がない")), "アプリだけ");
    }));

  it.effect(specOf(Spec.lose, "続けられるときだけ"), () =>
    Effect.gen(function* () {
      const lost = yield* lose(yield* opened, app, "動いている作業がない");
      assert.strictEqual(yield* reasonOf(lose(lost, app, "動いている作業がない")), "続けられるときだけ");
    }));

  it.effect(specOf(Spec.lose, "動いている作業がないときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(lose(yield* opened, app, "動いている作業がある")), "動いている作業がないときだけ");
    }));
});

describe(specOf(Spec.renew), () => {
  it.effect("続けられない会話は、新しい会話の ID で始め直す", () =>
    Effect.gen(function* () {
      const lost = yield* lose(yield* opened, app, "動いている作業がない");
      const renewed = yield* renew(lost, app, "s2");
      assert.deepStrictEqual({ status: renewed.status, sessionId: renewed.sessionId }, { status: "続けられる", sessionId: "s2" });
    }));

  it.effect(specOf(Spec.renew, "アプリだけ"), () =>
    Effect.gen(function* () {
      const lost = yield* lose(yield* opened, app, "動いている作業がない");
      assert.strictEqual(yield* reasonOf(renew(lost, user, "s2")), "アプリだけ");
    }));

  it.effect(specOf(Spec.renew, "続けられないときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(renew(yield* opened, app, "s2")), "続けられないときだけ");
    }));
});
