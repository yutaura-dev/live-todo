import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/routing.spec.ts";
import { addTask, createTask, factChanged, linkTo, placeWork, removeTask, route, routeByUser, startRouting } from "./routing.js";

const sync = { kind: "sync" } as const;
const ai = { kind: "agent" } as const;
const user = { kind: "user" } as const;
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);
const fresh = () => startRouting("s1", sync);

// spec の判断表の cases を、実装の関数にそのまま当てる
describe("振り分けの判断表", () => {
  const tables = [
    ["1. 候補の Task の事実にするか（緩めに紐づける）", linkTo],
    ["2. 紐づけた Task の計画に足すか（その Task が終わっても、作業が残るか）", placeWork],
    ["3. 新しい Task を生むか（作業ごと）", createTask],
  ] as const;
  for (const [name, decide] of tables) {
    for (const { input, expect } of Spec.decisions[name].cases) {
      it(`${name}: ${JSON.stringify(input)} → ${expect}`, () => {
        assert.strictEqual((decide as (i: never) => string)(input as never), expect);
      });
    }
  }
});

describe("振り分けを始める（spec の initial）", () => {
  it.effect("届いた事実は、未振り分けから始まる", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* fresh(), { status: "未振り分け", sourceItemId: "s1", judgment: null });
    }));
});

describe(specOf(Spec.route), () => {
  it.effect("対象外・判断できなかった・それ以外で、段階を分ける", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* route(yield* fresh(), ai, "対象外", "j")).status, "対象外");
      assert.strictEqual((yield* route(yield* fresh(), ai, "判断できなかった", "j")).status, "ユーザー待ち");
      assert.deepStrictEqual(yield* route(yield* fresh(), ai, "新しい Task を作る", "routing v1"), { status: "振り分けた", sourceItemId: "s1", judgment: "routing v1" });
    }));

  it.effect(specOf(Spec.route, "同期か AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(route(yield* fresh(), user, "対象外", "j")), "同期か AI だけ");
    }));

  it.effect(specOf(Spec.route, "まだ振り分けていないときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(route(yield* route(yield* fresh(), ai, "対象外", "j"), ai, "対象外", "j")), "まだ振り分けていないときだけ");
    }));

  it.effect(specOf(Spec.route, "提案と判断できなかったは AI だけ（同期は識別子と規則で決まるものしか決めない）"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(route(yield* fresh(), sync, "提案にする", "j")), "提案と判断できなかったは AI だけ（同期は識別子と規則で決まるものしか決めない）");
    }));
});

describe(specOf(Spec.routeByUser), () => {
  it.effect(specOf(Spec.routeByUser, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(routeByUser(yield* route(yield* fresh(), ai, "判断できなかった", "j"), ai, "対象外")), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.routeByUser, "自動の振り分けのあとだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(routeByUser(yield* fresh(), user, "対象外")), "自動の振り分けのあとだけ");
    }));

  it.effect("ユーザー待ちの事実を、ユーザーが既存の Task に持たせる", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* routeByUser(yield* route(yield* fresh(), ai, "判断できなかった", "j"), user, "既存の Task の事実にする")).status, "振り分けた");
    }));
});

describe(specOf(Spec.addTask), () => {
  it.effect(specOf(Spec.addTask, "振り分けたあとだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(addTask(yield* fresh(), ai)), "振り分けたあとだけ");
    }));
});

describe(specOf(Spec.removeTask), () => {
  it.effect("どの Task にも残らなければ、ユーザー待ちにする", () =>
    Effect.gen(function* () {
      const routed = yield* route(yield* fresh(), ai, "既存の Task の事実にする", "j");
      assert.strictEqual((yield* removeTask(routed, user, "どの Task にも残らない")).status, "ユーザー待ち");
      assert.strictEqual((yield* removeTask(routed, user, "ほかの Task に残る")).status, "振り分けた");
    }));

  it.effect(specOf(Spec.removeTask, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(removeTask(yield* route(yield* fresh(), ai, "既存の Task の事実にする", "j"), ai, "ほかの Task に残る")), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.removeTask, "振り分けたあとだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(removeTask(yield* fresh(), user, "ほかの Task に残る")), "振り分けたあとだけ");
    }));
});

describe(specOf(Spec.factChanged), () => {
  it.effect("対象外にした事実が変わったら、振り分けをやり直す", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* factChanged(yield* route(yield* fresh(), ai, "対象外", "j"), sync, "開いている Task がある")).status, "未振り分け");
    }));

  it.effect("持ち主の Task がすべて終わっていたら、振り分けをやり直す", () =>
    Effect.gen(function* () {
      const routed = yield* route(yield* fresh(), ai, "既存の Task の事実にする", "j");
      assert.strictEqual((yield* factChanged(routed, sync, "持ち主の Task がすべて終わった")).status, "未振り分け");
      assert.strictEqual((yield* factChanged(routed, sync, "開いている Task がある")).status, "振り分けた");
    }));

  it.effect(specOf(Spec.factChanged, "同期だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(factChanged(yield* fresh(), ai, "開いている Task がある")), "同期だけ");
    }));
});
