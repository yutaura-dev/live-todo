import { ensure } from "@yutaura/live-spec";
import type { ActionItem } from "./action-item.spec.ts";
import type { Arrangement } from "./action-definition.value.ts";

/**
 * Task（自分がやること）。カンバンのどの列に出るかを status で持つ。
 * 次にやることの計画（plan）と、その中の Action Item は、Task の中にある。Action Item 1 つの進み方は action-item に書く。
 * Task は Source Item の状態を写さない。Source Item に起きたこと（PR が merge された・元の項目がなくなった など）は、
 * 「やり終えた」「やらないことにした」という Task の言葉に置き換えてから、Task を終える。
 */
export type Task = {
  /** 列。ユーザーの判断と、Task の言葉に置き換えた出来事でだけ変わる。AI の作業では変わらない */
  status: Status;
  /** どう終わったか。終わったときだけ持つ */
  closure: Closure | null;
  /** AI が作業中か。計画の Action Item を Claude Code がやっている・Task について AI が作業している（計画を考える・質問に答える など）ときに作業中になる */
  work: Work;
  /** 計画の進み具合。計画の Action Item から決まる */
  planProgress: PlanProgress;
  /** Task を見分ける ID */
  id: string;
  /** 何をするか（Source の言葉ではなく、自分にとっての意味で） */
  title: string;
  /** 今の状況と次の一手 */
  brief: string | null;
  /** 次にやることの計画 */
  plan: Plan | null;
  /** 追う Source Item（tracks: 終わるきっかけになる）と、関連する Source Item（context）。1 つの Source Item を、いくつの Task が追ってもよい */
  sourceItems: Array<{ sourceItemId: string; role: "tracks" | "context" }>;
  /** 作った日時・最後に変えた日時 */
  createdAt: string;
  updatedAt: string;
};

/**
 * 計画（Action Item の並び）。並べ方で、いつ Action Item に番が来るかが決まる。
 * 分かれ道で選んで差し込んだ先は「枝」として持ち、選び直したら、前の枝は取りやめた枝として残す（済んだことは消さない）。
 */
export type Plan = {
  /** 並べ方 */
  type: Arrangement;
  /** 並べる Action Item・入れ子の並び・分かれ道で差し込んだ枝 */
  items: Array<ActionItem | Plan | Branch>;
};

/** 分かれ道で選んで差し込んだ枝 */
export type Branch = {
  type: "branch";
  /** どの分かれ道の Action Item で選んだか */
  decisionId: string;
  /** 選んだ選択肢の名前 */
  option: string;
  /** 進めているか、選び直して取りやめたか */
  state: "進めている" | "取りやめた";
  /** 差し込んだ並び（選んでから考える選択肢なら、AI が考えるまで空） */
  plan: Plan | null;
};

export const Status = {
  /** 仕分け中。Task にしたばかりで、todo か要確認かをまだ決めていない */
  triaging: "triaging",
  /** 要確認。判定が割れた・refusal だった・todo ではないと判定された */
  needs_review: "needs_review",
  /** やること */
  todo: "todo",
  /** 終わった。どう終わったかは closure に持つ */
  closed: "closed",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const Work = {
  /** AI は何もしていない */
  idle: "なし",
  /** AI が作業中。ボードでは「AI 作業中」と出す */
  working: "作業中",
} as const;
export type Work = (typeof Work)[keyof typeof Work];

export const PlanProgress = {
  /** 計画がない */
  none: "計画なし",
  /** まだの Action Item がある */
  remaining: "まだのものがある",
  /** 計画の Action Item が、すべて済んだか、やらなくなった */
  finished: "全部済んだ",
} as const;
export type PlanProgress = (typeof PlanProgress)[keyof typeof PlanProgress];

/** どう終わったか */
export type Closure =
  /** やり終えた。完了の列に出る */
  | { outcome: "done"; reason: CompleteReason }
  /** やらないことにした。ボードには出ない */
  | { outcome: "dismissed"; reason: DismissReason };

export const CompleteReason = {
  /** 自分で完了にした */
  byUser: "自分で完了にした",
  /** 計画の Action Item が全部済んだ */
  planFinished: "計画が全部済んだ",
  /** 追う Source Item がすべて片付いた（PR が merge された など） */
  tracksResolved: "追う Source Item が片付いた",
} as const;
export type CompleteReason = (typeof CompleteReason)[keyof typeof CompleteReason];

export const DismissReason = {
  /** 自分で片付けた（削除も含む） */
  byUser: "自分で片付けた",
  /** 絞り込みの外になった */
  filteredOut: "絞り込みの外になった",
  /** 追う Source Item がなくなり、やる必要がなくなった */
  tracksRemoved: "追う Source Item がなくなった",
} as const;
export type DismissReason = (typeof DismissReason)[keyof typeof DismissReason];

type Actor = { kind: "user" } | { kind: "sync" } | { kind: "agent" };
type Open = "needs_review" | "todo";

const isOpen = (task: Task) => task.status === "needs_review" || task.status === "todo";

export const initial: Task = {
  status: "triaging",
  closure: null,
  work: "なし",
  planProgress: "計画なし",
  id: "t1",
  title: "依存更新の PR を確かめて merge する",
  brief: null,
  plan: null,
  sourceItems: [],
  createdAt: "2026-11-28T00:00:00Z",
  updatedAt: "2026-11-28T00:00:00Z",
};

export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
  AI: { kind: "agent" },
};

/**
 * 仕分ける
 *
 * 同期が項目を判定する、AI が会話を読む、ユーザーが手で足す・定期の Task から作る・AI の案を受け入れる。
 * 要確認にするのは、同期の判定が todo と言い切れなかったときだけ。
 */
export function triage(task: Task, actor: Actor, to: Open): Task {
  ensure(task.status === "triaging", "仕分け中のときだけ");
  ensure(to === "todo" || actor.kind === "sync", "要確認にするのは同期だけ");
  return { ...task, status: to };
}

/** 要確認と todo のあいだで移す */
export function move(task: Task, actor: Actor, to: Open): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  ensure(task.work === "なし", "AI が作業中でないときだけ");
  return { ...task, status: to };
}

/**
 * やり終えた
 *
 * 計画が全部済んで完了にするのは todo の Task だけ。要確認の Task は、計画が済んでも、自分で確かめるまで終えない。
 */
export function complete(task: Task, actor: Actor, reason: CompleteReason): Task {
  ensure(reason !== "自分で完了にした" || actor.kind === "user", "自分で完了にするのはユーザーだけ");
  ensure(reason !== "追う Source Item が片付いた" || actor.kind === "sync", "追う Source Item が片付いたと決めるのは同期だけ");
  ensure(reason !== "計画が全部済んだ" || actor.kind !== "sync", "計画が全部済んだと決めるのはユーザーか AI だけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  ensure(task.work === "なし", "AI が作業中でないときだけ");
  ensure(reason !== "計画が全部済んだ" || (task.status === "todo" && task.planProgress === "全部済んだ"), "計画が済んで完了にするのは、todo で計画が全部済んだときだけ");
  return { ...task, status: "closed", closure: { outcome: "done", reason } };
}

/** やらないことにする */
export function dismiss(task: Task, actor: Actor, reason: DismissReason): Task {
  ensure(reason === "自分で片付けた" ? actor.kind === "user" : actor.kind === "sync", "自分で片付けるのはユーザー、それ以外は同期だけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  ensure(task.work === "なし", "AI が作業中でないときだけ");
  return { ...task, status: "closed", closure: { outcome: "dismissed", reason } };
}

/**
 * やり直す
 *
 * 同期が戻すのは、やり終えた Task だけ（追う Source Item が再オープンしたとき）。やらないことにした Task は、同期では戻らない。
 * ユーザーが済んだ Action Item を戻したときも、やり終えた Task なら戻す。
 */
export function reopen(task: Task, actor: Actor): Task {
  ensure(actor.kind !== "agent", "ユーザーか同期だけ");
  ensure(task.status === "closed", "終わったときだけ");
  ensure(actor.kind !== "sync" || task.closure?.outcome === "done", "同期が戻すのは、やり終えた Task だけ");
  return { ...task, status: "todo", closure: null };
}

/**
 * AI が作業を始める
 *
 * 計画の Action Item を Claude Code に頼む・自動で始める、Task について AI に頼む（計画を考え直す・質問に答える・PR を調べる など）。
 * 作業がいくつ動いていても、作業中は 1 つの状態として扱う。
 */
export function startWork(task: Task, actor: Actor): Task {
  ensure(actor.kind !== "sync", "ユーザーか AI だけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  return { ...task, work: "作業中" };
}

/** AI の作業がすべて終わる */
export function finishWork(task: Task, actor: Actor): Task {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(task.work === "作業中", "AI が作業中のときだけ");
  return { ...task, work: "なし" };
}

/**
 * AI の作業を止める
 *
 * 画面では、止めてよいかを確かめてから止める。分かれ道を選び直すときに、選び直す枝で作業が動いていたら、先にこれで止める。
 * 追う Source Item が片付いて、AI が自分で作業をやめたときも止まる。
 */
export function stopWork(task: Task, actor: Actor): Task {
  ensure(actor.kind !== "sync", "ユーザーか AI だけ");
  ensure(task.work === "作業中", "AI が作業中のときだけ");
  return { ...task, work: "なし" };
}

/**
 * 計画を立て直す
 *
 * AI が、済んだ Action Item は残して、残りの計画を作り直す。分かれ道で「選んでから考える」選択肢を選んだときも、AI がその方針で先の計画を考えて差し込む。
 */
export function revisePlan(task: Task, actor: Actor): Task {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(task.work === "作業中", "AI が作業中のときだけ");
  return { ...task, planProgress: "まだのものがある" };
}

/**
 * 計画にまだの Action Item ができる
 *
 * 分かれ道で選んで、決まっている先の計画を差し込んだ・済んだ Action Item を戻した。
 */
export function addRemaining(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.planProgress !== "計画なし", "計画があるときだけ");
  return { ...task, planProgress: "まだのものがある" };
}

/** 計画の Action Item が、すべて済むか、やらなくなる */
export function finishPlan(task: Task, _actor: Actor): Task {
  ensure(task.planProgress === "まだのものがある", "まだのものがあるときだけ");
  return { ...task, planProgress: "全部済んだ" };
}

export const inputs = {
  triage: { todo: ["todo"], 要確認: ["needs_review"] },
  move: { 要確認へ: ["needs_review"], todoへ: ["todo"] },
  complete: { 自分で: ["自分で完了にした"], 計画が済んだ: ["計画が全部済んだ"], 追う項目が片付いた: ["追う Source Item が片付いた"] },
  dismiss: { 自分で: ["自分で片付けた"], 絞り込みの外: ["絞り込みの外になった"], 追う項目がなくなった: ["追う Source Item がなくなった"] },
};

export const invariants = {
  "終わり方を持つのは、終わった Task だけ": (task: Task) => (task.status === "closed") === (task.closure !== null),
  "終わった Task では、AI は作業していない": (task: Task) => task.status !== "closed" || task.work === "なし",
  "仕分けたあとは、仕分け中に戻らない": (before: Task, after: Task) => before.status === "triaging" || after.status !== "triaging",
  "AI の作業を始めても終えても、列は変わらない": (before: Task, after: Task) => before.work === after.work || before.status === after.status,
};

export const scenarios = {
  "PR を追う Task が、merge でやり終え、再オープンでやり直す": [
    { do: triage, by: "同期", input: "todo", expect: { status: "todo" } },
    { do: complete, by: "同期", input: "追う項目が片付いた", expect: { status: "closed", closure: { outcome: "done", reason: "追う Source Item が片付いた" } } },
    { do: reopen, by: "同期", expect: { status: "todo", closure: null } },
  ],
  "やらないことにした Task は、同期では戻らない": [
    { do: triage, by: "同期", input: "要確認" },
    { do: dismiss, by: "ユーザー", input: "自分で", expect: { status: "closed", closure: { outcome: "dismissed", reason: "自分で片付けた" } } },
    { do: reopen, by: "同期", denied: "同期が戻すのは、やり終えた Task だけ" },
    { do: reopen, by: "ユーザー", expect: { status: "todo" } },
  ],
  "AI が作業中は、列を動かさず、終えもしない": [
    { do: triage, by: "同期", input: "要確認" },
    { do: startWork, by: "ユーザー", expect: { work: "作業中", status: "needs_review" } },
    { do: move, by: "ユーザー", input: "todoへ", denied: "AI が作業中でないときだけ" },
    { do: complete, by: "同期", input: "追う項目が片付いた", denied: "AI が作業中でないときだけ" },
    { do: dismiss, by: "同期", input: "絞り込みの外", denied: "AI が作業中でないときだけ" },
    { do: finishWork, by: "AI", expect: { work: "なし", status: "needs_review" } },
  ],
  "作業を止めてから、やらないことにする": [
    { do: triage, by: "AI", input: "todo" },
    { do: startWork, by: "AI" },
    { do: dismiss, by: "ユーザー", input: "自分で", denied: "AI が作業中でないときだけ" },
    { do: stopWork, by: "同期", denied: "ユーザーか AI だけ" },
    { do: stopWork, by: "ユーザー", expect: { work: "なし" } },
    { do: dismiss, by: "ユーザー", input: "自分で", expect: { status: "closed" } },
  ],
  "計画が全部済んだら、todo の Task はやり終える": [
    { do: triage, by: "ユーザー", input: "todo" },
    { do: addRemaining, by: "ユーザー", denied: "計画があるときだけ" },
    { do: revisePlan, by: "AI", denied: "AI が作業中のときだけ" },
    { do: startWork, by: "ユーザー" },
    { do: revisePlan, by: "ユーザー", denied: "AI だけ" },
    { do: revisePlan, by: "AI", expect: { planProgress: "まだのものがある" } },
    { do: finishWork, by: "AI" },
    { do: complete, by: "AI", input: "計画が済んだ", denied: "計画が済んで完了にするのは、todo で計画が全部済んだときだけ" },
    { do: finishPlan, by: "ユーザー", expect: { planProgress: "全部済んだ" } },
    { do: finishPlan, by: "ユーザー", denied: "まだのものがあるときだけ" },
    { do: addRemaining, by: "同期", denied: "ユーザーだけ" },
    { do: addRemaining, by: "ユーザー", expect: { planProgress: "まだのものがある" } },
    { do: finishPlan, by: "AI" },
    { do: complete, by: "同期", input: "計画が済んだ", denied: "計画が全部済んだと決めるのはユーザーか AI だけ" },
    { do: complete, by: "AI", input: "計画が済んだ", expect: { status: "closed" } },
  ],
  "誰が終えられるかは、終わり方の理由で決まる": [
    { do: triage, by: "同期", input: "要確認" },
    { do: complete, by: "AI", input: "自分で", denied: "自分で完了にするのはユーザーだけ" },
    { do: complete, by: "ユーザー", input: "追う項目が片付いた", denied: "追う Source Item が片付いたと決めるのは同期だけ" },
    { do: dismiss, by: "ユーザー", input: "絞り込みの外", denied: "自分で片付けるのはユーザー、それ以外は同期だけ" },
    { do: complete, by: "ユーザー", input: "自分で", expect: { status: "closed" } },
  ],
  "操作はそれぞれ決まった人だけが起こし、仕分け中は仕分けしかできない": [
    { do: move, by: "ユーザー", input: "todoへ", denied: "要確認か todo のときだけ" },
    { do: complete, by: "ユーザー", input: "自分で", denied: "要確認か todo のときだけ" },
    { do: dismiss, by: "ユーザー", input: "自分で", denied: "要確認か todo のときだけ" },
    { do: reopen, by: "ユーザー", denied: "終わったときだけ" },
    { do: startWork, by: "ユーザー", denied: "要確認か todo のときだけ" },
    { do: finishWork, by: "AI", denied: "AI が作業中のときだけ" },
    { do: stopWork, by: "ユーザー", denied: "AI が作業中のときだけ" },
    { do: triage, by: "ユーザー", input: "要確認", denied: "要確認にするのは同期だけ" },
    { do: triage, by: "AI", input: "todo" },
    { do: triage, by: "AI", input: "todo", denied: "仕分け中のときだけ" },
    { do: move, by: "同期", input: "要確認へ", denied: "ユーザーだけ" },
    { do: startWork, by: "同期", denied: "ユーザーか AI だけ" },
    { do: startWork, by: "AI" },
    { do: finishWork, by: "ユーザー", denied: "AI だけ" },
    { do: finishWork, by: "AI" },
    { do: complete, by: "ユーザー", input: "自分で" },
    { do: reopen, by: "AI", denied: "ユーザーか同期だけ" },
  ],
};

export const reviewed = {
  "indistinguishable-example:dismiss:絞り込みの外,追う項目がなくなった": "どちらも同期が片付ける。理由の違いは表示と記録のためで、振る舞いは変えない",
  "same-for-similar-actors:triage": "Task は誰でも仕分けられる（手で足す・会話を読む・定期の Task から作る）。違いは、要確認にできるのが同期だけという点（シナリオで確かめている）",
  "same-for-similar-actors:startWork": "AI の作業は、ユーザーの依頼（PR を直す・考え直すなど）でも、AI の自動の作業（自動でやる Action Item・依存の更新の調査など）でも始まる",
  "same-for-similar-actors:stopWork": "作業は、ユーザーが確かめて止めることも、追う Source Item が片付いて AI が自分でやめることもある",
  "anyone-can:finishPlan": "計画が全部済むのは、Action Item を済ませた人（ユーザー・同期・AI）の操作の結果。誰が最後を済ませても同じ",
  "same-for-similar-actors:finishPlan": "計画が全部済むのは、最後の Action Item を誰が済ませたかによらない",
};

export const questions = [
  {
    ask: "AI が作業中は、ユーザーも列を移せず、終えられない（先に作業を止める）。作業はそのまま続けて列だけ移せるほうがよいか？",
    about: move,
  },
];
