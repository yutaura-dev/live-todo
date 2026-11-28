import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import { Effect } from "effect";
import * as Spec from "../../../specs/action-item.spec.ts";
import { type Definition, agentRunOf, appendItem, autoStartAgent, requestAgent, succeedByAgent, chooseOption, completeByWrite, completeItem, completionOf, fromDrafts, type PlanGroup, reopenItem, skipItem, turnOf } from "./plan.js";

const user = { kind: "user" } as const;
const ai = { kind: "agent" } as const;
const human = (title: string, completes = false): Definition => ({ title, effort: "easy", due: null, completes, how: { type: "human" } });
const reasonOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) => Effect.map(Effect.flip(effect), (error) => error.reason);

let n = 0;
const nextId = () => `a${++n}`;
const serial = (): PlanGroup => fromDrafts({ type: "serial", items: [human("PR を読む"), human("コメントを返す", true)] }, nextId).plan;
const ids = (plan: PlanGroup) => plan.nodes.flatMap((node) => (node.type === "item" ? [node.item.id] : []));
const decisionPlan = (): PlanGroup =>
  fromDrafts(
    {
      type: "serial",
      items: [
        {
          title: "merge するか決める",
          effort: "easy",
          due: null,
          completes: false,
          how: {
            type: "decision",
            kind: "選ぶ",
            question: "型エラーがあるが merge するか",
            howToCheck: null,
            options: [
              { label: "merge する", then: { type: "planned", plan: { type: "serial", items: [human("merge する", true)] } } },
              { label: "調べる", then: { type: "planLater", direction: "原因を調べる" } },
            ],
          },
        },
      ],
    },
    nextId,
  ).plan;

describe("計画の番", () => {
  it("前から順の並びは、まだのものの先頭にだけ番が来る", () => {
    const plan = serial();
    const [first, second] = ids(plan);
    assert.deepStrictEqual([turnOf(plan, first!), turnOf(plan, second!)], ["番が来ている", "番待ち"]);
  });

  it("同時の並びは、すべてに番が来る", () => {
    const plan = fromDrafts({ type: "parallel", items: [human("A"), human("B")] }, nextId).plan;
    assert.deepStrictEqual(ids(plan).map((id) => turnOf(plan, id)), ["番が来ている", "番が来ている"]);
  });
});

describe(specOf(Spec.complete), () => {
  it.effect("番が来ている Action Item を済ませると、次に番が来る", () =>
    Effect.gen(function* () {
      const plan = serial();
      const [first, second] = ids(plan);
      const next = yield* completeItem(plan, first!, user);
      assert.deepStrictEqual([turnOf(next, first!), turnOf(next, second!)], ["済んだ", "番が来ている"]);
    }));

  it.effect(specOf(Spec.complete, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(completeItem(plan, ids(plan)[0]!, ai)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.complete, "まだのときだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      const once = yield* completeItem(plan, ids(plan)[0]!, user);
      assert.strictEqual(yield* reasonOf(completeItem(once, ids(plan)[0]!, user)), "まだのときだけ");
    }));

  it.effect(specOf(Spec.complete, "番が来ているときだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(completeItem(plan, ids(plan)[1]!, user)), "番が来ているときだけ");
    }));

  it.effect(specOf(Spec.complete, "人か Claude Code が果たす Action Item だけ"), () =>
    Effect.gen(function* () {
      const plan = decisionPlan();
      assert.strictEqual(yield* reasonOf(completeItem(plan, ids(plan)[0]!, user)), "人か Claude Code が果たす Action Item だけ");
    }));
});

describe(specOf(Spec.reopen), () => {
  it.effect("済ませた Action Item を、まだに戻す", () =>
    Effect.gen(function* () {
      const plan = serial();
      const id = ids(plan)[0]!;
      const back = yield* reopenItem(yield* completeItem(plan, id, user), id, user);
      assert.strictEqual(turnOf(back, id), "番が来ている");
    }));

  it.effect(specOf(Spec.reopen, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      const id = ids(plan)[0]!;
      assert.strictEqual(yield* reasonOf(reopenItem(yield* completeItem(plan, id, user), id, ai)), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.reopen, "済んだときだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(reopenItem(plan, ids(plan)[0]!, user)), "済んだときだけ");
    }));
});

describe(specOf(Spec.choose), () => {
  it.effect("先の計画が決まっている選択肢を選ぶと、その枝を差し込み、枝の中に番が来る", () =>
    Effect.gen(function* () {
      const plan = decisionPlan();
      const decisionId = ids(plan)[0]!;
      const chosen = yield* chooseOption(plan, decisionId, 0, user, nextId);
      const branch = chosen.nodes[1];
      assert.strictEqual(branch?.type, "branch");
      const inner = branch?.type === "branch" && branch.plan !== null ? ids(branch.plan)[0]! : "";
      assert.deepStrictEqual([turnOf(chosen, decisionId), turnOf(chosen, inner)], ["済んだ", "番が来ている"]);
    }));

  it.effect(specOf(Spec.choose, "分かれ道だけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(chooseOption(plan, ids(plan)[0]!, 0, user, nextId)), "分かれ道だけ");
    }));

  it.effect(specOf(Spec.choose, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      const plan = decisionPlan();
      assert.strictEqual(yield* reasonOf(chooseOption(plan, ids(plan)[0]!, 0, ai, nextId)), "ユーザーだけ");
    }));
});

describe(specOf(Spec.skip), () => {
  it.effect("やらなくした Action Item は、番を次に渡す", () =>
    Effect.gen(function* () {
      const plan = serial();
      const [first, second] = ids(plan);
      const next = yield* skipItem(plan, first!, user);
      assert.deepStrictEqual([turnOf(next, first!), turnOf(next, second!)], ["やらない", "番が来ている"]);
    }));

  it.effect(specOf(Spec.skip, "まだのときだけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      const id = ids(plan)[0]!;
      assert.strictEqual(yield* reasonOf(skipItem(yield* skipItem(plan, id, user), id, user)), "まだのときだけ");
    }));
});

describe("完了条件の状態（計画から導く）", () => {
  it("計画がなければ未定", () => {
    assert.strictEqual(completionOf(null), "未定");
  });

  it.effect("完了条件の Action Item がすべて済めば、満たした", () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(completionOf(plan), "まだ");
      const done = yield* completeItem(yield* completeItem(plan, ids(plan)[0]!, user), ids(plan)[1]!, user);
      assert.strictEqual(completionOf(done), "満たした");
    }));

  it("まだ選んでいない分かれ道に、選んでから考える選択肢があれば未定", () => {
    assert.strictEqual(completionOf(decisionPlan()), "未定");
  });

  it.effect("選んでから考える選択肢を選んだら、先の計画ができるまで未定", () =>
    Effect.gen(function* () {
      const plan = decisionPlan();
      assert.strictEqual(completionOf(yield* chooseOption(plan, ids(plan)[0]!, 1, user, nextId)), "未定");
    }));

  it("完了条件の Action Item が 1 つもなければ未定（計画の書き損じ）", () => {
    assert.strictEqual(completionOf(fromDrafts({ type: "serial", items: [human("読む")] }, nextId).plan), "未定");
  });
});

describe("事実から計画に足す", () => {
  it("足した Action Item は、もとの事実を持ち、計画の最後に並ぶ", () => {
    const plan = appendItem(serial(), { id: "added", status: "まだ", definition: human("レビューに返事する"), addedFrom: "s1" });
    const last = plan.nodes.at(-1);
    assert.deepStrictEqual(last?.type === "item" ? [last.item.id, last.item.addedFrom] : null, ["added", "s1"]);
  });
});

describe(specOf(Spec.completeByWrite), () => {
  const writePlan = () =>
    fromDrafts(
      { type: "serial", items: [{ title: "merge する", effort: "easy", due: null, completes: true, how: { type: "write", subjectUri: "github://me@github.com/acme/app/pull/42", operation: "github.merge", paramsJson: "{}", trigger: "on_request" } }, human("告知する")] },
      nextId,
    ).plan;

  it.effect("書き込みが成功したら、その Action Item を果たす", () =>
    Effect.gen(function* () {
      const plan = writePlan();
      assert.strictEqual(turnOf(yield* completeByWrite(plan, ids(plan)[0]!, { kind: "app" }), ids(plan)[0]!), "済んだ");
    }));

  it.effect(specOf(Spec.completeByWrite, "アプリだけ"), () =>
    Effect.gen(function* () {
      const plan = writePlan();
      assert.strictEqual(yield* reasonOf(completeByWrite(plan, ids(plan)[0]!, user)), "アプリだけ");
    }));

  it.effect(specOf(Spec.completeByWrite, "まだのときだけ"), () =>
    Effect.gen(function* () {
      const plan = writePlan();
      const done = yield* completeByWrite(plan, ids(plan)[0]!, { kind: "app" });
      assert.strictEqual(yield* reasonOf(completeByWrite(done, ids(plan)[0]!, { kind: "app" })), "まだのときだけ");
    }));

  it.effect(specOf(Spec.completeByWrite, "番が来ているときだけ"), () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [human("先にやる"), { title: "merge する", effort: "easy", due: null, completes: true, how: { type: "write", subjectUri: "x", operation: "github.merge", paramsJson: "{}", trigger: "on_request" } }] }, nextId).plan;
      assert.strictEqual(yield* reasonOf(completeByWrite(plan, ids(plan)[1]!, { kind: "app" })), "番が来ているときだけ");
    }));

  it.effect(specOf(Spec.completeByWrite, "書き込みで果たされる Action Item だけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(completeByWrite(plan, ids(plan)[0]!, { kind: "app" })), "書き込みで果たされる Action Item だけ");
    }));
});

const claude = (title: string, trigger: "auto" | "on_request" = "on_request", completes = false): Definition => ({ title, effort: "easy", due: null, completes, how: { type: "claude", tools: "読むだけ", trigger } });
const app = { kind: "app" } as const;
const open = { running: "終わっていない作業はない", task: "開いている" } as const;

describe(specOf(Spec.request), () => {
  it.effect("Claude Code に頼むと、作業の ID を持つ", () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [claude("変更点を読む")] }, nextId).plan;
      const id = ids(plan)[0]!;
      assert.strictEqual(agentRunOf(yield* requestAgent(plan, id, user, open, "ar1"), id), "ar1");
    }));

  it.effect("番が来る前でも頼める", () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [human("先にやる"), claude("変更点を読む")] }, nextId).plan;
      const id = ids(plan)[1]!;
      assert.strictEqual(agentRunOf(yield* requestAgent(plan, id, user, open, "ar1"), id), "ar1");
    }));

  it.effect(specOf(Spec.request, "ユーザーだけ"), () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [claude("変更点を読む")] }, nextId).plan;
      assert.strictEqual(yield* reasonOf(requestAgent(plan, ids(plan)[0]!, app, open, "ar1")), "ユーザーだけ");
    }));

  it.effect(specOf(Spec.request, "まだのときだけ"), () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [claude("変更点を読む")] }, nextId).plan;
      const done = yield* completeItem(plan, ids(plan)[0]!, user);
      assert.strictEqual(yield* reasonOf(requestAgent(done, ids(plan)[0]!, user, open, "ar1")), "まだのときだけ");
    }));

  it.effect(specOf(Spec.request, "Claude Code が果たす Action Item だけ"), () =>
    Effect.gen(function* () {
      const plan = serial();
      assert.strictEqual(yield* reasonOf(requestAgent(plan, ids(plan)[0]!, user, open, "ar1")), "Claude Code が果たす Action Item だけ");
    }));

  it.effect(specOf(Spec.request, "この Action Item の作業が終わっているときだけ（待ち行列も含む）"), () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [claude("変更点を読む")] }, nextId).plan;
      assert.strictEqual(
        yield* reasonOf(requestAgent(plan, ids(plan)[0]!, user, { ...open, running: "終わっていない作業がある" }, "ar1")),
        "この Action Item の作業が終わっているときだけ（待ち行列も含む）",
      );
    }));

  it.effect(specOf(Spec.request, "Task がやること のときだけ（完了待ちの Task では頼まない）"), () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [claude("変更点を読む")] }, nextId).plan;
      assert.strictEqual(yield* reasonOf(requestAgent(plan, ids(plan)[0]!, user, { ...open, task: "開いていない" }, "ar1")), "Task がやること のときだけ（完了待ちの Task では頼まない）");
    }));
});

describe(specOf(Spec.autoStart), () => {
  const autoPlan = () => fromDrafts({ type: "serial", items: [claude("変更点を読む", "auto")] }, nextId).plan;
  const ok = { policy: "範囲に入る", task: "やること" } as const;

  it.effect("番が来た自動でやる Action Item は、一度だけ頼む", () =>
    Effect.gen(function* () {
      const plan = autoPlan();
      const id = ids(plan)[0]!;
      const started = yield* autoStartAgent(plan, id, app, ok, "ar1");
      assert.strictEqual(agentRunOf(started, id), "ar1");
      assert.strictEqual(yield* reasonOf(autoStartAgent(started, id, app, ok, "ar2")), "一度も頼んでいないときだけ");
    }));

  it.effect(specOf(Spec.autoStart, "アプリだけ"), () =>
    Effect.gen(function* () {
      const plan = autoPlan();
      assert.strictEqual(yield* reasonOf(autoStartAgent(plan, ids(plan)[0]!, user, ok, "ar1")), "アプリだけ");
    }));

  it.effect(specOf(Spec.autoStart, "番が来ているときだけ"), () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [human("先にやる"), claude("変更点を読む", "auto")] }, nextId).plan;
      assert.strictEqual(yield* reasonOf(autoStartAgent(plan, ids(plan)[1]!, app, ok, "ar1")), "番が来ているときだけ");
    }));

  it.effect(specOf(Spec.autoStart, "自動でやる Action Item だけ"), () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [claude("変更点を読む")] }, nextId).plan;
      assert.strictEqual(yield* reasonOf(autoStartAgent(plan, ids(plan)[0]!, app, ok, "ar1")), "自動でやる Action Item だけ");
    }));

  it.effect(specOf(Spec.autoStart, "一度も頼んでいないときだけ"), () =>
    Effect.gen(function* () {
      const plan = autoPlan();
      const asked = yield* requestAgent(plan, ids(plan)[0]!, user, open, "ar1");
      assert.strictEqual(yield* reasonOf(autoStartAgent(asked, ids(plan)[0]!, app, ok, "ar2")), "一度も頼んでいないときだけ");
    }));

  it.effect(specOf(Spec.autoStart, "自動でやってよい範囲に入る作業だけ（入らなければ、ボタンで頼むまで待つ）"), () =>
    Effect.gen(function* () {
      const plan = autoPlan();
      assert.strictEqual(yield* reasonOf(autoStartAgent(plan, ids(plan)[0]!, app, { ...ok, policy: "範囲に入らない" }, "ar1")), "自動でやってよい範囲に入る作業だけ（入らなければ、ボタンで頼むまで待つ）");
    }));

  it.effect(specOf(Spec.autoStart, "Task がやること のときだけ（完了待ちでは、自動で頼まない）"), () =>
    Effect.gen(function* () {
      const plan = autoPlan();
      assert.strictEqual(yield* reasonOf(autoStartAgent(plan, ids(plan)[0]!, app, { ...ok, task: "やることでない" }, "ar1")), "Task がやること のときだけ（完了待ちでは、自動で頼まない）");
    }));
});

describe(specOf(Spec.succeed), () => {
  const done = { run: "やり遂げた", subject: "頼んだときのまま" } as const;
  const asked = () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [claude("変更点を読む", "on_request", true), human("返事する")] }, nextId).plan;
      return { plan: yield* requestAgent(plan, ids(plan)[0]!, user, open, "ar1"), id: ids(plan)[0]! };
    });

  it.effect("頼んだ作業がやり遂げたら、Action Item を果たし、次に番が来る", () =>
    Effect.gen(function* () {
      const { plan, id } = yield* asked();
      const next = yield* succeedByAgent(plan, id, app, done);
      assert.deepStrictEqual([turnOf(next, id), turnOf(next, ids(plan)[1]!)], ["済んだ", "番が来ている"]);
    }));

  it.effect(specOf(Spec.succeed, "アプリだけ"), () =>
    Effect.gen(function* () {
      const { plan, id } = yield* asked();
      assert.strictEqual(yield* reasonOf(succeedByAgent(plan, id, user, done)), "アプリだけ");
    }));

  it.effect(specOf(Spec.succeed, "まだのときだけ"), () =>
    Effect.gen(function* () {
      const { plan, id } = yield* asked();
      const once = yield* succeedByAgent(plan, id, app, done);
      assert.strictEqual(yield* reasonOf(succeedByAgent(once, id, app, done)), "まだのときだけ");
    }));

  it.effect(specOf(Spec.succeed, "番が来ているときだけ（番が来る前にやり遂げたら、番が来るまで待つ）"), () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [human("先にやる"), claude("変更点を読む")] }, nextId).plan;
      const asked2 = yield* requestAgent(plan, ids(plan)[1]!, user, open, "ar1");
      assert.strictEqual(yield* reasonOf(succeedByAgent(asked2, ids(plan)[1]!, app, done)), "番が来ているときだけ（番が来る前にやり遂げたら、番が来るまで待つ）");
    }));

  it.effect(specOf(Spec.succeed, "Claude Code に頼んだ Action Item だけ"), () =>
    Effect.gen(function* () {
      const plan = fromDrafts({ type: "serial", items: [claude("変更点を読む")] }, nextId).plan;
      assert.strictEqual(yield* reasonOf(succeedByAgent(plan, ids(plan)[0]!, app, done)), "Claude Code に頼んだ Action Item だけ");
    }));

  it.effect(specOf(Spec.succeed, "頼んだ作業がやり遂げたときだけ"), () =>
    Effect.gen(function* () {
      const { plan, id } = yield* asked();
      assert.strictEqual(yield* reasonOf(succeedByAgent(plan, id, app, { ...done, run: "まだやり遂げていない" })), "頼んだ作業がやり遂げたときだけ");
    }));

  it.effect(specOf(Spec.succeed, "頼んだときから元の項目（PR の commit など）が変わっていないときだけ（変わっていたら果たさず、もう一度頼むよう見せる）"), () =>
    Effect.gen(function* () {
      const { plan, id } = yield* asked();
      assert.strictEqual(
        yield* reasonOf(succeedByAgent(plan, id, app, { ...done, subject: "変わった" })),
        "頼んだときから元の項目（PR の commit など）が変わっていないときだけ（変わっていたら果たさず、もう一度頼むよう見せる）",
      );
    }));
});
