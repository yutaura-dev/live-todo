import { ensure } from "@yutaura/live-spec";
import type { ActionItem } from "./action-item.spec.ts";
import type { CompletionEffect } from "./completion-effect.spec.ts";
import type { TaskActivity } from "./task-activity.value.ts";
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
  /** Task に起きた出来事（起きた順、足すだけ）。Task の項目を変える操作のたびに、出来事を 1 つ足す。ユーザーに見せる記録で、ほかの集約はこれを読んで反応しない（反応は links で書く） */
  history: TaskActivity[];
  /** ユーザーが最後に Task を見た時刻（まだ一度も見ていなければ null で、新着の印を出す）。更新マーク・新着・最近片付いたものは、保存せず、履歴とこの時刻から導いて見せる（判断表「更新マークと新着」）。見ても、最後に変えた日時は変えない */
  lastSeenAt: string | null;
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
  /** 完了待ち。やり終えたが、完了したときにすることがある。チェックリスト（初めは ☑、個別に外せる）を確かめて完了のボタンを押し、すべて書き込めたら終わる。書き込めなかったものは、ここに残ってやり直せる */
  awaiting: "完了待ち",
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

type Actor = { kind: "user" } | { kind: "sync" } | { kind: "agent" } | { kind: "app" };
type Open = "needs_review" | "todo";

const isOpen = (task: Task) => task.status === "needs_review" || task.status === "todo";


const BY: Record<Actor["kind"], TaskActivity["by"]> = { user: "ユーザー", agent: "AI", sync: "同期", app: "アプリ" };

/** 出来事を 1 つ足す（Task の項目を変える操作は、どれもこれを通す） */
function noted(task: Task, actor: Actor, kind: TaskActivity["kind"], changes: TaskActivity["changes"], detail: string | null = null): Task {
  return { ...task, history: [...task.history, { kind, by: BY[actor.kind], occurredAt: "2026-11-28T00:00:00Z", changes, detail }] };
}

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
  history: [{ kind: "できた", by: "同期", occurredAt: "2026-11-28T00:00:00Z", changes: [], detail: null }],
  lastSeenAt: null,
  createdAt: "2026-11-28T00:00:00Z",
  updatedAt: "2026-11-28T00:00:00Z",
};

export const links = [
  { from: confirmCompletion, to: "completion-effect", action: "fire", label: "☑ が付いている完了したときにすることの書き込みを頼む" },
  { from: dismiss, to: "completion-effect", action: "withdraw", label: "やらないことにしたら、まだ頼んでいない完了したときにすることを取りやめる" },
  { from: detachFact, to: "completion-effect", action: "withdraw", label: "外した事実に書き込む完了したときにすることは、Decisions を通さずに取りやめる（完了待ちでは計画を直せないので、先に外す）" },
  { from: detachFact, to: "task", action: "revisePlan", label: "計画を見直す必要があるかを Decisions で軽く判定し、要るなら AI が計画を直す（外れた事実への、完了したときにすることも）" },
];

export const actors: Record<string, Actor> = {
  アプリ: { kind: "app" },
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
  return noted({ ...task, status: to }, actor, "変わった", [{ field: "列", before: task.status, after: to }]);
}

/** 要確認と todo のあいだで移す */
export function move(task: Task, actor: Actor, to: Open): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  ensure(task.work === "なし", "AI が作業中でないときだけ");
  return noted({ ...task, status: to }, actor, "変わった", [{ field: "列", before: task.status, after: to }]);
}

/**
 * やり終えた
 *
 * 自分で完了にする（いつでもできる）か、完了条件をすべて満たした。完了条件を満たして終えるのは todo の Task だけ。要確認の Task は、自分で確かめるまで終えない。
 */
export function complete(task: Task, actor: Actor, reason: CompleteReason, effects: "完了したときにすることがない" | "完了したときにすることがある"): Task {
  ensure(reason !== "自分で完了にした" || actor.kind === "user", "自分で完了にするのはユーザーだけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  ensure(task.work === "なし", "AI が作業中でないときだけ");
  ensure(reason !== "完了条件を満たした" || (task.status === "todo" && task.completion === "満たした"), "完了条件で終えるのは、todo で完了条件をすべて満たしたときだけ");
  if (effects === "完了したときにすることがある") return noted({ ...task, status: "完了待ち" }, actor, "変わった", [{ field: "列", before: task.status, after: "完了待ち" }]);
  return noted({ ...task, status: "closed", closure: { outcome: "done", reason } }, actor, "変わった", [
    { field: "列", before: task.status, after: "closed" },
    { field: "どう終わったか", before: null, after: reason },
  ]);
}

/** AI が作業をやめた（追う項目が片付いたので Claude Code がやめた など。ADR-0016）。やめた理由を出来事に残す */
export function noteWorkStopped(task: Task, actor: Actor): Task {
  ensure(actor.kind === "agent", "AI だけ");
  return noted(task, actor, "AI が作業をやめた", [], "PR が merge されたので、直す作業をやめた");
}

/** 外への書き込みができなかった（Action Item の書き込み・完了したときにすることの書き込み）。理由を出来事に残す */
export function noteWriteFailed(task: Task, actor: Actor): Task {
  ensure(actor.kind === "app", "アプリだけ");
  return noted(task, actor, "書き込めなかった", [], "権限が足りないので merge できなかった");
}

/** 計画の中の Action Item・完了したときにすることが進んだ（済んだ・やらない・やり直す・書き込んだ など）。だれが進めたかと一緒に出来事に残す */
export function noteProgress(task: Task, actor: Actor, field: "Action Item の進み" | "完了したときにすること"): Task {
  return noted(task, actor, "変わった", [{ field, before: "まだ", after: "済んだ" }]);
}

/**
 * Task を見る（開く）
 *
 * 最後に見た時刻を進める。新着の印と、それまでの更新マークが消える。最後に変えた日時は変えない（Task の中身は変わらないので）。
 */
export function view(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...task, lastSeenAt: "2026-11-28T00:00:00Z" };
}

/**
 * 完了待ちのチェックリストを確かめて、完了のボタンを押す
 *
 * ☑ が付いている完了したときにすることの書き込みを頼む（ボタンを押したことが承認）。すべて書き込めた（または外した）ら終わる。
 */
export function confirmCompletion(task: Task, actor: Actor, list: "見せたとおり" | "変わった"): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.status === "完了待ち", "完了待ちのときだけ");
  ensure(list === "見せたとおり", "見せたチェックリストが今も同じときだけ（見せたあとに足された・取りやめたものがあれば、見せ直す）");
  return { ...task };
}

/** 完了したときにすることが、すべて書き込めた・外されたので、終わる（完了待ちに入ったときの理由のまま終える） */
export function finishCompletion(task: Task, actor: Actor, effects: "すべて済んだ" | "まだ・書き込めなかったものがある", reason: CompleteReason): Task {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(task.status === "完了待ち", "完了待ちのときだけ");
  ensure(effects === "すべて済んだ", "完了したときにすることが、すべて書き込めた・外されたときだけ");
  return noted({ ...task, status: "closed", closure: { outcome: "done", reason } }, actor, "変わった", [
    { field: "列", before: "完了待ち", after: "closed" },
    { field: "どう終わったか", before: null, after: reason },
  ]);
}

/** やらないことにする（完了待ちからもできる。まだ頼んでいない・書き込めなかった完了したときにすることは取りやめる） */
export function dismiss(task: Task, actor: Actor, reason: DismissReason, inFlight: "頼んだものはない" | "頼んだものがある"): Task {
  ensure(reason === "自分で片付けた" ? actor.kind === "user" : reason === "絞り込みの外になった" ? actor.kind === "sync" : actor.kind === "agent", "自分で片付けるのはユーザー、絞り込みの外は同期、もう要らないと判定するのは AI だけ");
  ensure(isOpen(task) || task.status === "完了待ち", "要確認・todo・完了待ちのときだけ");
  ensure(inFlight === "頼んだものはない", "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）");
  ensure(task.work === "なし", "AI が作業中でないときだけ");
  return noted({ ...task, status: "closed", closure: { outcome: "dismissed", reason } }, actor, "変わった", [
    { field: "列", before: task.status, after: "closed" },
    { field: "どう終わったか", before: null, after: reason },
  ]);
}

/**
 * やり直す
 *
 * 終わった・完了待ちの Task を todo に戻す。ユーザーはいつでも戻せる。AI は、事実の変化から「やり終えたが、まだ終わっていなかった」（PR がまた開いた など）と判定したときだけ戻す。自分で片付けた Task は、AI では戻らない。
 */
export function reopen(task: Task, actor: Actor, inFlight: "頼んだものはない" | "頼んだものがある"): Task {
  ensure(actor.kind === "user" || actor.kind === "agent", "ユーザーか AI だけ");
  ensure(task.status === "closed" || task.status === "完了待ち", "終わった・完了待ちのときだけ");
  ensure(inFlight === "頼んだものはない", "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）");
  ensure(actor.kind !== "agent" || task.closure?.reason !== "自分で片付けた", "自分で片付けた Task は、AI では戻らない");
  return noted({ ...task, status: "todo", closure: null, completion: task.completion === "満たした" ? "まだ" : task.completion }, actor, "変わった", [
    { field: "列", before: task.status, after: "todo" },
  ]);
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
  return noted({ ...task, completion: "まだ" }, actor, "変わった", [{ field: "計画", before: null, after: "新しい計画" }]);
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
  return noted({ ...task, completion: "まだ" }, actor, "変わった", [{ field: "完了条件", before: "未定", after: "まだ" }]);
}

/**
 * 完了条件が未定になる
 *
 * 分かれ道で「選んでから考える」選択肢を選んだ（AI が先の計画を考えるまで、完了条件が分からない）。
 */
export function makeUndetermined(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(isOpen(task), "要確認か todo のときだけ");
  return noted({ ...task, completion: "未定" }, actor, "変わった", [{ field: "完了条件", before: task.completion, after: "未定" }]);
}

/**
 * まだの完了条件ができる
 *
 * 分かれ道で、先の計画が決まっている選択肢を選んで差し込んだ・完了条件の Action Item を戻した。
 */
export function addPendingCriteria(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(task.completion !== "未定", "完了条件が決まっているときだけ");
  return noted({ ...task, completion: "まだ" }, actor, "変わった", [{ field: "完了条件", before: task.completion, after: "まだ" }]);
}

/** 完了条件をすべて満たす（最後の完了条件の Action Item が果たされた） */
export function satisfyCompletion(task: Task, _actor: Actor): Task {
  ensure(task.completion === "まだ", "完了条件が決まっていて、まだのときだけ");
  return noted({ ...task, completion: "満たした" }, _actor, "変わった", [{ field: "完了条件", before: "まだ", after: "満たした" }]);
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
  return noted({ ...task }, actor, "変わった", [{ field: "今の状況と次の一手", before: "レビュー待ち", after: "PR が merge された。確かめて閉じる" }]);
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

/** 事実を外す（ユーザーが外した・別の Task に移した・対象外にした）。外したら、計画を見直す必要があるかを Decisions で軽く判定し、要るなら AI が計画を直す（完了したときにすることも） */
export function detachFact(task: Task, actor: Actor): Task {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...task };
}

export const inputs = {
  triage: { todo: ["todo"], 要確認: ["needs_review"] },
  move: { 要確認へ: ["needs_review"], todoへ: ["todo"] },
  complete: {
    自分で: ["自分で完了にした", "完了したときにすることがない"],
    完了条件を満たした: ["完了条件を満たした", "完了したときにすることがない"],
    完了したときにすることがある: ["完了条件を満たした", "完了したときにすることがある"],
    自分で完了にした・完了したときにすることがある: ["自分で完了にした", "完了したときにすることがある"],
  },
  noteProgress: { "Action Item": ["Action Item の進み"], 完了したときにすること: ["完了したときにすること"] },
  finishCompletion: { 済んだ: ["すべて済んだ", "完了条件を満たした"], 自分で完了にして済んだ: ["すべて済んだ", "自分で完了にした"], まだ: ["まだ・書き込めなかったものがある", "完了条件を満たした"] },
  reopen: { 頼んだものはない: ["頼んだものはない"], 頼んだものがある: ["頼んだものがある"] },
  confirmCompletion: { 見せたとおり: ["見せたとおり"], 変わった: ["変わった"] },
  dismiss: {
    自分で: ["自分で片付けた", "頼んだものはない"],
    絞り込みの外: ["絞り込みの外になった", "頼んだものはない"],
    もう要らない: ["もう要らなくなった", "頼んだものはない"],
    頼んだものがある: ["自分で片付けた", "頼んだものがある"],
  },
};

export const invariants = {
  "終わり方を持つのは、終わった Task だけ": (task: Task) => (task.status === "closed") === (task.closure !== null),
  "終わった Task では、AI は作業していない": (task: Task) => task.status !== "closed" || task.work === "なし",
  "仕分けたあとは、仕分け中に戻らない": (before: Task, after: Task) => before.status === "triaging" || after.status !== "triaging",
  "AI の作業を始めても終えても、列は変わらない": (before: Task, after: Task) => before.work === after.work || before.status === after.status,
};

/** 更新マークと新着（保存せず、履歴と最後に見た時刻から導いて見せる） */
function mark(input: {
  最後に見た時刻: "ある" | "ない";
  "最後に見たあとの、項目ごとの最後の変化": "ユーザー以外が変えた項目がある" | "どの項目もユーザーが最後に変えた" | "変化がない";
  "最後に見たあとの、項目を持たない出来事（AI が作業をやめた・書き込めなかった）": "ある" | "ない";
}): "新着" | "更新マーク" | "なし" {
  if (input.最後に見た時刻 === "ない") return "新着";
  if (input["最後に見たあとの、項目を持たない出来事（AI が作業をやめた・書き込めなかった）"] === "ある") return "更新マーク";
  return input["最後に見たあとの、項目ごとの最後の変化"] === "ユーザー以外が変えた項目がある" ? "更新マーク" : "なし";
}

export const decisions = {
  "更新マークと新着": {
    decide: mark,
    cases: [
      { input: { 最後に見た時刻: "ない", "最後に見たあとの、項目ごとの最後の変化": "ユーザー以外が変えた項目がある", "最後に見たあとの、項目を持たない出来事（AI が作業をやめた・書き込めなかった）": "ある" }, expect: "新着" },
      { input: { 最後に見た時刻: "ある", "最後に見たあとの、項目ごとの最後の変化": "ユーザー以外が変えた項目がある", "最後に見たあとの、項目を持たない出来事（AI が作業をやめた・書き込めなかった）": "ない" }, expect: "更新マーク" },
      { input: { 最後に見た時刻: "ある", "最後に見たあとの、項目ごとの最後の変化": "どの項目もユーザーが最後に変えた", "最後に見たあとの、項目を持たない出来事（AI が作業をやめた・書き込めなかった）": "ない" }, expect: "なし" },
      { input: { 最後に見た時刻: "ある", "最後に見たあとの、項目ごとの最後の変化": "変化がない", "最後に見たあとの、項目を持たない出来事（AI が作業をやめた・書き込めなかった）": "ある" }, expect: "更新マーク" },
      { input: { 最後に見た時刻: "ある", "最後に見たあとの、項目ごとの最後の変化": "変化がない", "最後に見たあとの、項目を持たない出来事（AI が作業をやめた・書き込めなかった）": "ない" }, expect: "なし" },
    ],
  },
};

export const scenarios = {
  "AI が作業をやめた・書き込めなかったことを、出来事に残す（残すのは決まった人だけ）": [
    { do: triage, by: "同期", input: "todo" },
    { do: noteWorkStopped, by: "アプリ", denied: "AI だけ" },
    { do: noteWorkStopped, by: "AI" },
    { do: noteWriteFailed, by: "ユーザー", denied: "アプリだけ" },
    { do: noteWriteFailed, by: "AI", denied: "アプリだけ" },
    { do: noteWriteFailed, by: "アプリ" },
    { do: noteProgress, by: "同期", input: "Action Item" },
  ],
  "Task を見たら、新着と更新マークが消える（見るのはユーザーだけ）": [
    { do: triage, by: "同期", input: "todo", expect: { lastSeenAt: null } },
    { do: view, by: "AI", denied: "ユーザーだけ" },
    { do: view, by: "アプリ", denied: "ユーザーだけ" },
    { do: view, by: "ユーザー", expect: { lastSeenAt: "2026-11-28T00:00:00Z" } },
  ],
  "完了したときにすることがあれば、完了待ちでチェックリストを確かめてから終わる": [
    { do: triage, by: "同期", input: "todo" },
    { do: startWork, by: "AI" },
    { do: revisePlan, by: "AI" },
    { do: finishWork, by: "AI" },
    { do: satisfyCompletion, by: "同期" },
    { do: complete, by: "AI", input: "完了したときにすることがある", expect: { status: "完了待ち", closure: null } },
    { do: confirmCompletion, by: "AI", input: "見せたとおり", denied: "ユーザーだけ" },
    { do: confirmCompletion, by: "ユーザー", input: "変わった", denied: "見せたチェックリストが今も同じときだけ（見せたあとに足された・取りやめたものがあれば、見せ直す）" },
    { do: confirmCompletion, by: "ユーザー", input: "見せたとおり", expect: { status: "完了待ち" } },
    { do: reopen, by: "ユーザー", input: "頼んだものがある", denied: "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）" },
    { do: finishCompletion, by: "ユーザー", input: "済んだ", denied: "アプリだけ" },
    { do: finishCompletion, by: "アプリ", input: "まだ", denied: "完了したときにすることが、すべて書き込めた・外されたときだけ" },
    { do: finishCompletion, by: "アプリ", input: "済んだ", expect: { status: "closed", closure: { outcome: "done", reason: "完了条件を満たした" } } },
    { do: confirmCompletion, by: "ユーザー", input: "見せたとおり", denied: "完了待ちのときだけ" },
  ],
  "完了待ちから、やらないことにする": [
    { do: triage, by: "ユーザー", input: "todo" },
    { do: complete, by: "ユーザー", input: "自分で完了にした・完了したときにすることがある" },
    { do: dismiss, by: "ユーザー", input: "頼んだものがある", denied: "書き込みを頼んで結果を待っている完了したときにすることがないときだけ（宙に浮かないように）" },
    { do: dismiss, by: "ユーザー", input: "自分で", expect: { status: "closed", closure: { outcome: "dismissed" } } },
  ],
  "完了待ちから、やり直す": [
    { do: triage, by: "ユーザー", input: "todo" },
    { do: defineCompletionByHand, by: "ユーザー" },
    { do: complete, by: "ユーザー", input: "自分で完了にした・完了したときにすることがある", expect: { status: "完了待ち" } },
    { do: reopen, by: "ユーザー", input: "頼んだものはない", expect: { status: "todo" } },
  ],
  "自分で完了にしたときも、完了待ちを経て、自分で完了にしたとして終わる": [
    { do: triage, by: "ユーザー", input: "todo" },
    { do: complete, by: "ユーザー", input: "自分で完了にした・完了したときにすることがある" },
    { do: confirmCompletion, by: "ユーザー", input: "見せたとおり" },
    { do: finishCompletion, by: "アプリ", input: "自分で完了にして済んだ", expect: { closure: { reason: "自分で完了にした" } } },
  ],
  "完了条件を満たして、todo の Task はやり終え、事実の変化でやり直す": [
    { do: triage, by: "同期", input: "todo", expect: { status: "todo", completion: "未定" } },
    { do: complete, by: "AI", input: "完了条件を満たした", denied: "完了条件で終えるのは、todo で完了条件をすべて満たしたときだけ" },
    { do: startWork, by: "AI" },
    { do: revisePlan, by: "AI", expect: { completion: "まだ" } },
    { do: finishWork, by: "AI" },
    { do: satisfyCompletion, by: "同期", expect: { completion: "満たした" } },
    { do: satisfyCompletion, by: "同期", denied: "完了条件が決まっていて、まだのときだけ" },
    { do: complete, by: "AI", input: "完了条件を満たした", expect: { status: "closed", closure: { outcome: "done", reason: "完了条件を満たした" } } },
    { do: reopen, by: "同期", input: "頼んだものはない", denied: "ユーザーか AI だけ" },
    { do: reopen, by: "AI", input: "頼んだものはない", expect: { status: "todo", completion: "まだ" } },
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
    { do: reopen, by: "AI", input: "頼んだものはない", denied: "自分で片付けた Task は、AI では戻らない" },
    { do: reopen, by: "ユーザー", input: "頼んだものはない", expect: { status: "todo" } },
    { do: dismiss, by: "AI", input: "もう要らない", expect: { status: "closed" } },
    { do: reopen, by: "AI", input: "頼んだものはない", expect: { status: "todo" } },
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
    { do: dismiss, by: "ユーザー", input: "自分で", denied: "要確認・todo・完了待ちのときだけ" },
    { do: reopen, by: "ユーザー", input: "頼んだものはない", denied: "終わった・完了待ちのときだけ" },
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
  "anyone-can:noteProgress": "計画の中の Action Item・完了したときにすることが進んだことは、だれが進めても（ユーザー・AI・同期・アプリ）出来事として残す。だれが進めたかは出来事の by に残り、ユーザーが進めたものは更新マークにしない",
  "anytime:noteProgress": "計画の中の Action Item・完了したときにすることが進んだことは、だれが進めても（ユーザー・AI・同期・アプリ）出来事として残す。だれが進めたかは出来事の by に残り、ユーザーが進めたものは更新マークにしない",
  "ignores-input:noteProgress": "Action Item の進みか、完了したときにすることかは、出来事のどの項目かが違うだけで、Task の振る舞いは変えない",
  "same-for-similar-actors:noteProgress": "計画の中の Action Item・完了したときにすることが進んだことは、だれが進めても（ユーザー・AI・同期・アプリ）出来事として残す。だれが進めたかは出来事の by に残り、ユーザーが進めたものは更新マークにしない",
  "anytime:noteWorkStopped": "AI が作業をやめたことは、Task のどの列のときでも起きうる出来事として残す（列は変えない）",
  "anytime:noteWriteFailed": "書き込めなかったことは、Task のどの列のときでも起きうる出来事として残す（列は変えない）",
  "anytime:view": "Task は、どの列でもユーザーが見られる（終わった Task も、最近片付いたものから見る）",
  "anyone-can:attachFact": "事実を持たせるのは、振り分けた人（同期・AI・ユーザー）の決定の結果。誰が決めても、Task は同じように持つ",
  "same-for-similar-actors:attachFact": "事実を持たせるのは、誰が振り分けたかによらない",
  "anytime:detachFact": "ユーザーは、いつでも Task から事実を外せる（終わった Task でも、記録を直すために外せる）",
  "same-for-similar-actors:complete": "完了条件を満たして終えるのは、最後の完了条件を果たしたのが同期（条件を見張る Watcher・承認した書き込み）でも AI でも同じ。自分で完了にできるのはユーザーだけ（シナリオで確かめている）",
  "equivalent-states:closed · { reason: 自分で完了にした } · なし · 未定/closed · { reason: 絞り込みの外になった } · なし · 未定/closed · { reason: もう要らなくなった } · なし · 未定/closed · { reason: 完了条件を満たした } · なし · 未定": "終わり方の理由は、表示と記録のためで、終わった Task でできることは変わらない（AI が戻せないのは、自分で片付けた Task だけで、ここに挙がった状態には含まれない）",
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
