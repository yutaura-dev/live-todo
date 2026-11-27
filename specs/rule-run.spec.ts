import { ensure } from "@yutaura/live-spec";

/**
 * Rule Run（ルールを 1 回当てたこと）。Rule の中にあり、Rule を通してだけ扱う。どの Task に、どのきっかけで、どの中身のルールを当てたか、当てはまったか、何をしたかを残す。
 * 同じ Task に、同じ中身のルールを、同じきっかけで当てるのは一度だけ（書き込みを二重に効かせないため）。ルールを書き換えたら、新しい中身で当て直す。
 * Decisions を呼べなかったとき（ネットワーク・回数の上限など）は、Rule Run を作らずに、次の回に判定し直す。
 */
export type RuleRun = {
  /** 当てたか */
  status: Status;
  /** Rule Run を見分ける ID */
  id: string;
  /** 当てたときのルールの中身（きっかけと操作）。中身ごとに一度だけ当てる */
  ruleFingerprint: string;
  /** @ref task */
  taskId: string;
  /** きっかけ（Task ができた・事実が増えた・事実が変わった・Task を完了にした などの出来事） */
  triggerKey: string;
  /** 当てはまる確率（Decisions で判定したとき。出来事のきっかけや、答えが返らなければ null） */
  probability: number | null;
  /** 当てなかった理由（当てたなら null） */
  skipReason: "当てはまらない" | "答えが返らない" | "ルールが変わった" | null;
  /** 判定した時刻 */
  decidedAt: string | null;
};

export const Status = {
  /** 判定を待っている（Decisions で判定するルール） */
  pending: "判定待ち",
  /** 当てた（Task を変えた・書き込みを頼んだ） */
  applied: "当てた",
  /** 当てなかった */
  skipped: "当てなかった",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

/** 当てるときに確かめること。ルールと Task の状態は、それぞれの集約が持つ */
type Check = {
  /** ルールのきっかけの種類 */
  trigger: "判定する" | "出来事";
  /** ルールが有効か */
  ruleEnabled: boolean;
  /** きっかけが、有効にした時刻より後に起きたか */
  afterEnabled: boolean;
  /** 同じ Task・同じ中身・同じきっかけで、もう当てたか */
  alreadyRun: boolean;
};

type Actor = { kind: "app" } | { kind: "decisions" } | { kind: "user" };

/** アプリ: きっかけを見つけてルールを当てる。Decisions: 条件に当てはまるかを確率で答える */
export const actors: Record<string, Actor> = {
  アプリ: { kind: "app" },
  Decisions: { kind: "decisions" },
  ユーザー: { kind: "user" },
};

/**
 * きっかけが起きたので、ルールを当て始める
 *
 * 出来事のきっかけ（Task を完了にした など）は、アプリが判定するので、すぐ当てる。言葉で書いた条件は、Decisions の判定を待つ。
 */
export function initial(actor: Actor, check: Check): RuleRun {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(check.ruleEnabled, "有効なルールだけ");
  ensure(check.afterEnabled, "有効にしたあとに起きたきっかけだけ");
  ensure(!check.alreadyRun, "同じ Task・同じ中身・同じきっかけで当てるのは一度だけ");
  const now = check.trigger === "出来事";
  return {
    status: now ? "当てた" : "判定待ち",
    id: "rr1",
    ruleFingerprint: "f1",
    taskId: "t1",
    triggerKey: now ? "Task を完了にした" : "事実が増えた:s1",
    probability: null,
    skipReason: null,
    decidedAt: now ? "2026-11-28T00:00:00Z" : null,
  };
}

/**
 * Decisions が判定した
 *
 * 確率が 0.8 以上のときだけ当てる。答えが返らない（断られた・形に合わない）ときは、当てない（自動で書き込むので、迷うものには当てない）。同じきっかけでは判定し直さない。
 */
export function decide(run: RuleRun, actor: Actor, result: "当てはまる" | "当てはまらない" | "答えが返らない"): RuleRun {
  ensure(actor.kind === "decisions", "Decisions だけ");
  ensure(run.status === "判定待ち", "判定待ちのときだけ");
  if (result === "当てはまる") return { ...run, status: "当てた", probability: 0.92, decidedAt: "2026-11-28T00:00:10Z" };
  return { ...run, status: "当てなかった", probability: result === "当てはまらない" ? 0.12 : null, skipReason: result, decidedAt: "2026-11-28T00:00:10Z" };
}

/** 判定を待っている間に、ルールを止めた・消した・書き換えたので、当てない（書き換えたなら、新しい中身で当て直す） */
export function cancel(run: RuleRun, actor: Actor): RuleRun {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(run.status === "判定待ち", "判定待ちのときだけ");
  return { ...run, status: "当てなかった", skipReason: "ルールが変わった" };
}

const ON_DECIDE: Check = { trigger: "判定する", ruleEnabled: true, afterEnabled: true, alreadyRun: false };
const ON_EVENT: Check = { ...ON_DECIDE, trigger: "出来事" };

export const inputs = {
  initial: {
    判定するルール: [ON_DECIDE],
    出来事のルール: [ON_EVENT],
    止めたルール: [{ ...ON_DECIDE, ruleEnabled: false }],
    有効にする前: [{ ...ON_DECIDE, afterEnabled: false }],
    もう当てた: [{ ...ON_DECIDE, alreadyRun: true }],
  },
  decide: { 当てはまる: ["当てはまる"], 当てはまらない: ["当てはまらない"], 答えが返らない: ["答えが返らない"] },
};

export const invariants = {
  "判定が済んだら、もう変わらない": (before: RuleRun, after: RuleRun) => before.status === "判定待ち" || before.status === after.status,
};

export const reviewed = {
  "indistinguishable-example:decide:当てはまらない,答えが返らない": "どちらも当てない（迷うものには当てない）。違いは当てなかった理由として記録に残し、ルールが当たらないときに原因を追えるようにする",
};

export const links = [
  { from: initial, to: "task", label: "出来事のきっかけで当てたら、ルールの操作で Task を変える（完了にする など）" },
  { from: initial, to: "write", label: "出来事のきっかけで当てたら、Task が持つ事実への書き込みを、ルールから頼む（Task を完了にしたらメールをアーカイブ など）" },
  { from: decide, to: "task", label: "当てはまったら、ルールの操作で Task を変える" },
  { from: decide, to: "write", label: "当てはまったら、Task が持つ事実への書き込みを、ルールから頼む" },
];

export const scenarios = {
  "事実が増えた Task に、言葉で書いたルールを判定して当てる": [
    { do: initial, by: "アプリ", input: "判定するルール", expect: { status: "判定待ち" } },
    { do: decide, by: "Decisions", input: "当てはまる", expect: { status: "当てた" } },
    { do: decide, by: "Decisions", input: "当てはまらない", denied: "判定待ちのときだけ" },
  ],
  "当てはまらなければ当てない": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: decide, by: "Decisions", input: "当てはまらない", expect: { status: "当てなかった", skipReason: "当てはまらない" } },
  ],
  "答えが返らなければ当てない（迷うものには当てない）": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: decide, by: "Decisions", input: "答えが返らない", expect: { status: "当てなかった", skipReason: "答えが返らない" } },
  ],
  "Task を完了にしたら、出来事のルールですぐ当てる": [{ do: initial, by: "アプリ", input: "出来事のルール", expect: { status: "当てた" } }],
  "止めたルールは当てない": [{ do: initial, by: "アプリ", input: "止めたルール", denied: "有効なルールだけ" }],
  "有効にする前に起きたことには当てない": [{ do: initial, by: "アプリ", input: "有効にする前", denied: "有効にしたあとに起きたきっかけだけ" }],
  "同じきっかけで二度は当てない": [{ do: initial, by: "アプリ", input: "もう当てた", denied: "同じ Task・同じ中身・同じきっかけで当てるのは一度だけ" }],
  "判定を待っている間にルールを止めたら、当てない": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: cancel, by: "Decisions", denied: "アプリだけ" },
    { do: cancel, by: "アプリ", expect: { status: "当てなかった", skipReason: "ルールが変わった" } },
    { do: decide, by: "Decisions", input: "当てはまる", denied: "判定待ちのときだけ" },
    { do: cancel, by: "アプリ", denied: "判定待ちのときだけ" },
  ],
  "ルールを当てるのはアプリだけ": [{ do: initial, by: "ユーザー", input: "判定するルール", denied: "アプリだけ" }],
  "判定するのは Decisions だけ": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: decide, by: "アプリ", input: "当てはまる", denied: "Decisions だけ" },
  ],
};
