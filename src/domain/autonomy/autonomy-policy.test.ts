import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/autonomy-policy.spec.ts";
import { allowed, clearOperationLimit, initialPolicy, type Level, limitOf, setOperationLimit, type Target } from "./autonomy-policy.js";

const user = { kind: "user" } as const;
const app = { kind: "app" } as const;
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);
const L = "操作の段（Agent の作業なら、渡す道具で決まる段）" as const;

describe("初めの範囲（spec の initial）", () => {
  it.effect("どの操作の上限も決めていない", () => Effect.gen(function* () { assert.deepStrictEqual(yield* initialPolicy(app), { limits: [] }); }));
  it.effect("アプリだけ", () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(initialPolicy(user)), "アプリだけ"); }));
});

describe(specOf(Spec.setOperationLimit), () => {
  it.effect("同じ操作の上限は置き換える", () =>
    Effect.gen(function* () {
      const once = yield* setOperationLimit(yield* initialPolicy(app), user, "github.merge", "外への書き込み（下書き）");
      const twice = yield* setOperationLimit(once, user, "github.merge", "外への書き込み（本番）");
      assert.deepStrictEqual(twice.limits, [{ operation: "github.merge", limit: "外への書き込み（本番）" }]);
    }));
  it.effect(specOf(Spec.setOperationLimit, "ユーザーだけ"), () =>
    Effect.gen(function* () { assert.strictEqual(yield* reasonOf(setOperationLimit({ limits: [] }, app, "github.merge", "調べる")), "ユーザーだけ"); }));
});

describe(specOf(Spec.clearOperationLimit), () => {
  it.effect("外すと、決めていない操作の扱いに戻る", () =>
    Effect.gen(function* () {
      const cleared = yield* clearOperationLimit({ limits: [{ operation: "github.merge", limit: "外への書き込み（本番）" }] }, user, "github.merge");
      assert.strictEqual(limitOf(cleared, "github.merge"), "決めていない");
    }));
  it.effect(specOf(Spec.clearOperationLimit, "ユーザーだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(clearOperationLimit({ limits: [] }, app, "x")), "ユーザーだけ"); }));
});

describe("判断表「自動でやってよいか」", () => {
  for (const { input, expect } of Spec.decisions.自動でやってよいか.cases) {
    it(`${input[L]}・上限 ${input.その操作の上限}・${input.書き込む先} → ${expect}`, () => {
      assert.strictEqual(allowed(input[L] as Level, input.その操作の上限 as Level | "決めていない", input.書き込む先 as Target), expect);
    });
  }
});
