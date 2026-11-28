import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/account.spec.ts";
import { addAccount, changeScope, connect, reject, removeAccount, restoreAccount } from "./account.js";

const user = { kind: "user" } as const;
const sync = { kind: "sync" } as const;
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);
const fresh = () => addAccount({ id: "github-work", origin: "github://me@github.com", label: "会社の GitHub", scope: null }, user, "同じ origin のアカウントはない");
const connected = Effect.gen(function* () {
  return yield* connect(yield* fresh(), user, "通った");
});

describe("アカウントを足す（spec の initial）", () => {
  it.effect("足したら、つないでいない", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* fresh()).status, "つないでいない");
    }));

  it.effect("足すのはユーザーだけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(addAccount({ id: "a", origin: "github://x@github.com", label: "x", scope: null }, sync, "同じ origin のアカウントはない")), "ユーザーだけ");
    }));

  it.effect("同じ origin のアカウントがあれば足せない", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* reasonOf(addAccount({ id: "a", origin: "github://x@github.com", label: "x", scope: null }, user, "足しているアカウントと同じ origin")),
        "同じ origin のアカウントがないときだけ（外したアカウントと同じなら戻す。足しているアカウントと同じなら足せない）",
      );
    }));
});

describe(specOf(Spec.connect), () => {
  it.effect("認証が通れば、つないでいるにして理由を消す", () =>
    Effect.gen(function* () {
      const fixed = yield* connect(yield* reject(yield* connected, sync, "トークンが切れた"), user, "通った");
      assert.deepStrictEqual({ status: fixed.status, problem: fixed.problem }, { status: "つないでいる", problem: null });
    }));

  it.effect(specOf(Spec.connect, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(connect(yield* fresh(), sync, "通った")), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.connect, "つないでいない・つなぎ直しが要るときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(connect(yield* connected, user, "通った")), "つないでいない・つなぎ直しが要るときだけ");
    }));

  it.effect(specOf(Spec.connect, "認証が通ったときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(connect(yield* fresh(), user, "通らない")), "認証が通ったときだけ");
    }));
});

describe(specOf(Spec.reject), () => {
  it.effect("トークンが通らなければ、つなぎ直しが要るにして理由を持つ", () =>
    Effect.gen(function* () {
      const broken = yield* reject(yield* connected, sync, "トークンが切れた");
      assert.deepStrictEqual({ status: broken.status, problem: broken.problem }, { status: "つなぎ直しが要る", problem: "トークンが切れた" });
    }));

  it.effect(specOf(Spec.reject, "同期・アプリだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(reject(yield* connected, user, "トークンが切れた")), "同期・アプリだけ");
    }));

  it.effect(specOf(Spec.reject, "つないでいるときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(reject(yield* fresh(), sync, "トークンが切れた")), "つないでいるときだけ");
    }));
});

describe(specOf(Spec.changeScope), () => {
  it.effect("権限が増えるなら、つなぎ直しが要るにする", () =>
    Effect.gen(function* () {
      const changed = yield* changeScope(yield* connected, user, "権限が増える", { repositories: ["acme/*"] });
      assert.deepStrictEqual({ status: changed.status, problem: changed.problem, scope: changed.scope }, { status: "つなぎ直しが要る", problem: "権限を増やした", scope: { repositories: ["acme/*"] } });
    }));

  it.effect(specOf(Spec.changeScope, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(changeScope(yield* connected, sync, "変わらない", null)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.changeScope, "外していないときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(changeScope(yield* removeAccount(yield* connected, user), user, "変わらない", null)), "外していないときだけ");
    }));
});

describe(specOf(Spec.remove), () => {
  it.effect(specOf(Spec.remove, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(removeAccount(yield* connected, sync)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.remove, "外していないときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(removeAccount(yield* removeAccount(yield* connected, user), user)), "外していないときだけ");
    }));
});

describe(specOf(Spec.restore), () => {
  it.effect("外したアカウントを戻すと、つなぎ直しから始める", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* restoreAccount(yield* removeAccount(yield* connected, user), user)).status, "つないでいない");
    }));

  it.effect(specOf(Spec.restore, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(restoreAccount(yield* removeAccount(yield* connected, user), sync)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.restore, "外したときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(restoreAccount(yield* connected, user)), "外したときだけ");
    }));
});
