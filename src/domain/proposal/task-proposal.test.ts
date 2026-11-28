import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import * as Spec from "../../../specs/task-proposal.spec.ts";
import { accept, addFact, autoAccept, decline, propose, repropose, withdraw } from "./task-proposal.js";

const ai = { kind: "agent" } as const;
const user = { kind: "user" } as const;
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);
const fresh = (kind: "新しい Task" | "既存の Task に足す" | "切り出す" = "新しい Task") =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.makeUnsafe("2026-11-28T00:00:00Z").epochMilliseconds);
    return yield* propose(
      { id: "p1", kind, title: "PR #42 をレビューする", brief: "レビューを頼まれている", targetTaskId: kind === "新しい Task" ? null : "t1", sourceItemId: "s1", judgment: "routing.work-needs-new-action v1 0.62" },
      ai,
    );
  });

describe("提案する（spec の initial）", () => {
  it.effect("AI が、事実 1 つと判定の記録を持って提案中で作る", () =>
    Effect.gen(function* () {
      const p = yield* fresh();
      assert.deepStrictEqual({ status: p.status, sourceItemIds: p.sourceItemIds, createdAt: p.createdAt }, { status: "提案中", sourceItemIds: ["s1"], createdAt: "2026-11-28T00:00:00.000Z" });
    }));

  it.effect("提案するのは AI だけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(propose({ id: "p1", kind: "新しい Task", title: "x", brief: "x", targetTaskId: null, sourceItemId: "s1", judgment: "j" }, user)), "AI だけ");
    }));
});

describe(specOf(Spec.addFact), () => {
  it.effect("関係する事実を足し、判定の記録を新しいものにする", () =>
    Effect.gen(function* () {
      const p = yield* addFact(yield* fresh(), ai, "s2", "routing.work-needs-new-action v1 0.78");
      assert.deepStrictEqual({ ids: p.sourceItemIds, judgment: p.judgment }, { ids: ["s1", "s2"], judgment: "routing.work-needs-new-action v1 0.78" });
    }));

  it.effect("同じ事実は二度足さない", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* addFact(yield* fresh(), ai, "s1", "j")).sourceItemIds, ["s1"]);
    }));

  it.effect(specOf(Spec.addFact, "AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(addFact(yield* fresh(), user, "s2", "j")), "AI だけ");
    }));

  it.effect(specOf(Spec.addFact, "提案中のときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(addFact(yield* decline(yield* fresh(), user), ai, "s2", "j")), "提案中のときだけ");
    }));
});

describe(specOf(Spec.autoAccept), () => {
  it.effect("確信が上がったら、AI が自動で受け入れる", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* autoAccept(yield* fresh(), ai, "閾値を超えた")).status, "受け入れた");
    }));

  it.effect(specOf(Spec.autoAccept, "AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(autoAccept(yield* fresh(), user, "閾値を超えた")), "AI だけ");
    }));

  it.effect(specOf(Spec.autoAccept, "提案中のときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(autoAccept(yield* decline(yield* fresh(), user), ai, "閾値を超えた")), "提案中のときだけ");
    }));

  it.effect(specOf(Spec.autoAccept, "切り出すかは、ユーザーが決める"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(autoAccept(yield* fresh("切り出す"), ai, "閾値を超えた")), "切り出すかは、ユーザーが決める");
    }));

  it.effect(specOf(Spec.autoAccept, "判定し直した確率が、自動の閾値を超えたときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(autoAccept(yield* fresh(), ai, "閾値に届かない")), "判定し直した確率が、自動の閾値を超えたときだけ");
    }));
});

describe(specOf(Spec.accept), () => {
  it.effect(specOf(Spec.accept, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(accept(yield* fresh(), ai)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.accept, "提案中のときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(accept(yield* accept(yield* fresh(), user), user)), "提案中のときだけ");
    }));
});

describe(specOf(Spec.decline), () => {
  it.effect(specOf(Spec.decline, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(decline(yield* fresh(), ai)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.decline, "提案中のときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(decline(yield* decline(yield* fresh(), user), user)), "提案中のときだけ");
    }));
});

describe(specOf(Spec.repropose), () => {
  it.effect("見送った提案の事実が行動を求めるように変われば、もう一度提案する", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* repropose(yield* decline(yield* fresh(), user), ai)).status, "提案中");
    }));

  it.effect(specOf(Spec.repropose, "AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(repropose(yield* decline(yield* fresh(), user), user)), "AI だけ");
    }));

  it.effect(specOf(Spec.repropose, "見送ったときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(repropose(yield* fresh(), ai)), "見送ったときだけ");
    }));
});

describe(specOf(Spec.withdraw), () => {
  it.effect(specOf(Spec.withdraw, "AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(withdraw(yield* fresh(), user)), "AI だけ");
    }));

  it.effect(specOf(Spec.withdraw, "提案中か見送ったときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(withdraw(yield* accept(yield* fresh(), user), ai)), "提案中か見送ったときだけ");
    }));
});
