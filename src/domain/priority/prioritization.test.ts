import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/prioritization.spec.ts";
import { basisChanged, clearByUser, decideByRule, judge, type Prioritization, resume, setByUser, start, stop } from "./prioritization.js";

const sync = { kind: "sync" } as const;
const decisions = { kind: "decisions" } as const;
const user = { kind: "user" } as const;

const fresh = () => start({ taskId: "t1", basis: "b1" }, sync);
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);

describe("優先度を決め始める（spec の initial）", () => {
  it.effect("Task ができたら、未判定で決め始める", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* fresh(), { status: "未判定", taskId: "t1", priority: null, basisFingerprint: "b1", drivenByItemId: null });
    }));

  it.effect("決め始めるのは同期だけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(start({ taskId: "t1", basis: "b1" }, user)), "同期だけ");
    }));
});

describe(specOf(Spec.decideByRule), () => {
  it.effect("規則でラベルが出たら、アプリが決めたにして理由を持つ", () =>
    Effect.gen(function* () {
      const p = yield* decideByRule(yield* fresh(), sync, "3 日以内", "期日まで 3 日");
      assert.deepStrictEqual({ status: p.status, priority: p.priority }, { status: "アプリが決めた", priority: { level: "3 日以内", reason: "期日まで 3 日" } });
    }));

  it.effect(specOf(Spec.decideByRule, "同期だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(decideByRule(yield* fresh(), decisions, "今日中", "x")), "同期だけ");
    }));

  it.effect(specOf(Spec.decideByRule, "未判定・ラベル未定のときだけ"), () =>
    Effect.gen(function* () {
      const decided = yield* decideByRule(yield* fresh(), sync, "今日中", "x");
      assert.strictEqual(yield* reasonOf(decideByRule(decided, sync, "今日中", "x")), "未判定・ラベル未定のときだけ");
    }));

  it.effect(specOf(Spec.decideByRule, "規則でラベルが出たときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(decideByRule(yield* fresh(), sync, "規則では決めない", "x")), "規則でラベルが出たときだけ");
      assert.strictEqual(yield* reasonOf(decideByRule(yield* fresh(), sync, "今日中以上（今すぐかは判定）", "x")), "規則でラベルが出たときだけ");
    }));
});

describe(specOf(Spec.judge), () => {
  it.effect("規則で決まらなかったものは、Decisions の答えのラベルにする", () =>
    Effect.gen(function* () {
      const p = yield* judge(yield* fresh(), decisions, "規則では決めない", "10 日以内", "b1");
      assert.deepStrictEqual(p.priority, { level: "10 日以内", reason: "判定した" });
    }));

  it.effect("答えが返らない・閾値の間なら、低い優先度ではなくラベル未定にする", () =>
    Effect.gen(function* () {
      const p = yield* judge(yield* fresh(), decisions, "規則では決めない", "閾値の間・断られた・形に合わない", "b1");
      assert.deepStrictEqual({ status: p.status, priority: p.priority }, { status: "ラベル未定", priority: null });
    }));

  it.effect("他の人を止めているものは、今すぐと判定されなければ今日中にする（迷っても後回しにしない）", () =>
    Effect.gen(function* () {
      const p = yield* judge(yield* fresh(), decisions, "今日中以上（今すぐかは判定）", "答えが返らない", "b1");
      assert.deepStrictEqual(p.priority, { level: "今日中", reason: "他の人を止めている" });
      const now = yield* judge(yield* fresh(), decisions, "今日中以上（今すぐかは判定）", "今すぐ", "b1");
      assert.deepStrictEqual(now.priority, { level: "今すぐ", reason: "判定した" });
    }));

  it.effect(specOf(Spec.judge, "Decisions だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(judge(yield* fresh(), sync, "規則では決めない", "今日中", "b1")), "Decisions だけ");
    }));

  it.effect(specOf(Spec.judge, "未判定・ラベル未定のときだけ"), () =>
    Effect.gen(function* () {
      const decided = yield* judge(yield* fresh(), decisions, "規則では決めない", "今日中", "b1");
      assert.strictEqual(yield* reasonOf(judge(decided, decisions, "規則では決めない", "今日中", "b1")), "未判定・ラベル未定のときだけ");
    }));

  it.effect(specOf(Spec.judge, "規則で決まらなかったときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(judge(yield* fresh(), decisions, "今日中", "今日中", "b1")), "規則で決まらなかったときだけ");
    }));

  it.effect(specOf(Spec.judge, "判定に渡した材料が今のものと同じときだけ（判定の間に材料が変わったら、答えを捨てて判定し直す）"), () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* reasonOf(judge(yield* fresh(), decisions, "規則では決めない", "今日中", "b0")),
        "判定に渡した材料が今のものと同じときだけ（判定の間に材料が変わったら、答えを捨てて判定し直す）",
      );
    }));
});

describe(specOf(Spec.setByUser), () => {
  it.effect("ユーザーが決めたラベルは、理由を「あなたが決めた」にする", () =>
    Effect.gen(function* () {
      const p = yield* setByUser(yield* fresh(), user, "今すぐ");
      assert.deepStrictEqual({ status: p.status, priority: p.priority }, { status: "ユーザーが決めた", priority: { level: "今すぐ", reason: "あなたが決めた" } });
    }));

  it.effect(specOf(Spec.setByUser, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(setByUser(yield* fresh(), sync, "今すぐ")), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.setByUser, "Task が開いているときだけ"), () =>
    Effect.gen(function* () {
      const stopped = yield* stop(yield* fresh(), sync);
      assert.strictEqual(yield* reasonOf(setByUser(stopped, user, "今すぐ")), "Task が開いているときだけ");
    }));
});

describe(specOf(Spec.clearByUser), () => {
  it.effect("外すと未判定に戻し、決め直すまでユーザーが決めたラベルのまま並べる", () =>
    Effect.gen(function* () {
      const p = yield* clearByUser(yield* setByUser(yield* fresh(), user, "今すぐ"), user);
      assert.deepStrictEqual({ status: p.status, level: p.priority?.level }, { status: "未判定", level: "今すぐ" });
    }));

  it.effect(specOf(Spec.clearByUser, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(clearByUser(yield* setByUser(yield* fresh(), user, "今すぐ"), sync)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.clearByUser, "ユーザーが決めたときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(clearByUser(yield* fresh(), user)), "ユーザーが決めたときだけ");
    }));
});

describe(specOf(Spec.basisChanged), () => {
  it.effect("アプリが決めたラベルは決め直す（決め直す間は前のラベルのまま）", () =>
    Effect.gen(function* () {
      const decided = yield* decideByRule(yield* fresh(), sync, "3 日以内", "期日まで 3 日");
      const p = yield* basisChanged(decided, sync, "b2");
      assert.deepStrictEqual({ status: p.status, basis: p.basisFingerprint, level: p.priority?.level }, { status: "未判定", basis: "b2", level: "3 日以内" });
    }));

  it.effect("ラベル未定は、決まるまでラベル未定のまま", () =>
    Effect.gen(function* () {
      const undecided = yield* judge(yield* fresh(), decisions, "規則では決めない", "答えが返らない", "b1");
      assert.strictEqual((yield* basisChanged(undecided, sync, "b2")).status, "ラベル未定");
    }));

  it.effect(specOf(Spec.basisChanged, "同期だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(basisChanged(yield* fresh(), user, "b2")), "同期だけ");
    }));

  it.effect(specOf(Spec.basisChanged, "ユーザーが決めたラベルは変えない"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(basisChanged(yield* setByUser(yield* fresh(), user, "今すぐ"), sync, "b2")), "ユーザーが決めたラベルは変えない");
    }));

  it.effect(specOf(Spec.basisChanged, "Task が開いているときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(basisChanged(yield* stop(yield* fresh(), sync), sync, "b2")), "Task が開いているときだけ");
    }));
});

describe(specOf(Spec.stop), () => {
  it.effect(specOf(Spec.stop, "同期だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(stop(yield* fresh(), user)), "同期だけ");
    }));

  it.effect(specOf(Spec.stop, "Task が開いているときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(stop(yield* stop(yield* fresh(), sync), sync)), "Task が開いているときだけ");
    }));

  it.effect(specOf(Spec.stop, "アプリが決めるときだけ"), () =>
    Effect.gen(function* () {
      const byUser: Prioritization = yield* setByUser(yield* fresh(), user, "今日中");
      assert.strictEqual(yield* reasonOf(stop(byUser, sync)), "アプリが決めるときだけ");
    }));
});

describe(specOf(Spec.resume), () => {
  it.effect("やり直した Task は、未判定から決め直す", () =>
    Effect.gen(function* () {
      const p = yield* resume(yield* stop(yield* fresh(), sync), sync, "b3");
      assert.deepStrictEqual({ status: p.status, basis: p.basisFingerprint }, { status: "未判定", basis: "b3" });
    }));

  it.effect(specOf(Spec.resume, "同期だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(resume(yield* stop(yield* fresh(), sync), user, "b3")), "同期だけ");
    }));

  it.effect(specOf(Spec.resume, "決めるのをやめたときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(resume(yield* fresh(), sync, "b3")), "決めるのをやめたときだけ");
    }));
});
