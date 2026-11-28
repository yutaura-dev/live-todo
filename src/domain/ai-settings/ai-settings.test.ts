import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/ai-settings.spec.ts";
import { type AiSettings, configure, initialSettings, reject } from "./ai-settings.js";

const user = { kind: "user" } as const;
const app = { kind: "app" } as const;
const decisions = { provider: "openai-decisions", model: "gpt-6-luna" };
const generation = { provider: "anthropic", model: "claude-sonnet-5-5" };
const agent = { provider: "claude-code", model: null };
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);

const ready = Effect.gen(function* () {
  const one = yield* configure(initialSettings, user, "decisions", decisions, "通った");
  const two = yield* configure(one, user, "generation", generation, "通った");
  return yield* configure(two, user, "agent", agent, "通った");
});

describe("AI 設定を始める（spec の initial）", () => {
  it("初めは何も設定しておらず、初期設定中", () => {
    assert.deepStrictEqual(initialSettings, { status: "初期設定中", uses: { decisions: null, generation: null, agent: null }, problem: null });
  });
});

describe(specOf(Spec.configure), () => {
  it.effect("1 つ設定しただけでは、まだ初期設定中", () =>
    Effect.gen(function* () {
      const settings = yield* configure(initialSettings, user, "decisions", decisions, "通った");
      assert.deepStrictEqual({ status: settings.status, uses: settings.uses }, { status: "初期設定中", uses: { decisions, generation: null, agent: null } });
    }));

  it.effect("3 つとも設定して確かめたら、使える", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* ready).status, "使える");
    }));

  it.effect("認証が通らなくなった使い道を直したら、また使える", () =>
    Effect.gen(function* () {
      const broken = yield* reject(yield* ready, app, { use: "Decisions", reason: "API キーが切れた" });
      const fixed = yield* configure(broken, user, "decisions", decisions, "通った");
      assert.deepStrictEqual({ status: fixed.status, problem: fixed.problem }, { status: "使える", problem: null });
    }));

  it.effect(specOf(Spec.configure, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(configure(initialSettings, app, "decisions", decisions, "通った")), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.configure, "認証を確かめて通ったときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(configure(initialSettings, user, "decisions", decisions, "通らない")), "認証を確かめて通ったときだけ");
    }));
});

describe(specOf(Spec.reject), () => {
  it.effect("認証が通らなかったら、どの使い道で・なぜかを持って使えないにする", () =>
    Effect.gen(function* () {
      const settings: AiSettings = yield* reject(yield* ready, app, { use: "Generation", reason: "権限がない" });
      assert.deepStrictEqual({ status: settings.status, problem: settings.problem }, { status: "使えない", problem: { use: "Generation", reason: "権限がない" } });
    }));

  it.effect(specOf(Spec.reject, "アプリだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(reject(yield* ready, user, { use: "Decisions", reason: "API キーが切れた" })), "アプリだけ");
    }));

  it.effect(specOf(Spec.reject, "使えるときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(reject(initialSettings, app, { use: "Decisions", reason: "API キーが切れた" })), "使えるときだけ");
    }));
});
