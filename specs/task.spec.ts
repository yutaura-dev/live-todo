import { ensure } from "@yutaura/live-spec";
import type { ActionItem } from "./action-item.spec.ts";
import type { CompletionEffect } from "./completion-effect.spec.ts";
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
  /** 完了条件。計画の中の、完了条件の印が付いた Action Item から決まる */
  completion: Completion;
  /** Task を見分ける ID */
  id: string;
  /** 何をするか（Source の言葉ではなく、自分にとっての意味で） */
  title: string;
  /** 今の状況と次の一手 */
  brief: string | null;
  /** 次にやることの計画 */
  plan: Plan | null;
  /** この Task についての事実（Source Item）。事実とのつながりの持ち主は Task（振り分けが決めて、Task に持たせる）。1 つの事実を、いくつの Task が持ってもよい。事実が変わっても Task は直接は動かず、変化を受け取って Task の言葉に置き換える */
  sourceItemIds: string[];
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
  /** 並べる Action Item・入れ子の並び・分かれ道で差し込んだ枝・完了したときにすること */
  items: Array<ActionItem | Plan | Branch | CompletionEffect>;
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

export const Completion = {
  /** 完了条件がまだ決まっていない（計画を立てる前・選んでから考える選択肢の先がまだ・まだ選んでいない分かれ道に、先が決まっていない選択肢がある） */
  undetermined: "未定",
  /** 完了条件が決まっていて、まだ満たしていない */
  pending: "まだ",
  /** 完了条件をすべて満たした（選んだ分かれ道は選んだ枝の、まだ選んでいない分かれ道はすべての枝の完了条件を満たした） */
  satisfied: "満たした",
} as const;
export type Completion = (typeof Completion)[keyof typeof Completion];

/** どう終わったか */
export type Closure =
  /** やり終えた。完了の列に出る */
  | { outcome: "done"; reason: CompleteReason }
  /** やらないことにした。ボードには出ない */
  | { outcome: "dismissed"; reason: DismissReason };

export const CompleteReason = {
  /** 自分で完了にした */
  byUser: "自分で完了にした",
  /** 完了条件をすべて満たした */
  criteriaMet: "完了条件を満たした",
} as const;
export type CompleteReason = (typeof CompleteReason)[keyof typeof CompleteReason];

export const DismissReason = {
  /** 自分で片付けた（削除も含む） */
  byUser: "自分で片付けた",
  /** 絞り込みの外になった */
  filteredOut: "絞り込みの外になった",
  /** 事実の変化から、もう要らなくなったと判定した（PR が merge されずに閉じた・元の項目がなくなった など） */
  noLongerNeeded: "もう要らなくなった",
} as const;
export type DismissReason = (typeof DismissReason)[keyof typeof DismissReason];

type Actor = { kind: "user" } | { kind: "sync" } | { kind: "agent" };
type Open = "needs_review" | "todo";

const isOpen = (task: Task) => task.status === "needs_review" || task.status === "todo";

export const initial: Task = {
  status: "triaging",
  closure: null,
  work: "なし",
  completion: "未定",
  id: "t1",
  title: "依存更新の PR を確かめて merge する",
  brief: null,
  plan: null,
  sourceItemIds: [],
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
 * 自分で完了にする（いつでもできる）か、完了条件をすべて満たした。完了条件を満たして終えるのは todo の Task だけ。要確認の Task は、自分で確かめるまで終えない。
 */
export function complete(task: Task, actor: Actor, reason: CompleteReason): Task {
  ensure(reason !== "自分で完了にした" || actor.kind === "user", "自分で完了にするのはユーザーだけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  ensure(task.work === "なし", "AI が作業中でないときだけ");
  ensure(reason !== "完了条件を満たした" || (task.status === "todo" && task.completion === "満たした"), "完了条件で終えるのは、todo で完了条件をすべて満たしたときだけ");
  return { ...task, status: "closed", closure: { outcome: "done", reason } };
}

/** やらないことにする */
export function dismiss(task: Task, actor: Actor, reason: DismissReason): Task {
  ensure(reason === "自分で片付けた" ? actor.kind === "user" : reason === "絞り込みの外になった" ? actor.kind === "sync" : actor.kind === "agent", "自分で片付けるのはユーザー、絞り込みの外は同期、もう要らないと判定するのは AI だけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  ensure(task.work === "なし", "AI が作業中でないときだけ");
  return { ...task, status: "closed", closure: { outcome: "dismissed", reason } };
}

/**
 * やり直す
 *
 * 終わった Task を todo に戻す。ユーザーはいつでも戻せる。AI は、事実の変化から「やり終えたが、まだ終わっていなかった」（PR がまた開いた など）と判定したときだけ戻す。自分で片付けた Task は、AI では戻らない。
 */
export function reopen(task: Task, actor: Actor): Task {
  ensure(actor.kind !== "sync", "ユーザーか AI だけ");
  ensure(task.status === "closed", "終わったときだけ");
  ensure(actor.kind !== "agent" || task.closure?.reason !== "自分で片付けた", "自分で片付けた Task は、AI では戻らない");
  return { ...task, status: "todo", closure: null, completion: task.completion === "満たした" ? "まだ" : task.completion };
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
 * 計画を立てる・立て直す
 *
 * AI が、済んだ Action Item は残して、残りの計画を作り直す。完了条件を必ず 1 つ以上付ける。確かめられる完了条件が見つからなければ、「やり終えたと自分で確かめる」（人が果たす完了条件）を置く。
 */
export function revisePlan(task: Task, actor: Actor): Task {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(task.work === "作業中", "AI が作業中のときだけ");
  return { ...task, completion: "まだ" };
}

/**
 * 手で足した Task に、完了条件を置く
 *
 * 計画がなくても、「やり終えたと自分で確かめる」（人が果たす完了条件）を持つ。
 */
export function defineCompletionByHand(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  ensure(task.completion === "未定", "完了条件が決まっていないときだけ");
  return { ...task, completion: "まだ" };
}

/**
 * 完了条件が未定になる
 *
 * 分かれ道で「選んでから考える」選択肢を選んだ（AI が先の計画を考えるまで、完了条件が分からない）。
 */
export function makeUndetermined(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  return { ...task, completion: "未定" };
}

/**
 * まだの完了条件ができる
 *
 * 分かれ道で、先の計画が決まっている選択肢を選んで差し込んだ・完了条件の Action Item を戻した。
 */
export function addPendingCriteria(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.completion !== "未定", "完了条件が決まっているときだけ");
  return { ...task, completion: "まだ" };
}

/** 完了条件をすべて満たす（最後の完了条件の Action Item が果たされた） */
export function satisfyCompletion(task: Task, _actor: Actor): Task {
  ensure(task.completion === "まだ", "完了条件が決まっていて、まだのときだけ");
  return { ...task, completion: "満たした" };
}

/**
 * 事実の変化を受け取る
 *
 * この Task についての事実（Source Item）が増えた・変わった。Decisions（確率付きの判定）が、事実の変化で果たされた Action Item があるか、Task がもう要らなくなったか、終えた Task がまだ終わっていなかったかを判定し、確率が閾値に届いたものだけを反映する（届かなければ何もしない）。
 * Watcher が見張れる完了条件（merge された など）は、判定に任せず、条件で果たされる Action Item として確かめる。
 */
export function receiveFact(task: Task, actor: Actor): Task {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(task.status !== "triaging", "仕分けたあとだけ");
  return { ...task };
}

/**
 * 事実を持つ
 *
 * 振り分けが、この Task の事実にすると決めた（自動・同期の識別子・ユーザーの手）。終わった Task には持たせない（振り分けの候補は、開いている Task だけ）。
 */
export function attachFact(task: Task, _actor: Actor): Task {
  ensure(task.status !== "closed", "終わっていないときだけ");
  return { ...task };
}

/** 事実を外す（ユーザーが外した・別の Task に移した・対象外にした） */
export function detachFact(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...task };
}

export const inputs = {
  triage: { todo: ["todo"], 要確認: ["needs_review"] },
  move: { 要確認へ: ["needs_review"], todoへ: ["todo"] },
  complete: { 自分で: ["自分で完了にした"], 完了条件を満たした: ["完了条件を満たした"] },
  dismiss: { 自分で: ["自分で片付けた"], 絞り込みの外: ["絞り込みの外になった"], もう要らない: ["もう要らなくなった"] },
};

export const invariants = {
  "終わり方を持つのは、終わった Task だけ": (task: Task) => (task.status === "closed") === (task.closure !== null),
  "終わった Task では、AI は作業していない": (task: Task) => task.status !== "closed" || task.work === "なし",
  "仕分けたあとは、仕分け中に戻らない": (before: Task, after: Task) => before.status === "triaging" || after.status !== "triaging",
  "AI の作業を始めても終えても、列は変わらない": (before: Task, after: Task) => before.work === after.work || before.status === after.status,
};

export const scenarios = {
  "完了条件を満たして、todo の Task はやり終え、事実の変化でやり直す": [
    { do: triage, by: "同期", input: "todo", expect: { status: "todo", completion: "未定" } },
    { do: complete, by: "AI", input: "完了条件を満たした", denied: "完了条件で終えるのは、todo で完了条件をすべて満たしたときだけ" },
    { do: startWork, by: "AI" },
    { do: revisePlan, by: "AI", expect: { completion: "まだ" } },
    { do: finishWork, by: "AI" },
    { do: satisfyCompletion, by: "同期", expect: { completion: "満たした" } },
    { do: satisfyCompletion, by: "同期", denied: "完了条件が決まっていて、まだのときだけ" },
    { do: complete, by: "AI", input: "完了条件を満たした", expect: { status: "closed", closure: { outcome: "done", reason: "完了条件を満たした" } } },
    { do: reopen, by: "同期", denied: "ユーザーか AI だけ" },
    { do: reopen, by: "AI", expect: { status: "todo", completion: "まだ" } },
  ],
  "選んでから考える選択肢を選ぶと、完了条件が決まるまで自動では終わらない": [
    { do: triage, by: "ユーザー", input: "todo" },
    { do: defineCompletionByHand, by: "ユーザー", expect: { completion: "まだ" } },
    { do: defineCompletionByHand, by: "ユーザー", denied: "完了条件が決まっていないときだけ" },
    { do: makeUndetermined, by: "ユーザー", expect: { completion: "未定" } },
    { do: satisfyCompletion, by: "AI", denied: "完了条件が決まっていて、まだのときだけ" },
    { do: addPendingCriteria, by: "ユーザー", denied: "完了条件が決まっているときだけ" },
    { do: startWork, by: "ユーザー" },
    { do: revisePlan, by: "AI", expect: { completion: "まだ" } },
    { do: finishWork, by: "AI" },
    { do: satisfyCompletion, by: "ユーザー" },
    { do: addPendingCriteria, by: "ユーザー", expect: { completion: "まだ" } },
    { do: complete, by: "ユーザー", input: "自分で", expect: { status: "closed" } },
  ],
  "要確認の Task は、完了条件を満たしても、自分で確かめるまで終えない": [
    { do: triage, by: "同期", input: "要確認" },
    { do: startWork, by: "AI" },
    { do: revisePlan, by: "AI" },
    { do: finishWork, by: "AI" },
    { do: satisfyCompletion, by: "同期" },
    { do: complete, by: "AI", input: "完了条件を満たした", denied: "完了条件で終えるのは、todo で完了条件をすべて満たしたときだけ" },
    { do: complete, by: "AI", input: "自分で", denied: "自分で完了にするのはユーザーだけ" },
    { do: complete, by: "ユーザー", input: "自分で", expect: { status: "closed" } },
  ],
  "やらないことにした Task は、AI では戻らない": [
    { do: triage, by: "同期", input: "要確認" },
    { do: dismiss, by: "ユーザー", input: "自分で", expect: { status: "closed", closure: { outcome: "dismissed", reason: "自分で片付けた" } } },
    { do: reopen, by: "AI", denied: "自分で片付けた Task は、AI では戻らない" },
    { do: reopen, by: "ユーザー", expect: { status: "todo" } },
    { do: dismiss, by: "AI", input: "もう要らない", expect: { status: "closed" } },
    { do: reopen, by: "AI", expect: { status: "todo" } },
  ],
  "AI が作業中は、列を動かさず、終えもしない": [
    { do: triage, by: "同期", input: "要確認" },
    { do: receiveFact, by: "AI" },
    { do: startWork, by: "ユーザー", expect: { work: "作業中", status: "needs_review" } },
    { do: move, by: "ユーザー", input: "todoへ", denied: "AI が作業中でないときだけ" },
    { do: dismiss, by: "同期", input: "絞り込みの外", denied: "AI が作業中でないときだけ" },
    { do: stopWork, by: "同期", denied: "ユーザーか AI だけ" },
    { do: stopWork, by: "ユーザー", expect: { work: "なし" } },
    { do: dismiss, by: "同期", input: "絞り込みの外", expect: { status: "closed" } },
  ],
  "誰が終えられるかは、終わり方の理由で決まる": [
    { do: triage, by: "同期", input: "要確認" },
    { do: dismiss, by: "ユーザー", input: "絞り込みの外", denied: "自分で片付けるのはユーザー、絞り込みの外は同期、もう要らないと判定するのは AI だけ" },
    { do: dismiss, by: "同期", input: "もう要らない", denied: "自分で片付けるのはユーザー、絞り込みの外は同期、もう要らないと判定するのは AI だけ" },
  ],
  "終わった Task には、事実を持たせない": [
    { do: triage, by: "同期", input: "todo" },
    { do: attachFact, by: "AI" },
    { do: detachFact, by: "AI", denied: "ユーザーだけ" },
    { do: detachFact, by: "ユーザー" },
    { do: complete, by: "ユーザー", input: "自分で" },
    { do: attachFact, by: "同期", denied: "終わっていないときだけ" },
  ],
  "操作はそれぞれ決まった人だけが起こし、仕分け中は仕分けしかできない": [
    { do: move, by: "ユーザー", input: "todoへ", denied: "要確認か todo のときだけ" },
    { do: complete, by: "ユーザー", input: "自分で", denied: "要確認か todo のときだけ" },
    { do: dismiss, by: "ユーザー", input: "自分で", denied: "要確認か todo のときだけ" },
    { do: reopen, by: "ユーザー", denied: "終わったときだけ" },
    { do: startWork, by: "ユーザー", denied: "要確認か todo のときだけ" },
    { do: finishWork, by: "AI", denied: "AI が作業中のときだけ" },
    { do: stopWork, by: "ユーザー", denied: "AI が作業中のときだけ" },
    { do: receiveFact, by: "AI", denied: "仕分けたあとだけ" },
    { do: defineCompletionByHand, by: "ユーザー", denied: "要確認か todo のときだけ" },
    { do: makeUndetermined, by: "ユーザー", denied: "要確認か todo のときだけ" },
    { do: triage, by: "ユーザー", input: "要確認", denied: "要確認にするのは同期だけ" },
    { do: triage, by: "AI", input: "todo" },
    { do: triage, by: "AI", input: "todo", denied: "仕分け中のときだけ" },
    { do: receiveFact, by: "同期", denied: "AI だけ" },
    { do: move, by: "同期", input: "要確認へ", denied: "ユーザーだけ" },
    { do: defineCompletionByHand, by: "AI", denied: "ユーザーだけ" },
    { do: makeUndetermined, by: "AI", denied: "ユーザーだけ" },
    { do: revisePlan, by: "AI", denied: "AI が作業中のときだけ" },
    { do: startWork, by: "同期", denied: "ユーザーか AI だけ" },
    { do: startWork, by: "AI" },
    { do: revisePlan, by: "ユーザー", denied: "AI だけ" },
    { do: finishWork, by: "ユーザー", denied: "AI だけ" },
    { do: finishWork, by: "AI" },
    { do: addPendingCriteria, by: "同期", denied: "ユーザーだけ" },
    { do: complete, by: "ユーザー", input: "自分で" },
  ],
};

export const reviewed = {
  "anyone-can:attachFact": "事実を持たせるのは、振り分けた人（同期・AI・ユーザー）の決定の結果。誰が決めても、Task は同じように持つ",
  "same-for-similar-actors:attachFact": "事実を持たせるのは、誰が振り分けたかによらない",
  "anytime:detachFact": "ユーザーは、いつでも Task から事実を外せる（終わった Task でも、記録を直すために外せる）",
  "same-for-similar-actors:complete": "完了条件を満たして終えるのは、最後の完了条件を果たしたのが同期（条件を見張る Watcher・承認した書き込み）でも AI でも同じ。自分で完了にできるのはユーザーだけ（シナリオで確かめている）",
  "equivalent-states:closed · { reason: 自分で完了にした } · なし · 未定/closed · { reason: 絞り込みの外になった } · なし · 未定/closed · { reason: もう要らなくなった } · なし · 未定": "終わり方の理由は、表示と記録のためで、終わった Task でできることは変わらない（AI が戻せないのは、自分で片付けた Task だけで、ここに挙がった状態には含まれない）",
  "equivalent-states:closed · { reason: 自分で完了にした } · なし · まだ/closed · { reason: 絞り込みの外になった } · なし · まだ/closed · { reason: もう要らなくなった } · なし · まだ/closed · { reason: 完了条件を満たした } · なし · まだ": "終わり方の理由は、表示と記録のためで、終わった Task でできることは変わらない（AI が戻せないのは、自分で片付けた Task だけで、ここに挙がった状態には含まれない）",
  "equivalent-states:closed · { reason: 自分で完了にした } · なし · 満たした/closed · { reason: 絞り込みの外になった } · なし · 満たした/closed · { reason: もう要らなくなった } · なし · 満たした/closed · { reason: 完了条件を満たした } · なし · 満たした": "終わり方の理由は、表示と記録のためで、終わった Task でできることは変わらない（AI が戻せないのは、自分で片付けた Task だけで、ここに挙がった状態には含まれない）",
  "same-for-similar-actors:triage": "Task は誰でも仕分けられる（手で足す・会話を読む・定期の Task から作る）。違いは、要確認にできるのが同期だけという点（シナリオで確かめている）",
  "same-for-similar-actors:startWork": "AI の作業は、ユーザーの依頼（PR を直す・考え直すなど）でも、AI の自動の作業（自動でやる Action Item・依存の更新の調査など）でも始まる",
  "same-for-similar-actors:stopWork": "作業は、ユーザーが確かめて止めることも、追う Source Item が片付いて AI が自分でやめることもある",
  "anyone-can:satisfyCompletion": "完了条件を満たすのは、最後の完了条件の Action Item を果たした人（ユーザー・同期・AI）の操作の結果。誰が果たしても同じ",
  "same-for-similar-actors:satisfyCompletion": "完了条件を満たすのは、最後の完了条件を誰が果たしたかによらない",
};

export const questions = [
  {
    ask: "AI が作業中は、ユーザーも列を移せず、終えられない（先に作業を止める）。作業はそのまま続けて列だけ移せるほうがよいか？",
    about: move,
  },
];
