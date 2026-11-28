import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import * as Spec from "../../../specs/task.spec.ts";
import { fromDrafts } from "../plan/plan.js";
import { attachFact, complete, confirmCompletion, create, finishCompletion, noteProgress, receive, revisePlan, defineCompletionByHand, detachFact, dismiss, markOf, notePriority, reopen, setDue, type Task, view } from "./task.js";

const at = (iso: string) => TestClock.setTime(DateTime.makeUnsafe(iso).epochMilliseconds);
const user = { kind: "user" } as const;
const ai = { kind: "agent" } as const;
const app = { kind: "app" } as const;

const byHand = (title = "請求書を送る") =>
  Effect.gen(function* () {
    yield* at("2026-11-28T09:00:00Z");
    return yield* create({ id: "t1", title, actor: user, origin: "手で足した" });
  });

const denied = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);

// 作る操作（initial）の条件は、live-spec 0.14.x の specOf では結べない（spec にない項目として扱われる）ので、名前だけで書く
describe("Task を作る（spec の initial）", () => {
  it.effect("手で足した Task は、できた時点でやることで、完了条件は未定、まだ一度も見ていない", () =>
    Effect.gen(function* () {
      const task = yield* byHand();
      assert.deepStrictEqual(
        { status: task.status, completion: task.completion, closure: task.closure, lastSeenAt: task.lastSeenAt, createdAt: task.createdAt },
        { status: "やること", completion: "未定", closure: null, lastSeenAt: null, createdAt: "2026-11-28T09:00:00.000Z" },
      );
      assert.deepStrictEqual(task.history, [{ kind: "できた", by: "ユーザー", occurredAt: "2026-11-28T09:00:00.000Z", changes: [], cause: "手で足した" }]);
    }));

  it.effect("事実から自動で作るのは AI、提案を受け入れる・手で足す・切り出すのはユーザー、定期の Task の回はアプリだけ", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* denied(create({ id: "t1", title: "x", actor: ai, origin: "手で足した" })),
        "事実から自動で作るのは AI、提案を受け入れる・手で足す・切り出すのはユーザー、定期の Task の回はアプリだけ",
      );
    }));

  it.effect("題が空なら作れない", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(create({ id: "t1", title: "  ", actor: user, origin: "手で足した" })), "何をするかが要る");
    }));
});

describe(specOf(Spec.complete), () => {
  it.effect("自分で完了にすると、終わった（やり終えた・自分で完了にした）になり、列とどう終わったかを出来事に残す", () =>
    Effect.gen(function* () {
      const task = yield* byHand();
      yield* at("2026-11-28T10:00:00Z");
      const done = yield* complete(task, user, "自分で完了にした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" });
      assert.deepStrictEqual({ status: done.status, closure: done.closure, updatedAt: done.updatedAt }, {
        status: "終わった",
        closure: { outcome: "done", reason: "自分で完了にした" },
        updatedAt: "2026-11-28T10:00:00.000Z",
      });
      assert.deepStrictEqual(done.history.at(-1)?.changes, [
        { field: "列", before: "やること", after: "終わった", target: null },
        { field: "どう終わったか", before: null, after: "自分で完了にした", target: null },
      ]);
    }));

  it.effect("完了したときにすることがあれば、完了待ちになる", () =>
    Effect.gen(function* () {
      const done = yield* complete(yield* byHand(), user, "自分で完了にした", { effects: "完了したときにすることがある", added: "足した項目はすべて済んだ" });
      assert.deepStrictEqual({ status: done.status, pendingReason: done.pendingReason, closure: done.closure }, { status: "完了待ち", pendingReason: "自分で完了にした", closure: null });
    }));

  it.effect(specOf(Spec.complete, "自分で完了にするのはユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(complete(yield* byHand(), ai, "自分で完了にした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" })), "自分で完了にするのはユーザーだけ");
    }));

  it.effect(specOf(Spec.complete, "やること のときだけ"), () =>
    Effect.gen(function* () {
      const none = { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" } as const;
      const done = yield* complete(yield* byHand(), user, "自分で完了にした", none);
      assert.strictEqual(yield* denied(complete(done, user, "自分で完了にした", none)), "やること のときだけ");
    }));

  it.effect(specOf(Spec.complete, "完了条件で終えるのは、完了条件をすべて満たしたときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* denied(complete(yield* byHand(), app, "完了条件を満たした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" })),
        "完了条件で終えるのは、完了条件をすべて満たしたときだけ",
      );
    }));

  it.effect(specOf(Spec.complete, "完了条件で自動で終えるのは、事実から計画に足した項目がすべて済んだときだけ（残っていれば、切り出しを提案する）"), () =>
    Effect.gen(function* () {
      const satisfied: Task = { ...(yield* byHand()), completion: "満たした" };
      assert.strictEqual(
        yield* denied(complete(satisfied, app, "完了条件を満たした", { effects: "完了したときにすることがない", added: "足した項目にまだのものがある" })),
        "完了条件で自動で終えるのは、事実から計画に足した項目がすべて済んだときだけ（残っていれば、切り出しを提案する）",
      );
    }));
});

describe(specOf(Spec.dismiss), () => {
  it.effect("自分で片付けると、終わった（やらないことにした）になる", () =>
    Effect.gen(function* () {
      const task = yield* dismiss(yield* byHand(), user, "自分で片付けた", "頼んだものはない");
      assert.deepStrictEqual({ status: task.status, closure: task.closure }, { status: "終わった", closure: { outcome: "dismissed", reason: "自分で片付けた" } });
    }));

  it.effect(specOf(Spec.dismiss, "自分で片付けるのはユーザー、絞り込みの外は同期、もう要らないと判定するのは AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* denied(dismiss(yield* byHand(), ai, "自分で片付けた", "頼んだものはない")),
        "自分で片付けるのはユーザー、絞り込みの外は同期、もう要らないと判定するのは AI だけ",
      );
    }));

  it.effect(specOf(Spec.dismiss, "やること・完了待ちのときだけ"), () =>
    Effect.gen(function* () {
      const gone = yield* dismiss(yield* byHand(), user, "自分で片付けた", "頼んだものはない");
      assert.strictEqual(yield* denied(dismiss(gone, user, "自分で片付けた", "頼んだものはない")), "やること・完了待ちのときだけ");
    }));

  it.effect(specOf(Spec.dismiss, "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）"), () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* denied(dismiss(yield* byHand(), user, "自分で片付けた", "頼んだものがある")),
        "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）",
      );
    }));
});

describe(specOf(Spec.reopen), () => {
  const finished = Effect.gen(function* () {
    return yield* complete(yield* byHand(), user, "自分で完了にした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" });
  });

  it.effect("終わった Task をやることに戻し、完了条件を未定に戻す", () =>
    Effect.gen(function* () {
      const task = yield* reopen(yield* finished, user, "頼んだものはない");
      assert.deepStrictEqual({ status: task.status, closure: task.closure, completion: task.completion }, { status: "やること", closure: null, completion: "未定" });
    }));

  it.effect(specOf(Spec.reopen, "ユーザーか AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(reopen(yield* finished, app, "頼んだものはない")), "ユーザーか AI だけ");
    }));

  it.effect(specOf(Spec.reopen, "終わった・完了待ちのときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(reopen(yield* byHand(), user, "頼んだものはない")), "終わった・完了待ちのときだけ");
    }));

  it.effect(specOf(Spec.reopen, "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(reopen(yield* finished, user, "頼んだものがある")), "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）");
    }));

  it.effect(specOf(Spec.reopen, "自分で片付けた Task は、AI では戻らない"), () =>
    Effect.gen(function* () {
      const gone = yield* dismiss(yield* byHand(), user, "自分で片付けた", "頼んだものはない");
      assert.strictEqual(yield* denied(reopen(gone, ai, "頼んだものはない")), "自分で片付けた Task は、AI では戻らない");
    }));
});

describe(specOf(Spec.setDue), () => {
  const due = { text: "12 月 15 日まで", earliest: "2026-12-15T00:00:00.000Z", latest: "2026-12-15T23:59:59.000Z", precision: "日" } as const;

  it.effect("期日を直し、前と後を元の書き方で出来事に残す", () =>
    Effect.gen(function* () {
      const task = yield* setDue(yield* byHand(), user, due);
      assert.deepStrictEqual(task.due, due);
      assert.deepStrictEqual(task.history.at(-1)?.changes, [{ field: "期日", before: null, after: "12 月 15 日まで", target: null }]);
    }));

  it.effect(specOf(Spec.setDue, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(setDue(yield* byHand(), app, due)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.setDue, "やること のときだけ"), () =>
    Effect.gen(function* () {
      const gone = yield* dismiss(yield* byHand(), user, "自分で片付けた", "頼んだものはない");
      assert.strictEqual(yield* denied(setDue(gone, user, due)), "やること のときだけ");
    }));

  it.effect("同じ期日に直しても、出来事は残さない（前と後が同じ変化は残さない）", () =>
    Effect.gen(function* () {
      const once = yield* setDue(yield* byHand(), user, due);
      const twice = yield* setDue(once, user, due);
      assert.strictEqual(twice.history.length, once.history.length);
    }));
});

describe(specOf(Spec.defineCompletionByHand), () => {
  it.effect("手で足した Task に、やり終えたと自分で確かめる完了条件を置く（完了条件はまだ）", () =>
    Effect.gen(function* () {
      const task = yield* defineCompletionByHand(yield* byHand(), user);
      assert.strictEqual(task.completion, "まだ");
      assert.deepStrictEqual(task.history.at(-1)?.changes, [{ field: "完了条件", before: "未定", after: "まだ", target: null }]);
    }));

  it.effect(specOf(Spec.defineCompletionByHand, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(defineCompletionByHand(yield* byHand(), ai)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.defineCompletionByHand, "やること のときだけ"), () =>
    Effect.gen(function* () {
      const gone = yield* dismiss(yield* byHand(), user, "自分で片付けた", "頼んだものはない");
      assert.strictEqual(yield* denied(defineCompletionByHand(gone, user)), "やること のときだけ");
    }));

  it.effect(specOf(Spec.defineCompletionByHand, "完了条件が決まっていないときだけ"), () =>
    Effect.gen(function* () {
      const once = yield* defineCompletionByHand(yield* byHand(), user);
      assert.strictEqual(yield* denied(defineCompletionByHand(once, user)), "完了条件が決まっていないときだけ");
    }));
});

describe(specOf(Spec.view), () => {
  it.effect("見たら、最後に見た時刻を今に進め、最後に変えた日時は変えない", () =>
    Effect.gen(function* () {
      const task = yield* byHand();
      yield* at("2026-11-28T12:00:00Z");
      const seen = yield* view(task, user);
      assert.deepStrictEqual({ lastSeenAt: seen.lastSeenAt, updatedAt: seen.updatedAt }, { lastSeenAt: "2026-11-28T12:00:00.000Z", updatedAt: task.updatedAt });
    }));

  it.effect(specOf(Spec.view, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(view(yield* byHand(), app)), "ユーザーだけ");
    }));
});

describe("更新マークと新着（spec の判断表）", () => {
  it.effect("まだ一度も見ていない Task は新着", () =>
    Effect.gen(function* () {
      assert.strictEqual(markOf(yield* byHand()), "新着");
    }));

  it.effect("見たあとにユーザーしか変えていなければ、印はない", () =>
    Effect.gen(function* () {
      const seen = yield* view(yield* byHand(), user);
      yield* at("2026-11-28T13:00:00Z");
      const changed = yield* setDue(seen, user, { text: "金曜まで", earliest: "2026-12-04T00:00:00.000Z", latest: "2026-12-04T23:59:59.000Z", precision: "日" });
      assert.strictEqual(markOf(changed), "なし");
    }));

  it.effect("見たあとにユーザー以外が変えた項目があれば、更新マーク", () =>
    Effect.gen(function* () {
      const seen = yield* view(yield* byHand(), user);
      yield* at("2026-11-28T13:00:00Z");
      const reopened = yield* reopen(yield* complete(seen, user, "自分で完了にした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" }), ai, "頼んだものはない");
      assert.strictEqual(markOf(reopened), "更新マーク");
    }));

  it.effect("同じ項目を、ユーザー以外が変えたあとにユーザーが変え直したら、印はない（項目ごとの最後の変化で決める）", () =>
    Effect.gen(function* () {
      const seen = yield* view(yield* byHand(), user);
      yield* at("2026-11-28T13:00:00Z");
      const done = yield* complete(seen, user, "自分で完了にした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" });
      const byAi = yield* reopen(done, ai, "頼んだものはない");
      const byUser = yield* complete(byAi, user, "自分で完了にした", { effects: "完了したときにすることがない", added: "足した項目はすべて済んだ" });
      assert.strictEqual(markOf(byUser), "なし");
    }));
});

describe(specOf(Spec.notePriority), () => {
  it.effect("優先度の段階が変わったことを、前と後のラベルで出来事に残す", () =>
    Effect.gen(function* () {
      const task = yield* notePriority(yield* byHand(), app, "10 日以内", "今日中");
      assert.deepStrictEqual(task.history.at(-1), { kind: "変わった", by: "アプリ", occurredAt: "2026-11-28T09:00:00.000Z", changes: [{ field: "優先度", before: "10 日以内", after: "今日中", target: null }], cause: null });
    }));

  it.effect("同じラベルに決め直したときは、出来事を残さない", () =>
    Effect.gen(function* () {
      const task = yield* byHand();
      assert.strictEqual((yield* notePriority(task, app, "今日中", "今日中")).history.length, task.history.length);
    }));

  it.effect(specOf(Spec.notePriority, "やること のときだけ（終わった Task の優先度は判定しない）"), () =>
    Effect.gen(function* () {
      const gone = yield* dismiss(yield* byHand(), user, "自分で片付けた", "頼んだものはない");
      assert.strictEqual(yield* denied(notePriority(gone, app, null, "今日中")), "やること のときだけ（終わった Task の優先度は判定しない）");
    }));
});

describe(specOf(Spec.attachFact), () => {
  it.effect("事実を持たせ、同じ事実は二度持たない", () =>
    Effect.gen(function* () {
      const once = yield* attachFact(yield* byHand(), ai, "s1");
      assert.deepStrictEqual((yield* attachFact(once, ai, "s1")).sourceItemIds, ["s1"]);
    }));

  it.effect(specOf(Spec.attachFact, "終わっていないときだけ"), () =>
    Effect.gen(function* () {
      const gone = yield* dismiss(yield* byHand(), user, "自分で片付けた", "頼んだものはない");
      assert.strictEqual(yield* denied(attachFact(gone, ai, "s1")), "終わっていないときだけ");
    }));
});

describe(specOf(Spec.detachFact), () => {
  it.effect("事実を外す", () =>
    Effect.gen(function* () {
      const task = yield* detachFact(yield* attachFact(yield* byHand(), ai, "s1"), user, "s1");
      assert.deepStrictEqual(task.sourceItemIds, []);
    }));

  it.effect(specOf(Spec.detachFact, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(detachFact(yield* attachFact(yield* byHand(), ai, "s1"), ai, "s1")), "ユーザーだけ");
    }));
});

const twoStepPlan = () =>
  fromDrafts(
    { type: "serial", items: [{ title: "読む", effort: "easy", due: null, completes: false, how: { type: "human" } }, { title: "返事する", effort: "easy", due: null, completes: true, how: { type: "human" } }] },
    (() => {
      let i = 0;
      return () => `a${++i}`;
    })(),
  ).plan;

describe(specOf(Spec.revisePlan), () => {
  it.effect("計画を立てると、完了条件は計画から導いて「まだ」になり、計画が変わったことを出来事に残す", () =>
    Effect.gen(function* () {
      const task = yield* revisePlan(yield* byHand(), ai, twoStepPlan());
      assert.strictEqual(task.completion, "まだ");
      assert.deepStrictEqual(task.history.at(-1)?.changes.map((c) => c.field), ["計画", "完了条件"]);
    }));

  it.effect("立て直すと、前の計画は残しておく（今の完了条件には数えない）", () =>
    Effect.gen(function* () {
      const once = yield* revisePlan(yield* byHand(), ai, twoStepPlan());
      const twice = yield* revisePlan(once, ai, twoStepPlan());
      assert.strictEqual(twice.previousPlans.length, 1);
    }));

  it.effect(specOf(Spec.revisePlan, "AI だけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(revisePlan(yield* byHand(), user, twoStepPlan())), "AI だけ");
    }));

  it.effect(specOf(Spec.revisePlan, "やること のときだけ"), () =>
    Effect.gen(function* () {
      const gone = yield* dismiss(yield* byHand(), user, "自分で片付けた", "頼んだものはない");
      assert.strictEqual(yield* denied(revisePlan(gone, ai, twoStepPlan())), "やること のときだけ");
    }));
});

describe(specOf(Spec.noteProgress), () => {
  it.effect("Action Item が進んだことを、どれが進んだかと一緒に残し、完了条件を導き直す", () =>
    Effect.gen(function* () {
      const planned = yield* revisePlan(yield* byHand(), ai, twoStepPlan());
      const plan = planned.plan!;
      const done = { ...plan, nodes: plan.nodes.map((node) => (node.type === "item" ? { ...node, item: { ...node.item, status: "済んだ" as const } } : node)) };
      const task = yield* noteProgress(planned, user, done, "a2");
      assert.strictEqual(task.completion, "満たした");
      assert.deepStrictEqual(task.history.at(-1)?.changes[0], { field: "Action Item の進み", before: null, after: null, target: "a2" });
    }));
});

describe(specOf(Spec.receive), () => {
  it.effect("届いたものを Task の言葉に置き換え、どの入力から来たかと一緒に残す", () =>
    Effect.gen(function* () {
      const task = yield* receive(yield* byHand(), ai, "事実", { brief: "PR が merge された。確かめて閉じる" }, "activity:s1:3");
      assert.deepStrictEqual(task.history.at(-1), {
        kind: "変わった",
        by: "AI",
        occurredAt: "2026-11-28T09:00:00.000Z",
        changes: [{ field: "今の状況と次の一手", before: null, after: "PR が merge された。確かめて閉じる", target: null }],
        cause: "activity:s1:3",
      });
    }));

  it.effect("同じ入力が 2 度届いても、反映は 1 回にする", () =>
    Effect.gen(function* () {
      const once = yield* receive(yield* byHand(), ai, "事実", { brief: "a" }, "activity:s1:3");
      const twice = yield* receive(once, ai, "事実", { brief: "b" }, "activity:s1:3");
      assert.strictEqual(twice.brief, "a");
    }));

  it.effect(specOf(Spec.receive, "事実と AI の作業の成果は AI、書き込めなかったはアプリだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(receive(yield* byHand(), app, "事実", { brief: "a" }, "c")), "事実と AI の作業の成果は AI、書き込めなかったはアプリだけ");
      assert.strictEqual(yield* denied(receive(yield* byHand(), ai, "書き込めなかった", { brief: "a" }, "c")), "事実と AI の作業の成果は AI、書き込めなかったはアプリだけ");
    }));
});

const waiting = Effect.gen(function* () {
  return yield* complete(yield* byHand(), user, "自分で完了にした", { effects: "完了したときにすることがある", added: "足した項目はすべて済んだ" });
});

describe(specOf(Spec.confirmCompletion), () => {
  it.effect(specOf(Spec.confirmCompletion, "ユーザーだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* denied(confirmCompletion(yield* waiting, ai, "見せたとおり")), "ユーザーだけ"); }));
  it.effect(specOf(Spec.confirmCompletion, "完了待ちのときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* denied(confirmCompletion(yield* byHand(), user, "見せたとおり")), "完了待ちのときだけ"); }));
  it.effect(specOf(Spec.confirmCompletion, "見せたチェックリストが今も同じときだけ（見せたあとに足された・取りやめたものがあれば、見せ直す）"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(confirmCompletion(yield* waiting, user, "変わった")), "見せたチェックリストが今も同じときだけ（見せたあとに足された・取りやめたものがあれば、見せ直す）");
    }));
});

describe(specOf(Spec.finishCompletion), () => {
  it.effect("完了待ちに入ったときの理由のまま終える", () =>
    Effect.gen(function* () {
      const done = yield* finishCompletion(yield* waiting, app, "すべて済んだ");
      assert.deepStrictEqual({ status: done.status, closure: done.closure, pendingReason: done.pendingReason }, { status: "終わった", closure: { outcome: "done", reason: "自分で完了にした" }, pendingReason: null });
    }));
  it.effect(specOf(Spec.finishCompletion, "アプリだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* denied(finishCompletion(yield* waiting, user, "すべて済んだ")), "アプリだけ"); }));
  it.effect(specOf(Spec.finishCompletion, "完了待ちのときだけ"), () => Effect.gen(function* () { assert.strictEqual(yield* denied(finishCompletion(yield* byHand(), app, "すべて済んだ")), "完了待ちのときだけ"); }));
  it.effect(specOf(Spec.finishCompletion, "完了したときにすることが、すべて書き込めた・外されたときだけ"), () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* denied(finishCompletion(yield* waiting, app, "まだ・書き込めなかったものがある")), "完了したときにすることが、すべて書き込めた・外されたときだけ");
    }));
});
