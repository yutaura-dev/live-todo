import { ensure } from "@yutaura/live-spec";
import type { Plan } from "./task.spec.ts";

/**
 * Task の提案（AI が「こうするとよいと思う」とユーザーに差し出すもの）。提案は Task ではないので、Task の数を増やさない。
 * 届いた事実から、新しい Task を作るか・既存の Task の計画に足すかを AI が決めきれなかったとき（確率が中間）と、
 * 完了条件を満たした Task に、事実から計画に足した項目がまだ残っていて、自動で閉じるのを止めたときにできる（ADR-0025）。
 * 提案には、関係する事実が届くたびに足されていく。確信が上がれば、AI が自動で受け入れる（ユーザーを待たない）。
 * 見送った提案の事実が、あとで行動を求めるように変われば、もう一度提案する。
 * 見送った提案は、期限を置かずに、もとの事実が開いている間は残す（もう一度提案するかは、同期がもともと見張っている事実の変化で決まるので、残しても手間はかからない。消すと「見送った」という判断ごと消え、同じ件の提案がまた出てしまう）。事実が片付いたら取り下げる。画面では、見送ったものは閉じた一覧に入れて目に入らないようにする。
 */
export type TaskProposal = {
  /** 提案の段階 */
  status: ProposalStatus;
  /** 何の提案か（作ったときに決まる） */
  kind: ProposalKind;
  /** 提案を見分ける ID */
  id: string;
  /** 作る Task の題（何をするか）。既存の Task に足す提案なら、足す Action Item の題 */
  title: string;
  /** 今の状況と、なぜ提案するか（Generation が書く。Decisions は理由を返さないので） */
  brief: string;
  /** 作る Task の計画の案（足す提案・切り出す提案なら、足す・切り出す Action Item の並び） */
  plan: Plan | null;
  /** 寄せ先の Task（既存の Task に足す・既存の Task から切り出す提案のとき。新しい Task の提案なら null） @ref task */
  targetTaskId: string | null;
  /** 提案のもとになった事実（足されていく） */
  sourceItemIds: string[];
  /** 判定の記録（問いの版・確率）。理由を返さない Decisions の判定を、あとから追えるように残す */
  judgment: string;
  createdAt: string;
};

export const ProposalStatus = {
  /** ユーザーが決めるのを待っている */
  open: "提案中",
  /** 受け入れた（ユーザーが受け入れたか、確信が上がって AI が自動で受け入れた）。Task を作ったか、既存の Task に足した */
  accepted: "受け入れた",
  /** ユーザーが見送った。もとの事実が開いている間は残し、事実が行動を求めるように変われば、もう一度提案する */
  declined: "見送った",
  /** もとの事実が片付いて（PR が merge された など）、提案が要らなくなった */
  withdrawn: "取り下げた",
} as const;
export type ProposalStatus = (typeof ProposalStatus)[keyof typeof ProposalStatus];

export const ProposalKind = {
  /** 新しい Task を作る（確率が中間で、自動では作らなかった） */
  newTask: "新しい Task",
  /** 既存の Task の計画に足す（寄せ先つき。確率が中間・寄せ先の完了条件が未定で、自動では足さなかった）。既定の操作は「足す」 */
  addToTask: "既存の Task に足す",
  /** 既存の Task から切り出す（完了条件を満たしたのに、事実から足した項目がまだ残っていて、自動で閉じるのを止めた） */
  splitOut: "切り出す",
} as const;
export type ProposalKind = (typeof ProposalKind)[keyof typeof ProposalKind];

type Actor = { kind: "agent" } | { kind: "user" } | { kind: "sync" };

export const actors: Record<string, Actor> = {
  AI: { kind: "agent" },
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
};

export const inputs = {
  initial: { "新しい Task": ["新しい Task"], "既存の Task に足す": ["既存の Task に足す"], 切り出す: ["切り出す"] },
  autoAccept: { 確信が上がった: ["閾値を超えた"], まだ迷う: ["閾値に届かない"] },
  accept: { 提案どおり: ["提案どおり"], 別の形で: ["別の形で"] },
};

/** 提案する（AI が、判定が中間だった事実から・自動で閉じるのを止めた Task から） */
export function initial(actor: Actor, kind: ProposalKind): TaskProposal {
  ensure(actor.kind === "agent", "AI だけ");
  return {
    status: "提案中",
    kind,
    id: "p1",
    title: kind === "新しい Task" ? "監視の仕組みを見直す" : "リリース可否を返信する",
    brief: "障害の振り返りで、来月までに見直すことになった",
    plan: null,
    targetTaskId: kind === "新しい Task" ? null : "t1",
    sourceItemIds: ["s1"],
    judgment: "問い v1・確率 0.62",
    createdAt: "2026-11-28T00:00:00Z",
  };
}

/** 関係する事実を足す（同じ件の事実が、受け入れる前に続けて届いた。新しい提案は作らない） */
export function addFact(proposal: TaskProposal, actor: Actor): TaskProposal {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(proposal.status === "提案中", "提案中のときだけ");
  return { ...proposal, sourceItemIds: [...proposal.sourceItemIds, "s2"], judgment: "問い v1・確率 0.78" };
}

/**
 * 確信が上がったので、自動で受け入れる
 *
 * 事実が足されて判定し直した確率が、自動で作る・足す閾値を超えた。切り出す提案は、ユーザーが決める（自動で閉じるのを止めたあとの判断なので）。
 */
export function autoAccept(proposal: TaskProposal, actor: Actor, confidence: "閾値を超えた" | "閾値に届かない"): TaskProposal {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(proposal.status === "提案中", "提案中のときだけ");
  ensure(proposal.kind !== "切り出す", "切り出すかは、ユーザーが決める");
  ensure(confidence === "閾値を超えた", "判定し直した確率が、自動の閾値を超えたときだけ");
  return { ...proposal, status: "受け入れた" };
}

/**
 * 受け入れる
 *
 * 提案どおり（新しい Task を作る・寄せ先の計画に足す・切り出す）か、別の形で（新しい Task の提案を既存の Task に足す・足す提案を新しい Task にする）受け入れる。
 */
export function accept(proposal: TaskProposal, actor: Actor, _how: "提案どおり" | "別の形で"): TaskProposal {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(proposal.status === "提案中", "提案中のときだけ");
  return { ...proposal, status: "受け入れた" };
}

/** 見送る（Task も作らず、計画にも足さない） */
export function decline(proposal: TaskProposal, actor: Actor): TaskProposal {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(proposal.status === "提案中", "提案中のときだけ");
  return { ...proposal, status: "見送った" };
}

/** もう一度提案する（見送った提案の事実が、あとで行動を求めるように変わった。たとえば、あとから自分へのレビュー依頼が付いた） */
export function repropose(proposal: TaskProposal, actor: Actor): TaskProposal {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(proposal.status === "見送った", "見送ったときだけ");
  return { ...proposal, status: "提案中" };
}

/** 取り下げる（もとの事実が片付いて、もう行動を求めない。PR が merge された・元の項目がなくなった など） */
export function withdraw(proposal: TaskProposal, actor: Actor): TaskProposal {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(proposal.status === "提案中" || proposal.status === "見送った", "提案中か見送ったときだけ");
  return { ...proposal, status: "取り下げた" };
}

export const invariants = {
  "受け入れた・取り下げた提案は、もう変わらない": (before: TaskProposal, after: TaskProposal) =>
    (before.status !== "受け入れた" && before.status !== "取り下げた") || before.status === after.status,
  "新しい Task の提案には寄せ先がなく、足す・切り出す提案には寄せ先がある": (proposal: TaskProposal) => (proposal.kind === "新しい Task") === (proposal.targetTaskId === null),
};

export const links = [
  { from: accept, to: "task", label: "新しい Task として受け入れたら、Task を作り、提案の事実を持たせる" },
  { from: accept, to: "task", action: "receive", label: "寄せ先に足すとして受け入れたら、寄せ先の Task が計画を直す（足した項目として印を付ける）" },
  { from: accept, to: "task", action: "splitOut", label: "切り出すとして受け入れたら、寄せ先の Task から項目を切り出す" },
  { from: autoAccept, to: "task", label: "新しい Task の提案なら、Task を作る（自動で作った、として履歴に残す）" },
  { from: autoAccept, to: "task", action: "receive", label: "足す提案なら、寄せ先の Task が計画を直す" },
];

export const scenarios = {
  "提案するのは AI だけ": [{ do: initial, by: "同期", input: "新しい Task", denied: "AI だけ" }],
  "迷った事実は提案になり、受け入れて Task にする": [
    { do: initial, by: "AI", input: "新しい Task", expect: { status: "提案中" } },
    { do: addFact, by: "ユーザー", denied: "AI だけ" },
    { do: accept, by: "AI", input: "提案どおり", denied: "ユーザーだけ" },
    { do: accept, by: "ユーザー", input: "提案どおり", expect: { status: "受け入れた" } },
    { do: decline, by: "ユーザー", denied: "提案中のときだけ" },
  ],
  "関係する事実が続けて届いて確信が上がったら、自動で受け入れる": [
    { do: initial, by: "AI", input: "新しい Task" },
    { do: addFact, by: "AI", expect: { status: "提案中" } },
    { do: autoAccept, by: "AI", input: "まだ迷う", denied: "判定し直した確率が、自動の閾値を超えたときだけ" },
    { do: addFact, by: "AI" },
    { do: autoAccept, by: "AI", input: "確信が上がった", expect: { status: "受け入れた" } },
    { do: addFact, by: "AI", denied: "提案中のときだけ" },
  ],
  "見送った提案は、事実が行動を求めるように変わったら、もう一度提案する": [
    { do: initial, by: "AI", input: "既存の Task に足す" },
    { do: decline, by: "AI", denied: "ユーザーだけ" },
    { do: decline, by: "ユーザー", expect: { status: "見送った" } },
    { do: repropose, by: "ユーザー", denied: "AI だけ" },
    { do: repropose, by: "AI", expect: { status: "提案中" } },
    { do: accept, by: "ユーザー", input: "別の形で", expect: { status: "受け入れた" } },
  ],
  "切り出すかはユーザーが決め、もとの事実が片付いたら取り下げる": [
    { do: initial, by: "AI", input: "切り出す" },
    { do: autoAccept, by: "AI", input: "確信が上がった", denied: "切り出すかは、ユーザーが決める" },
    { do: withdraw, by: "ユーザー", denied: "AI だけ" },
    { do: withdraw, by: "AI", expect: { status: "取り下げた" } },
    { do: repropose, by: "AI", denied: "見送ったときだけ" },
  ],
};

export const reviewed = {
  "ignores-input:accept": "提案どおりか別の形かで変わるのは、何を作るか（新しい Task か、既存の Task の計画に足すか）で、つながり（links）に書いている。提案の段階はどちらも受け入れたになる",
};

export const questions = [
  {
    ask: "「確率が中間」の幅（提案にする範囲）と、確信が上がって自動で受け入れる閾値は、初めはいくつにするか？（提案が毎朝いくつも溜まるようなら、幅を狭める）",
    about: autoAccept,
    note: "正解ラベル付きのケースを作り、判定のハーネスでベンチマークしてから決める（spike/task-first/bench と同じ形）",
  },
];
