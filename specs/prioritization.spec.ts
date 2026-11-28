import { ensure } from "@yutaura/live-spec";
import type { Priority, RuleResult } from "./priority.value.ts";

/**
 * 優先度の決まり方（Task の集約の中にあり、Task を通してだけ扱う）。ラベル（いつまでに手を付けるとよいか）は値オブジェクト Priority（priority.value.ts）で、ここではそれがどう決まったかを持つ。
 * 規則で決まるものは規則で、それ以外は Decisions の判定で決める（ADR-0003・ADR-0022）。材料は、Task の期日・他の人を止めているか、まだの Action Item の期日・手間・待つ見込み、と事実。
 * Decisions の答えは呼ぶたびに費用がかかるので、決まったラベルと材料をとっておき、材料が変わったとき・日が変わったときだけ決め直す。決め直す間は、前のラベルのまま並べる。
 * 答えが返らない・閾値の間・断られた・形に合わないなら「ラベル未定」に倒し、低い優先度とは扱わない（fail closed）。ラベル未定の Task は、ボードで「今すぐ」の上に印を付けて出し、ユーザーに決めてもらう。
 * ユーザーが決めたラベルは、ユーザーが外すまでアプリが変えない（理由は入力しない）。
 * 決めるのは、要確認と todo の Task だけ（仕分け中・終わった Task では決めない。やり直した Task では決め直す）。
 */
export type Prioritization = {
  /** ラベルがどう決まったか */
  status: Status;
  /** @ref task */
  taskId: string;
  /** いま見せるラベル（はじめて決める前・ラベル未定なら null。決め直す間は前のラベルのまま） */
  priority: Priority | null;
  /** 決めるのに使った材料（Task の期日・事実・計画）。変わったら決め直す */
  basisFingerprint: string;
};

export const Status = {
  /** まだ決めていない（Task を仕分けた・材料が変わった・日が変わった・ユーザーが外した） */
  pending: "未判定",
  /** 規則か Decisions で決まった */
  byApp: "アプリが決めた",
  /** Decisions の答えが返らない・閾値の間・断られた・形に合わない。ユーザーに決めてもらう（Task の「要確認」の列とは別） */
  undecided: "ラベル未定",
  /** ユーザーが決めた（アプリは変えない） */
  byUser: "ユーザーが決めた",
  /** Task が終わった・完了待ち・やらないことにした。アプリは決めない（やり直したら決め直す） */
  closed: "Task が開いていない",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "sync" } | { kind: "decisions" } | { kind: "user" };

/** 同期: 規則で決める・材料や日付の変化に気づく。Decisions: 確率付きで判定する */
export const actors: Record<string, Actor> = {
  同期: { kind: "sync" },
  Decisions: { kind: "decisions" },
  ユーザー: { kind: "user" },
};

/** Task を要確認か todo に仕分けたので、優先度を決め始める */
export function initial(actor: Actor): Prioritization {
  ensure(actor.kind === "sync", "同期だけ");
  return { status: "未判定", taskId: "t1", priority: null, basisFingerprint: "b1" };
}

const canDecide = (p: Prioritization) => p.status === "未判定" || p.status === "ラベル未定";

/** 規則で決まる（判断表「規則で決まる優先度」でラベルが出た。LLM は呼ばない） */
export function decideByRule(p: Prioritization, actor: Actor, rule: RuleResult): Prioritization {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(canDecide(p), "未判定・ラベル未定のときだけ");
  ensure(rule !== "規則では決めない" && rule !== "今日中以上（今すぐかは判定）", "規則でラベルが出たときだけ");
  return rule === "今日中"
    ? { ...p, status: "アプリが決めた", priority: { level: "今日中", reason: "期日まで余裕がない" } }
    : { ...p, status: "アプリが決めた", priority: { level: "3 日以内", reason: "期日まで 3 日" } };
}

/**
 * Decisions で判定した（規則で決まらなかったものだけ）
 *
 * いちばん確率の高いラベルが閾値以上なら、そのラベルに決める。閾値の間・断られた・形に合わない・答えが返らないなら、ラベル未定にする。
 * 他の人を止めているもの（規則で今日中以上）は、今すぐと判定されたときだけ今すぐにし、それ以外（迷ったときも）は今日中にする（止めているので、ラベル未定にして後回しにしない）。
 */
export function judge(
  p: Prioritization,
  actor: Actor,
  rule: RuleResult,
  result: Priority["level"] | "閾値の間・断られた・形に合わない" | "答えが返らない",
  basis: "今の材料" | "古い材料",
): Prioritization {
  ensure(actor.kind === "decisions", "Decisions だけ");
  ensure(canDecide(p), "未判定・ラベル未定のときだけ");
  ensure(rule === "規則では決めない" || rule === "今日中以上（今すぐかは判定）", "規則で決まらなかったときだけ");
  ensure(basis === "今の材料", "判定に渡した材料が今のものと同じときだけ（判定の間に材料が変わったら、答えを捨てて判定し直す）");
  if (rule === "今日中以上（今すぐかは判定）" && result !== "今すぐ") return { ...p, status: "アプリが決めた", priority: { level: "今日中", reason: "他の人を止めている" } };
  if (result === "閾値の間・断られた・形に合わない" || result === "答えが返らない") return { ...p, status: "ラベル未定", priority: null };
  return { ...p, status: "アプリが決めた", priority: { level: result, reason: "判定した" } };
}

/** ユーザーがラベルを決める（ラベル未定に答える・アプリが決めたものを変える） */
export function setByUser(p: Prioritization, actor: Actor): Prioritization {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(p.status !== "Task が開いていない", "Task が開いているときだけ");
  return { ...p, status: "ユーザーが決めた", priority: { level: "今日中", reason: "ユーザーが決めた" } };
}

/** ユーザーが決めたラベルを外す（アプリに決め直させる。決め直すまで、ユーザーが決めたラベルのまま並べる） */
export function clearByUser(p: Prioritization, actor: Actor): Prioritization {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(p.status === "ユーザーが決めた", "ユーザーが決めたときだけ");
  return { ...p, status: "未判定" };
}

/**
 * 決める材料（Task の期日・事実・計画）が変わった・日が変わった
 *
 * アプリが決めた・ラベル未定・決めている途中のラベルは、決め直す（期日が近づく・過ぎる、を拾うため、日が変わったときも）。ラベル未定は、決まるまでラベル未定の印のまま見せる。ユーザーが決めたラベルは変えない。
 */
export function basisChanged(p: Prioritization, actor: Actor, _why: "材料が変わった" | "日が変わった"): Prioritization {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(p.status !== "ユーザーが決めた", "ユーザーが決めたラベルは変えない");
  ensure(p.status !== "Task が開いていない", "Task が開いているときだけ");
  return { ...p, status: p.status === "ラベル未定" ? "ラベル未定" : "未判定", basisFingerprint: "b2" };
}

/** Task が開いていなくなったので、決めるのをやめる（ユーザーが決めたラベルは、もともとアプリが決めないので、そのまま残す） */
export function stop(p: Prioritization, actor: Actor): Prioritization {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(p.status !== "Task が開いていない", "Task が開いているときだけ");
  ensure(p.status !== "ユーザーが決めた", "アプリが決めるときだけ");
  return { ...p, status: "Task が開いていない" };
}

/** Task をやり直したので、決め直す */
export function resume(p: Prioritization, actor: Actor): Prioritization {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(p.status === "Task が開いていない", "Task が開いていないときだけ");
  return { ...p, status: "未判定", basisFingerprint: "b2" };
}

export const inputs = {
  decideByRule: { 今日中: ["今日中"], "3 日以内": ["3 日以内"], 規則で決まらない: ["規則では決めない"], 止めている: ["今日中以上（今すぐかは判定）"] },
  judge: {
    今すぐ: ["規則では決めない", "今すぐ", "今の材料"],
    "10 日以内": ["規則では決めない", "10 日以内", "今の材料"],
    それより先: ["規則では決めない", "それより先でよい", "今の材料"],
    閾値の間: ["規則では決めない", "閾値の間・断られた・形に合わない", "今の材料"],
    答えが返らない: ["規則では決めない", "答えが返らない", "今の材料"],
    規則で決まった: ["今日中", "10 日以内", "今の材料"],
    古い材料: ["規則では決めない", "10 日以内", "古い材料"],
    "止めている・今すぐ": ["今日中以上（今すぐかは判定）", "今すぐ", "今の材料"],
    "止めている・急がない": ["今日中以上（今すぐかは判定）", "10 日以内", "今の材料"],
    "止めている・迷った": ["今日中以上（今すぐかは判定）", "閾値の間・断られた・形に合わない", "今の材料"],
  },
  basisChanged: { 材料: ["材料が変わった"], 日: ["日が変わった"] },
};

export const invariants = {
  "決まっているときはラベルがあり、ラベル未定のときはない": (p: Prioritization) =>
    p.status === "ラベル未定" ? p.priority === null : p.status === "アプリが決めた" || p.status === "ユーザーが決めた" ? p.priority !== null : true,
  "ユーザーが決めたラベルは、ユーザーが外すまで変わらない": (before: Prioritization, after: Prioritization) =>
    before.status !== "ユーザーが決めた" ||
    (after.status === "ユーザーが決めた" && after.priority?.level === before.priority?.level) ||
    (after.status === "未判定" && after.priority?.level === before.priority?.level),
};

export const links = [
  { from: decideByRule, to: "task", action: "notePriority", label: "ラベルが変わったときだけ、Task の出来事に残す（同じラベルに決め直したときは残さない）" },
  { from: judge, to: "task", action: "notePriority", label: "ラベルが変わった・ラベル未定になったときだけ、Task の出来事に残す" },
  { from: setByUser, to: "task", action: "notePriority", label: "ユーザーが決めたラベルを、Task の出来事に残す（ユーザーが変えたので既読）" },
  { from: clearByUser, to: "task", action: "notePriority", label: "ユーザーが決めたラベルを外したことを、Task の出来事に残す（既読）" },
];

export const scenarios = {
  "期日に余裕がない Task は、規則で今日中にする": [
    { do: initial, by: "同期", expect: { status: "未判定" } },
    { do: judge, by: "Decisions", input: "規則で決まった", denied: "規則で決まらなかったときだけ" },
    { do: decideByRule, by: "同期", input: "今日中", expect: { status: "アプリが決めた", priority: { level: "今日中", reason: "期日まで余裕がない" } } },
    { do: decideByRule, by: "同期", input: "今日中", denied: "未判定・ラベル未定のときだけ" },
    { do: judge, by: "Decisions", input: "10 日以内", denied: "未判定・ラベル未定のときだけ" },
  ],
  "規則で 3 日以内に決まる": [
    { do: initial, by: "同期" },
    { do: decideByRule, by: "同期", input: "3 日以内", expect: { priority: { level: "3 日以内", reason: "期日まで 3 日" } } },
  ],
  "規則で決まらないものは、Decisions が判定する": [
    { do: initial, by: "同期" },
    { do: decideByRule, by: "同期", input: "規則で決まらない", denied: "規則でラベルが出たときだけ" },
    { do: judge, by: "Decisions", input: "10 日以内", expect: { status: "アプリが決めた", priority: { level: "10 日以内", reason: "判定した" } } },
  ],
  "急がないものは、それより先でよいにする": [
    { do: initial, by: "同期" },
    { do: judge, by: "Decisions", input: "それより先", expect: { priority: { level: "それより先でよい", reason: "判定した" } } },
  ],
  "他の人を止めているものは、今すぐか今日中にする（迷っても後回しにしない）": [
    { do: initial, by: "同期" },
    { do: decideByRule, by: "同期", input: "止めている", denied: "規則でラベルが出たときだけ" },
    { do: judge, by: "Decisions", input: "止めている・迷った", expect: { priority: { level: "今日中", reason: "他の人を止めている" } } },
    { do: basisChanged, by: "同期", input: "材料" },
    { do: judge, by: "Decisions", input: "止めている・急がない", expect: { priority: { level: "今日中", reason: "他の人を止めている" } } },
    { do: basisChanged, by: "同期", input: "材料" },
    { do: judge, by: "Decisions", input: "止めている・今すぐ", expect: { priority: { level: "今すぐ", reason: "判定した" } } },
  ],
  "答えが返らなければ、低い優先度ではなくラベル未定にする": [
    { do: initial, by: "同期" },
    { do: judge, by: "Decisions", input: "答えが返らない", expect: { status: "ラベル未定", priority: null } },
    { do: setByUser, by: "ユーザー", expect: { status: "ユーザーが決めた" } },
  ],
  "ラベル未定は、決め直す間もラベル未定のまま見せる": [
    { do: initial, by: "同期" },
    { do: judge, by: "Decisions", input: "閾値の間", expect: { status: "ラベル未定" } },
    { do: basisChanged, by: "同期", input: "日", expect: { status: "ラベル未定" } },
    { do: judge, by: "Decisions", input: "10 日以内", expect: { status: "アプリが決めた" } },
  ],
  "判定の間に材料が変わったら、古い材料での答えは捨てる": [
    { do: initial, by: "同期" },
    { do: basisChanged, by: "同期", input: "材料", expect: { status: "未判定" } },
    { do: judge, by: "Decisions", input: "古い材料", denied: "判定に渡した材料が今のものと同じときだけ（判定の間に材料が変わったら、答えを捨てて判定し直す）" },
    { do: judge, by: "Decisions", input: "今すぐ", expect: { priority: { level: "今すぐ", reason: "判定した" } } },
  ],
  "日が変わったら、前のラベルのまま決め直す（期日が近づく）": [
    { do: initial, by: "同期" },
    { do: judge, by: "Decisions", input: "10 日以内" },
    { do: basisChanged, by: "同期", input: "日", expect: { status: "未判定", priority: { level: "10 日以内", reason: "判定した" } } },
    { do: decideByRule, by: "同期", input: "今日中", expect: { priority: { level: "今日中", reason: "期日まで余裕がない" } } },
  ],
  "ユーザーが決めたラベルは、外すまで変えない": [
    { do: initial, by: "同期" },
    { do: judge, by: "Decisions", input: "10 日以内" },
    { do: setByUser, by: "ユーザー" },
    { do: basisChanged, by: "同期", input: "日", denied: "ユーザーが決めたラベルは変えない" },
    { do: stop, by: "同期", denied: "アプリが決めるときだけ" },
    { do: clearByUser, by: "ユーザー", expect: { status: "未判定", priority: { level: "今日中", reason: "ユーザーが決めた" } } },
    { do: clearByUser, by: "ユーザー", denied: "ユーザーが決めたときだけ" },
  ],
  "開いていない Task では決めず、やり直したら決め直す": [
    { do: initial, by: "同期" },
    { do: judge, by: "Decisions", input: "10 日以内" },
    { do: resume, by: "同期", denied: "Task が開いていないときだけ" },
    { do: stop, by: "Decisions", denied: "同期だけ" },
    { do: stop, by: "同期", expect: { status: "Task が開いていない" } },
    { do: stop, by: "同期", denied: "Task が開いているときだけ" },
    { do: basisChanged, by: "同期", input: "日", denied: "Task が開いているときだけ" },
    { do: setByUser, by: "ユーザー", denied: "Task が開いているときだけ" },
    { do: resume, by: "Decisions", denied: "同期だけ" },
    { do: resume, by: "同期", expect: { status: "未判定", priority: { level: "10 日以内", reason: "判定した" } } },
  ],
  "優先度を決め始めるのは同期だけ": [{ do: initial, by: "ユーザー", denied: "同期だけ" }],
  "ラベルを決めるのは決まった人だけ": [
    { do: initial, by: "同期" },
    { do: decideByRule, by: "Decisions", input: "今日中", denied: "同期だけ" },
    { do: judge, by: "同期", input: "10 日以内", denied: "Decisions だけ" },
    { do: setByUser, by: "同期", denied: "ユーザーだけ" },
    { do: basisChanged, by: "ユーザー", input: "材料", denied: "同期だけ" },
    { do: setByUser, by: "ユーザー" },
    { do: clearByUser, by: "同期", denied: "ユーザーだけ" },
  ],
};

export const reviewed = {
  "equivalent-states:未判定 · priority=なし/ラベル未定 · priority=なし/未判定 · { level: 今日中 }/未判定 · { level: 3 日以内 }/未判定 · { level: 今すぐ }/未判定 · { level: 10 日以内 }/未判定 · { level: それより先でよい }": "決め直す間・ラベル未定は、できること（決める・材料や日が変わったら決め直す・ユーザーが決める）は同じだが、見せ方が違う（前のラベルのまま並べる・ラベル未定の印を付ける・はじめて決める前は並べない）",
  "equivalent-states:アプリが決めた · { level: 今日中 }/アプリが決めた · { level: 3 日以内 }/アプリが決めた · { level: 今すぐ }/アプリが決めた · { level: 10 日以内 }/アプリが決めた · { level: それより先でよい }": "アプリが決めたラベルごとに、できることは同じだが、ボードの並びと見せる理由が違う",
  "equivalent-states:Task が開いていない · priority=なし/Task が開いていない · { level: 今日中 }/Task が開いていない · { level: 3 日以内 }/Task が開いていない · { level: 今すぐ }/Task が開いていない · { level: 10 日以内 }/Task が開いていない · { level: それより先でよい }": "Task が開いていない間はラベルを見せないが、やり直したときに前のラベルのまま並べるために残す",
  "indistinguishable-example:judge:今すぐ,止めている・今すぐ": "今すぐと判定されたら、他の人を止めているかにかかわらず今すぐにする。同じ結果になるのが意図どおり",
  "indistinguishable-example:judge:止めている・急がない,止めている・迷った": "他の人を止めているものは、急がないと判定されても迷っても今日中にする（ラベル未定にして後回しにしない）。同じ結果になるのが意図どおり",
  "indistinguishable-example:judge:閾値の間,答えが返らない": "どちらも、低い優先度ではなくラベル未定に倒す（fail closed）。返らなかったのか、閾値の間・断られた・形に合わないのかは記録では分けるが、できることは同じ",
  "ignores-input:basisChanged": "材料が変わっても日が変わっても、同じく決め直す。どちらで決め直したかは記録のために受け取る",
};
