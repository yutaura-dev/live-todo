import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/agent-run.spec.ts";
import { type AgentRun, cancel, decide, fail, interrupt, requestRun, start, stop, succeed, withdraw } from "./agent-run.js";

const user = { kind: "user" } as const;
const agent = { kind: "agent" } as const;
const app = { kind: "app" } as const;
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);
const base = { id: "ar1", taskId: "t1", request: "PR #42 を直す", actionItemId: null, subjectFingerprint: "abc1234" };
const question = { ...base, request: "なぜ CI が落ちている？", subjectFingerprint: null };
const ready = { thread: "続けられる", task: "開いている", others: "ほかに動いている作業はない" } as const;
const queued = requestRun(user, "PR を直す", "開いている", base);
const running = Effect.flatMap(queued, (run) => start(run, app, ready));
const deciding = Effect.flatMap(running, (run) => interrupt(run, app));

describe("作業を頼む・Action Item から始める（spec の initial）", () => {
  it.effect("ユーザーが質問を頼むと、読むだけの道具で待ち行列に入る", () =>
    Effect.gen(function* () {
      const run = yield* requestRun(user, "質問に答える", "開いている", question);
      assert.deepStrictEqual({ status: run.status, tools: run.tools, trigger: run.trigger }, { status: "待ち行列", tools: "読むだけ", trigger: "ユーザーが頼んだ" });
    }));

  it.effect("PR を直す・コンフリクトを直す・直す Action Item には、直す道具を渡す", () =>
    Effect.gen(function* () {
      const fix = yield* requestRun(user, "PR を直す", "開いている", base);
      const conflict = yield* requestRun(user, "コンフリクトを直す", "開いている", base);
      const item = yield* requestRun(app, "Action Item をやる（直す）", "開いている", { ...base, actionItemId: "a2" });
      assert.deepStrictEqual([fix.tools, conflict.tools, item.tools, item.trigger], ["直す", "直す", "直す", "Action Item から"]);
    }));

  // 作る操作（initial）の条件は specOf で結べないので、名前だけで書く
  it.effect("頼めるのは、ユーザーか、Action Item から始めるアプリだけ（AI は自分で作業を始めない）", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(requestRun(agent, "質問に答える", "開いている", question)), "ユーザーか、Action Item から始めるアプリだけ");
    }));

  it.effect("アプリが始めるのは、Action Item をやる作業だけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(requestRun(app, "PR を直す", "開いている", base)), "アプリが始めるのは、Action Item をやる作業だけ");
    }));

  it.effect("完了待ち・終わった Task には、作業を頼まない", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(requestRun(user, "質問に答える", "開いていない", question)), "Task がやること のときだけ（完了待ち・終わった Task には頼まない）");
    }));
});

describe(specOf(Spec.start), () => {
  it.effect("順番が来たら、やっているにする", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* running).status, "やっている");
    }));

  it.effect(specOf(Spec.start, "アプリだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(start(yield* queued, user, ready)), "アプリだけ");
    }));

  it.effect(specOf(Spec.start, "待ち行列のときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(start(yield* running, app, ready)), "待ち行列のときだけ");
    }));

  it.effect(specOf(Spec.start, "この Task で、ほかに動いている作業がないときだけ（同時に動くのは 1 つまで）"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(start(yield* queued, app, { ...ready, others: "ほかに動いている作業がある" })), "この Task で、ほかに動いている作業がないときだけ（同時に動くのは 1 つまで）");
    }));

  it.effect(specOf(Spec.start, "会話を続けられるときだけ（続けられないなら、先に新しい会話を始める）"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(start(yield* queued, app, { ...ready, thread: "続けられない" })), "会話を続けられるときだけ（続けられないなら、先に新しい会話を始める）");
    }));

  it.effect(specOf(Spec.start, "Task がやること のときだけ（完了待ち・終わった Task では始めない）"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(start(yield* queued, app, { ...ready, task: "開いていない" })), "Task がやること のときだけ（完了待ち・終わった Task では始めない）");
    }));
});

describe(specOf(Spec.succeed), () => {
  it.effect("やり遂げたら、結果を残す", () =>
    Effect.gen(function* () {
      const run = yield* succeed(yield* running, agent, "差分と確認のコマンドの結果");
      assert.deepStrictEqual({ status: run.status, result: run.result }, { status: "終わった", result: "差分と確認のコマンドの結果" });
    }));

  it.effect(specOf(Spec.succeed, "AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(succeed(yield* running, app, "結果")), "AI だけ");
    }));

  it.effect(specOf(Spec.succeed, "やっているときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(succeed(yield* queued, agent, "結果")), "やっているときだけ");
    }));
});

describe(specOf(Spec.fail), () => {
  it.effect("うまくいかなかったら、理由を残して止まったにする", () =>
    Effect.gen(function* () {
      const run = yield* fail(yield* running, agent, "うまくいかなかった");
      assert.deepStrictEqual({ status: run.status, stopReason: run.stopReason, result: run.result }, { status: "止まった", stopReason: "うまくいかなかった", result: null });
    }));

  it.effect("判断中にアプリを閉じても、止まったにする", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* fail(yield* deciding, app, "アプリを閉じた")).status, "止まった");
    }));

  it.effect(specOf(Spec.fail, "AI かアプリだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(fail(yield* running, user, "うまくいかなかった")), "AI かアプリだけ");
    }));

  it.effect(specOf(Spec.fail, "やっている・判断中のときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(fail(yield* queued, agent, "うまくいかなかった")), "やっている・判断中のときだけ");
    }));
});

describe(specOf(Spec.stop), () => {
  it.effect("ユーザーが止めたら、止まったにする", () =>
    Effect.gen(function* () {
      const run = yield* stop(yield* running, user);
      assert.deepStrictEqual({ status: run.status, stopReason: run.stopReason }, { status: "止まった", stopReason: "ユーザーが止めた" });
    }));

  it.effect(specOf(Spec.stop, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(stop(yield* running, agent)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.stop, "やっている・判断中のときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(stop(yield* queued, user)), "やっている・判断中のときだけ");
    }));
});

describe(specOf(Spec.interrupt), () => {
  it.effect("追う項目が片付いたら、判断中にし、知らせたことを残す", () =>
    Effect.gen(function* () {
      const run = yield* deciding;
      assert.deepStrictEqual({ status: run.status, notified: run.notified }, { status: "判断中", notified: true });
    }));

  it.effect(specOf(Spec.interrupt, "アプリだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(interrupt(yield* running, agent)), "アプリだけ");
    }));

  it.effect(specOf(Spec.interrupt, "やっているときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(interrupt(yield* queued, app)), "やっているときだけ");
    }));

  it.effect(specOf(Spec.interrupt, "まだ知らせていないときだけ（続けると判断したら、もう知らせない）"), () =>
    Effect.gen(function* () {
      const resumed = yield* decide(yield* deciding, agent, "続ける");
      assert.strictEqual(yield* reasonOf(interrupt(resumed, app)), "まだ知らせていないときだけ（続けると判断したら、もう知らせない）");
    }));

  it.effect(specOf(Spec.interrupt, "追う元の項目がある作業だけ"), () =>
    Effect.gen(function* () {
      const asked = yield* requestRun(user, "質問に答える", "開いている", question);
      const run = yield* start(asked, app, ready);
      assert.strictEqual(yield* reasonOf(interrupt(run, app)), "追う元の項目がある作業だけ");
    }));
});

describe(specOf(Spec.decide), () => {
  it.effect("続けると答えたら、やっているに戻す。やめる・答えが返らないなら止まったにする", () =>
    Effect.gen(function* () {
      const go = yield* decide(yield* deciding, agent, "続ける");
      const quit = yield* decide(yield* deciding, agent, "やめる");
      const silent = yield* decide(yield* deciding, agent, "答えが返らない");
      assert.deepStrictEqual(
        [go.status, quit.status, quit.stopReason, silent.status, silent.stopReason],
        ["やっている", "止まった", "追う項目が片付いたのでやめた", "止まった", "決まった形の答えが返らない"],
      );
    }));

  it.effect(specOf(Spec.decide, "AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(decide(yield* deciding, app, "やめる")), "AI だけ");
    }));

  it.effect(specOf(Spec.decide, "判断中のときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(decide(yield* running, agent, "やめる")), "判断中のときだけ");
    }));
});

describe(specOf(Spec.withdraw), () => {
  it.effect("待ち行列なら取り消し、やっていたなら止まったにする", () =>
    Effect.gen(function* () {
      const fromQueue = yield* withdraw(yield* queued, app, "やらなくなった");
      const fromRunning = yield* withdraw(yield* running, app, "ユーザーが済ませた");
      assert.deepStrictEqual([fromQueue.status, fromRunning.status, fromRunning.stopReason], ["取り消した", "止まった", "ユーザーが済ませた"]);
    }));

  it.effect(specOf(Spec.withdraw, "アプリだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(withdraw(yield* running, user, "やらなくなった")), "アプリだけ");
    }));

  it.effect(specOf(Spec.withdraw, "終わっていないときだけ"), () =>
    Effect.gen(function* () {
      const stopped = yield* withdraw(yield* running, app, "やらなくなった");
      assert.strictEqual(yield* reasonOf(withdraw(stopped, app, "やらなくなった")), "終わっていないときだけ");
    }));
});

describe(specOf(Spec.cancel), () => {
  it.effect("待ち行列のうちに取り消す", () =>
    Effect.gen(function* () {
      const run = yield* cancel(yield* queued, user, "ユーザーが取り消した");
      assert.deepStrictEqual({ status: run.status, stopReason: run.stopReason }, { status: "取り消した", stopReason: "ユーザーが取り消した" });
    }));

  it.effect(specOf(Spec.cancel, "アプリかユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(cancel(yield* queued, agent, "追う項目が片付いたので取り消した")), "アプリかユーザーだけ");
    }));

  it.effect(specOf(Spec.cancel, "待ち行列のときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reasonOf(cancel(yield* running, user, "ユーザーが取り消した")), "待ち行列のときだけ");
    }));
});

it.effect("終わった作業は、もう変わらない（止まった作業はやり遂げられない）", () =>
  Effect.gen(function* () {
    const stopped: AgentRun = yield* stop(yield* running, user);
    assert.strictEqual(yield* reasonOf(succeed(stopped, agent, "結果")), "やっているときだけ");
  }));
