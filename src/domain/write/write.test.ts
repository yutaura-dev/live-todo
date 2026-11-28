import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import * as Spec from "../../../specs/write.spec.ts";
import { abandon, approve, cancel, fail, interrupt, requestWrite, settle, succeed, withdraw, type Write, type WriteRequest } from "./write.js";

const user = { kind: "user" } as const;
const app = { kind: "app" } as const;
const sync = { kind: "sync" } as const;
const target = { kind: "target" } as const;
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);
const content = {
  id: "w1",
  subject: { uri: "github://me@github.com/acme/app/pull/42" },
  place: null,
  operation: "github.merge",
  params: { method: "squash" },
  version: "abc1234",
  summary: "squash で merge する",
  requestedBy: { type: "actionItem" as const, taskId: "t1", actionItemId: "a3" },
};
const fromItem: WriteRequest = { way: "Action Item", item: "番が来ていて、まだ", sameAsDefinition: true, openWrite: false, policy: "ユーザーが頼む・承認する", taskColumn: "やること", trigger: "on_request", planVersion: "計画の版のまま", autoTried: false };
const fromEffect: WriteRequest = { way: "完了したときにすること", confirmed: true, openWrite: false, version: "版を持たない" };
const asked = Effect.gen(function* () {
  yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
  return yield* requestWrite(content, user, fromItem, "書き込める");
});
const writing = Effect.gen(function* () {
  return yield* approve(yield* asked, user, "見せた版のまま", "書き込める");
});
const unknown: Effect.Effect<Write, unknown> = Effect.gen(function* () {
  return yield* interrupt(yield* writing, app);
});

describe("書き込みを頼む（spec の initial）", () => {
  it.effect("Action Item からユーザーが頼んだ書き込みは、中身を見せて承認待ちにする", () =>
    Effect.gen(function* () {
      const write = yield* asked;
      assert.deepStrictEqual({ stage: write.stage, approval: write.approval }, { stage: "承認待ち", approval: null });
    }));

  it.effect("完了のボタンから頼んだ書き込みは、押したことを承認として、すぐ書き込む", () =>
    Effect.gen(function* () {
      const write = yield* requestWrite({ ...content, requestedBy: { type: "completionEffect", taskId: "t1", effectId: "ce1" } }, app, fromEffect, "書き込める");
      assert.deepStrictEqual({ stage: write.stage, by: write.approval?.by }, { stage: "書き込み中", by: "完了のボタン" });
    }));

  it.effect("Action Item からはユーザー（自動でやってよい範囲ならアプリも）、完了したときにすることからはアプリだけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(requestWrite(content, app, fromItem, "書き込める")), "Action Item からはユーザー（自動でやってよい範囲ならアプリも）、完了したときにすることからはアプリだけ");
      assert.strictEqual(yield* reasonOf(requestWrite(content, user, fromEffect, "書き込める")), "Action Item からはユーザー（自動でやってよい範囲ならアプリも）、完了したときにすることからはアプリだけ");
    }));

  it.effect("書き込める状態のときだけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(requestWrite(content, user, fromItem, "書き込めない")), "書き込める状態のときだけ");
    }));

  it.effect("Action Item に番が来ていて、まだ済んでいないときだけ・定義と同じ・終わっていない書き込みがないときだけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(requestWrite(content, user, { ...fromItem, item: "番待ち" }, "書き込める")), "Action Item に番が来ていて、まだ済んでいないときだけ");
      assert.strictEqual(yield* reasonOf(requestWrite(content, user, { ...fromItem, sameAsDefinition: false }, "書き込める")), "Action Item の定義と同じ対象・操作・作る場所だけ");
      assert.strictEqual(yield* reasonOf(requestWrite(content, user, { ...fromItem, openWrite: true }, "書き込める")), "その Action Item に、終わっていない書き込みがないときだけ");
    }));

  it.effect("完了のボタンからは、押したときだけ・終わっていない書き込みがないときだけ・版が同じときだけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(requestWrite(content, app, { ...fromEffect, confirmed: false } as WriteRequest, "書き込める")), "ユーザーが完了待ちのチェックリストを確かめて、完了のボタンを押したときだけ");
      assert.strictEqual(yield* reasonOf(requestWrite(content, app, { ...fromEffect, openWrite: true } as WriteRequest, "書き込める")), "その完了したときにすることに、終わっていない書き込みがないときだけ");
      assert.strictEqual(yield* reasonOf(requestWrite(content, app, { ...fromEffect, version: "変わった" } as WriteRequest, "書き込める")), "版を持つ操作なら、見せたときの版が今も同じときだけ");
    }));

  it.effect("自動で書き込むのは、自動でやる Action Item・やることの Task・計画の版のまま・1 回だけ", () =>
    Effect.gen(function* () {
      const auto: WriteRequest = { ...fromItem, policy: "自動でやる", trigger: "auto" } as WriteRequest;
      assert.strictEqual((yield* requestWrite(content, app, auto, "書き込める")).approval?.by, "自動でやってよい範囲");
      assert.strictEqual(yield* reasonOf(requestWrite(content, app, { ...auto, trigger: "on_request" } as WriteRequest, "書き込める")), "自動で書き込むのは、番が来たら自動でやる Action Item だけ（ボタンで頼むものは、ユーザーが頼む）");
      assert.strictEqual(yield* reasonOf(requestWrite(content, app, { ...auto, taskColumn: "完了待ち" } as WriteRequest, "書き込める")), "自動で書き込むのは、Task がやることのときだけ（完了待ちでは、ユーザーが頼む）");
      assert.strictEqual(yield* reasonOf(requestWrite(content, app, { ...auto, planVersion: "変わった" } as WriteRequest, "書き込める")), "自動で書き込むのは、計画を立てたときの版が今も同じときだけ");
      assert.strictEqual(yield* reasonOf(requestWrite(content, app, { ...auto, autoTried: true } as WriteRequest, "書き込める")), "自動で頼むのは、Action Item ごとに 1 回だけ（失敗したあとはユーザーが頼む）");
    }));
});

describe(specOf(Spec.approve), () => {
  it.effect("承認すると、ユーザーが確かめたとして書き込み中にする", () =>
    Effect.gen(function* () {
      const write = yield* writing;
      assert.deepStrictEqual({ stage: write.stage, by: write.approval?.by }, { stage: "書き込み中", by: "ユーザーが確かめた" });
    }));

  it.effect(specOf(Spec.approve, "ユーザーだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(approve(yield* asked, app, "見せた版のまま", "書き込める")), "ユーザーだけ"); }));
  it.effect(specOf(Spec.approve, "確認中のときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(approve(yield* writing, user, "見せた版のまま", "書き込める")), "確認中のときだけ"); }));
  it.effect(specOf(Spec.approve, "見せた版が今も同じときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(approve(yield* asked, user, "変わった", "書き込める")), "見せた版が今も同じときだけ"); }));
  it.effect(specOf(Spec.approve, "書き込める状態のときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(approve(yield* asked, user, "見せた版のまま", "書き込めない")), "書き込める状態のときだけ"); }));
});

describe(specOf(Spec.cancel), () => {
  it.effect(specOf(Spec.cancel, "ユーザーだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(cancel(yield* asked, app)), "ユーザーだけ"); }));
  it.effect(specOf(Spec.cancel, "確認中のときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(cancel(yield* writing, user)), "確認中のときだけ"); }));
});

describe(specOf(Spec.withdraw), () => {
  it.effect(specOf(Spec.withdraw, "アプリだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(withdraw(yield* asked, user)), "アプリだけ"); }));
  it.effect(specOf(Spec.withdraw, "確認中のときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(withdraw(yield* writing, app)), "確認中のときだけ"); }));
});

describe(specOf(Spec.succeed), () => {
  it.effect(specOf(Spec.succeed, "書き込み先だけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(succeed(yield* writing, app)), "書き込み先だけ"); }));
  it.effect(specOf(Spec.succeed, "書き込み中のときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(succeed(yield* asked, target)), "書き込み中のときだけ"); }));
});

describe(specOf(Spec.fail), () => {
  it.effect("断られたら、理由を残して失敗にする", () =>
    Effect.gen(function* () {
      const write = yield* fail(yield* writing, target, "権限が足りない", "merge する権限がない");
      assert.deepStrictEqual({ stage: write.stage, failure: write.failure }, { stage: "失敗", failure: { kind: "権限が足りない", message: "merge する権限がない" } });
    }));
  it.effect(specOf(Spec.fail, "書き込み先だけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(fail(yield* writing, app, "権限が足りない", "")), "書き込み先だけ"); }));
  it.effect(specOf(Spec.fail, "書き込み中のときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(fail(yield* asked, target, "権限が足りない", "")), "書き込み中のときだけ"); }));
});

describe(specOf(Spec.interrupt), () => {
  it.effect(specOf(Spec.interrupt, "アプリだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(interrupt(yield* writing, user)), "アプリだけ"); }));
  it.effect(specOf(Spec.interrupt, "書き込み中のときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(interrupt(yield* asked, app)), "書き込み中のときだけ"); }));
});

describe(specOf(Spec.settle), () => {
  it.effect("外を確かめて、書けていたら書き込んだ、確かめられなければ失敗にする（やり直さない）", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* settle(yield* unknown, sync, "書けていた")).stage, "書き込んだ");
      assert.deepStrictEqual((yield* settle(yield* unknown, sync, "確かめられない")).failure?.kind, "書けたか確かめられない");
    }));
  it.effect(specOf(Spec.settle, "同期だけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(settle(yield* unknown, app, "書けていた")), "同期だけ"); }));
  it.effect(specOf(Spec.settle, "書けたか分からないときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(settle(yield* writing, sync, "書けていた")), "書けたか分からないときだけ"); }));
});

describe(specOf(Spec.abandon), () => {
  it.effect(specOf(Spec.abandon, "アプリだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(abandon(yield* writing, user)), "アプリだけ"); }));
  it.effect(specOf(Spec.abandon, "書き込み中・書けたか分からないときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* reasonOf(abandon(yield* asked, app)), "書き込み中・書けたか分からないときだけ"); }));
});
