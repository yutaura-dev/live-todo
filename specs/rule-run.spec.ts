import { ensure } from "@yutaura/live-spec";

/**
 * Rule Run（ルールを 1 回当てたこと）。Rule の中にあり、Rule を通してだけ扱う。どの Task に、どのきっかけで、どの中身のルールを当てたか、条件に合ったか、何をしたかを残す。
 * 同じ Task に、同じ中身のルールを、同じきっかけで当てるのは一度だけ（書き込みを二重に効かせないため。Rule 集約の不変条件で守る）。ルールから頼む書き込みは、この記録を指す。
 * 記録を作れるのは、ルールが有効なときだけ（Rule を通して作る）。
 * ルールで変えた Task の変化（完了にした など）も、ほかのルールのきっかけになる。終わらない連鎖を防ぐため、きっかけは連鎖（ユーザー・同期・AI が起こした最初の変化から、ルールが起こした変化をたどったもの）を持ち、1 つの連鎖の中で同じルールは 2 回以上当てない。
 * 1 回の変化で、いくつものルールが当たることがある（ルールごとに記録が 1 つできる）。Task への操作が食い違ったら（完了にする と やることにする など）、どれも当てずに Task を要確認にする（fail closed）。外への書き込みは、食い違わないのでそれぞれ頼む。
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
  /** きっかけの連鎖（最初の変化の ID と、この連鎖でもう当てたルール） */
  chain: { chainId: string; appliedRuleIds: string[] };
  /** 条件に合う確率（Decisions で判定したとき。問いごとの確率のうち、いちばん低いもの。出来事のきっかけや、答えが返らなければ null） */
  probability: number | null;
  /** 当てなかった理由（当てた・判定待ちなら null） */
  skipReason: SkipReason | null;
  /** 何をしたか（Task をどう変えたか・頼んだ書き込み）。当てていなければ null */
  applied: { task: string | null; writeIds: string[] } | null;
  /** 判定した時刻 */
  decidedAt: string | null;
};

export type SkipReason = "条件に合わない" | "答えが返らない" | "Task が閉じていた" | "ルールを止めた" | "ルールを消した" | "ルールを書き換えた";

export const Status = {
  /** 判定を待っている（Decisions で判定するルール） */
  pending: "判定待ち",
  /** 当てた（Task を変えた・書き込みを頼んだ） */
  applied: "当てた",
  /** 当てなかった */
  skipped: "当てなかった",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

/** 当てるときに確かめること（ルールが有効か・もう当てたかは、Rule 集約が守る） */
type Check = {
  /** ルールのきっかけの種類 */
  trigger: "判定する" | "出来事";
  /** きっかけが、有効にした時刻より後に起きたか */
  afterEnabled: boolean;
  /** このきっかけの連鎖の中で、このルールをもう当てたか */
  inChain: "まだ当てていない" | "もう当てた";
};

type Actor = { kind: "app" } | { kind: "decisions" } | { kind: "user" };

/** アプリ: きっかけを見つけてルールを当てる。Decisions: 条件に合うかを確率で答える */
export const actors: Record<string, Actor> = {
  アプリ: { kind: "app" },
  Decisions: { kind: "decisions" },
  ユーザー: { kind: "user" },
};

const THRESHOLD = 0.8;
const APPLIED = { task: "完了にする", writeIds: ["w1"] };

/**
 * きっかけが起きたので、ルールを当て始める
 *
 * 出来事のきっかけ（Task を完了にした など）は、アプリが判定するので、すぐ当てる。言葉で書いた条件は、Decisions の判定を待つ。
 */
export function initial(actor: Actor, check: Check): RuleRun {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(check.afterEnabled, "有効にしたあとに起きたきっかけだけ");
  ensure(check.inChain === "まだ当てていない", "1 つの連鎖の中で、同じルールは 1 回だけ");
  const now = check.trigger === "出来事";
  return {
    status: now ? "当てた" : "判定待ち",
    id: "rr1",
    ruleFingerprint: "f1",
    taskId: "t1",
    triggerKey: now ? "Task を完了にした" : "事実が増えた:s1",
    chain: { chainId: "c1", appliedRuleIds: ["r1"] },
    probability: null,
    skipReason: null,
    applied: now ? { task: null, writeIds: ["w1"] } : null,
    decidedAt: now ? "2026-11-28T00:00:00Z" : null,
  };
}

/**
 * Decisions が判定した
 *
 * 問いごとの確率のうち、いちばん低いものが 0.8 以上のときだけ当てる。答えが返らない（断られた・形に合わない）ときは、例外として当てない（自動で書き込むので、迷うものには当てない）。同じきっかけでは判定し直さない。
 * 判定を待つ間に Task が閉じていたら（ユーザーが完了にした など）、当てない。
 */
export function decide(run: RuleRun, actor: Actor, result: "条件に合う" | "条件に合わない" | "答えが返らない", task: "開いている" | "閉じた"): RuleRun {
  ensure(actor.kind === "decisions", "Decisions だけ");
  ensure(run.status === "判定待ち", "判定待ちのときだけ");
  const decided = { decidedAt: "2026-11-28T00:00:10Z" };
  if (result === "答えが返らない") return { ...run, ...decided, status: "当てなかった", skipReason: "答えが返らない" };
  const probability = result === "条件に合う" ? 0.92 : 0.12;
  if (probability < THRESHOLD) return { ...run, ...decided, status: "当てなかった", probability, skipReason: "条件に合わない" };
  if (task === "閉じた") return { ...run, ...decided, status: "当てなかった", probability, skipReason: "Task が閉じていた" };
  return { ...run, ...decided, status: "当てた", probability, applied: APPLIED };
}

/**
 * Decisions を呼べなかった（ネットワーク・回数の上限・API キーが切れた など）
 *
 * 判定待ちのまま、次の回に判定し直す。呼べなかったことを「条件に合わない」と残さない。
 */
export function unavailable(run: RuleRun, actor: Actor): RuleRun {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(run.status === "判定待ち", "判定待ちのときだけ");
  return { ...run };
}

/** 判定を待っている間に、ルールを止めた・消した・書き換えたので、当てない（書き換えたなら、新しい中身で当て直す） */
export function cancel(run: RuleRun, actor: Actor, reason: "ルールを止めた" | "ルールを消した" | "ルールを書き換えた"): RuleRun {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(run.status === "判定待ち", "判定待ちのときだけ");
  return { ...run, status: "当てなかった", skipReason: reason };
}

const ON_DECIDE: Check = { trigger: "判定する", afterEnabled: true, inChain: "まだ当てていない" };
const ON_EVENT: Check = { ...ON_DECIDE, trigger: "出来事" };

export const inputs = {
  initial: {
    判定するルール: [ON_DECIDE],
    出来事のルール: [ON_EVENT],
    有効にする前: [{ ...ON_DECIDE, afterEnabled: false }],
    連鎖でもう当てた: [{ ...ON_EVENT, inChain: "もう当てた" }],
  },
  decide: {
    条件に合う: ["条件に合う", "開いている"],
    条件に合わない: ["条件に合わない", "開いている"],
    答えが返らない: ["答えが返らない", "開いている"],
    "Task が閉じた": ["条件に合う", "閉じた"],
  },
  cancel: { 止めた: ["ルールを止めた"], 消した: ["ルールを消した"], 書き換えた: ["ルールを書き換えた"] },
};

export const invariants = {
  "判定が済んだら、もう変わらない": (before: RuleRun, after: RuleRun) => before.status === "判定待ち" || before.status === after.status,
  "判定して当てたなら、確率は 0.8 以上": (run: RuleRun) => run.status !== "当てた" || run.probability === null || run.probability >= THRESHOLD,
  "当てなかったときだけ、当てなかった理由がある": (run: RuleRun) => (run.status === "当てなかった") === (run.skipReason !== null),
  "当てたときだけ、何をしたかがある": (run: RuleRun) => (run.status === "当てた") === (run.applied !== null),
};

export const reviewed = {
  "unused-field:applied": "何をしたかは、あとから追うための記録で、操作の可否は変えない。当てたときだけあることを、不変条件で確かめるために読んでいる",
  "unused-field:probability": "確率は判定の結果の記録で、操作の可否は変えない。当てたなら 0.8 以上であることを、不変条件で確かめるために読んでいる",
};

export const links = [
  { from: initial, to: "task", label: "出来事のきっかけで当てたら、ルールの操作で Task を変える（完了にする など）。同じきっかけのほかのルールと操作が食い違ったら、どれも当てずに要確認にする。変えた Task の変化は、同じ連鎖の次のきっかけになる" },
  { from: initial, to: "write", label: "出来事のきっかけで当てたら、Task が持つ事実への書き込みを、この記録から頼む（Task を完了にしたらメールをアーカイブ など）" },
  { from: decide, to: "task", label: "条件に合ったら、ルールの操作で Task を変える。同じきっかけのほかのルールと操作が食い違ったら、どれも当てずに要確認にする。変えた Task の変化は、同じ連鎖の次のきっかけになる" },
  { from: decide, to: "write", label: "条件に合ったら、Task が持つ事実への書き込みを、この記録から頼む" },
];

export const scenarios = {
  "事実が増えた Task に、言葉で書いたルールを判定して当てる": [
    { do: initial, by: "アプリ", input: "判定するルール", expect: { status: "判定待ち" } },
    { do: decide, by: "Decisions", input: "条件に合う", expect: { status: "当てた", applied: { task: "完了にする" } } },
    { do: decide, by: "Decisions", input: "条件に合わない", denied: "判定待ちのときだけ" },
  ],
  "条件に合わなければ当てない": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: decide, by: "Decisions", input: "条件に合わない", expect: { status: "当てなかった", skipReason: "条件に合わない" } },
  ],
  "答えが返らなければ、例外として当てない": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: decide, by: "Decisions", input: "答えが返らない", expect: { status: "当てなかった", skipReason: "答えが返らない" } },
  ],
  "判定を待つ間に Task が閉じたら、当てない": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: decide, by: "Decisions", input: "Task が閉じた", expect: { status: "当てなかった", skipReason: "Task が閉じていた" } },
  ],
  "Decisions を呼べなかったら、判定待ちのまま次の回に判定し直す": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: unavailable, by: "アプリ", expect: { status: "判定待ち" } },
    { do: unavailable, by: "Decisions", denied: "アプリだけ" },
    { do: decide, by: "Decisions", input: "条件に合う", expect: { status: "当てた" } },
    { do: unavailable, by: "アプリ", denied: "判定待ちのときだけ" },
  ],
  "Task を完了にしたら、出来事のルールですぐ当てる": [{ do: initial, by: "アプリ", input: "出来事のルール", expect: { status: "当てた" } }],
  "1 つの連鎖の中で、同じルールは 2 回当てない（ルールが行き来して終わらなくなるのを防ぐ）": [
    { do: initial, by: "アプリ", input: "連鎖でもう当てた", denied: "1 つの連鎖の中で、同じルールは 1 回だけ" },
  ],
  "有効にする前に起きたことには当てない": [{ do: initial, by: "アプリ", input: "有効にする前", denied: "有効にしたあとに起きたきっかけだけ" }],
  "判定を待っている間にルールを止めたら、当てない": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: cancel, by: "Decisions", input: "止めた", denied: "アプリだけ" },
    { do: cancel, by: "アプリ", input: "止めた", expect: { status: "当てなかった", skipReason: "ルールを止めた" } },
    { do: decide, by: "Decisions", input: "条件に合う", denied: "判定待ちのときだけ" },
    { do: cancel, by: "アプリ", input: "止めた", denied: "判定待ちのときだけ" },
  ],
  "ルールを当てるのはアプリだけ": [{ do: initial, by: "ユーザー", input: "判定するルール", denied: "アプリだけ" }],
  "判定するのは Decisions だけ": [
    { do: initial, by: "アプリ", input: "判定するルール" },
    { do: decide, by: "アプリ", input: "条件に合う", denied: "Decisions だけ" },
  ],
};
