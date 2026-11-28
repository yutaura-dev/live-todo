import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/completion-effect.spec.ts";
import { addEffect, allSettled, check, type CompletionEffect, failed, fire, retry, uncheck, withdraw, written } from "./completion-effect.js";

const ai = { kind: "agent" } as const;
const user = { kind: "user" } as const;
const app = { kind: "app" } as const;
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);
const content = { id: "ce1", title: "PR を merge する", subjectUri: "github://me@github.com/acme/app/pull/42", operation: "github.merge", params: { method: "squash" }, version: null };
const added = addEffect(content, ai);
const requested = Effect.flatMap(added, (effect) => fire(effect, app, "w1"));
const failedOne: Effect.Effect<CompletionEffect, unknown> = Effect.flatMap(requested, (effect) => failed(effect, app));

describe("完了したときにすることを足す（spec の initial）", () => {
  it.effect("AI が足したものも、初めは ☑ で、まだ頼んでいない", () =>
    Effect.gen(function* () {
      const effect = yield* added;
      assert.deepStrictEqual({ checked: effect.checked, delivery: effect.delivery, by: effect.addedBy.type }, { checked: true, delivery: "まだ", by: "AI" });
    }));
  it.effect("AI かユーザーだけ", () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(addEffect(content, app)), "AI かユーザーだけ"); }));
});

describe(specOf(Spec.check), () => {
  it.effect(specOf(Spec.check, "ユーザーだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(check(yield* uncheck(yield* added, user), app)), "ユーザーだけ"); }));
  it.effect(specOf(Spec.check, "☑ を外しているときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(check(yield* added, user)), "☑ を外しているときだけ"); }));
  it.effect(specOf(Spec.check, "まだ・書き込めなかったときだけ"), () =>
    Effect.gen(function* () {
      const done = yield* written(yield* requested, app);
      assert.strictEqual(yield* reasonOf(check({ ...done, checked: false }, user)), "まだ・書き込めなかったときだけ");
    }));
});

describe(specOf(Spec.uncheck), () => {
  it.effect("外したものは書き込まず、ほかが済めば終えてよい", () => Effect.gen(function* () { assert.isTrue(allSettled([yield* uncheck(yield* added, user)])); }));
  it.effect(specOf(Spec.uncheck, "ユーザーだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(uncheck(yield* added, app)), "ユーザーだけ"); }));
  it.effect(specOf(Spec.uncheck, "☑ が付いているときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(uncheck(yield* uncheck(yield* added, user), user)), "☑ が付いているときだけ"); }));
  it.effect(specOf(Spec.uncheck, "まだ・書き込めなかったときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(uncheck(yield* requested, user)), "まだ・書き込めなかったときだけ"); }));
});

describe(specOf(Spec.fire), () => {
  it.effect(specOf(Spec.fire, "アプリだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(fire(yield* added, user, "w1")), "アプリだけ"); }));
  it.effect(specOf(Spec.fire, "☑ が付いているときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(fire(yield* uncheck(yield* added, user), app, "w1")), "☑ が付いているときだけ"); }));
  it.effect(specOf(Spec.fire, "まだ頼んでいないときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(fire(yield* requested, app, "w2")), "まだ頼んでいないときだけ"); }));
});

describe(specOf(Spec.written), () => {
  it.effect(specOf(Spec.written, "アプリだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(written(yield* requested, user)), "アプリだけ"); }));
  it.effect(specOf(Spec.written, "頼んだときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(written(yield* added, app)), "頼んだときだけ"); }));
});

describe(specOf(Spec.failed), () => {
  it.effect("書き込めなかったものは、まだ終えない", () => Effect.gen(function* () { assert.isFalse(allSettled([yield* failedOne])); }));
  it.effect(specOf(Spec.failed, "アプリだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(failed(yield* requested, user)), "アプリだけ"); }));
  it.effect(specOf(Spec.failed, "頼んだときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(failed(yield* added, app)), "頼んだときだけ"); }));
});

describe(specOf(Spec.retry), () => {
  it.effect("もう一度頼むと、新しい書き込みを持つ", () => Effect.gen(function* () { assert.strictEqual((yield* retry(yield* failedOne, user, "w2")).writeId, "w2"); }));
  it.effect(specOf(Spec.retry, "ユーザーだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(retry(yield* failedOne, app, "w2")), "ユーザーだけ"); }));
  it.effect(specOf(Spec.retry, "☑ が付いているときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(retry(yield* uncheck(yield* failedOne, user), user, "w2")), "☑ が付いているときだけ"); }));
  it.effect(specOf(Spec.retry, "書き込めなかったときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(retry(yield* added, user, "w2")), "書き込めなかったときだけ"); }));
});

describe(specOf(Spec.withdraw), () => {
  it.effect(specOf(Spec.withdraw, "アプリだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(withdraw(yield* added, user)), "アプリだけ"); }));
  it.effect(specOf(Spec.withdraw, "頼んで結果を待っていないとき・まだ書き込んでいないときだけ"), () =>
    Effect.gen(function* () { assert.strictEqual(yield* reasonOf(withdraw(yield* requested, app)), "頼んで結果を待っていないとき・まだ書き込んでいないときだけ"); }));
});
