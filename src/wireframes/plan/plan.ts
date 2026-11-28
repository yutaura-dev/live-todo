import type { How } from "../model.js";

/**
 * 計画の木。specs/task.spec.ts の Plan・Branch と specs/action-definition.value.ts の Arrangement に合わせた、
 * ワイヤーフレーム用の形。Action Item は item、分かれ道は decision、完了したときにすることは effect。
 */
export type PlanItem = {
  type: "item";
  id: string;
  title: string;
  how: Exclude<How, "decision">;
  status: "todo" | "done" | "skipped";
  /** 手間（specs/action-definition.value.ts の Effort）。待つ・分かれ道は数えない */
  effort?: "すぐ済む" | "ふつう" | "難しい" | "面倒";
  /** 期日の元の書き方（「金曜までに」） */
  due?: string;
  /** 番が来たら自動でやるか（自動でやってよい範囲に入るときだけ自動で始まる） */
  trigger?: "auto" | "on_request";
  /** 完了条件か */
  completes?: boolean;
  /** Claude Code の作業（Agent Run）がどこまで進んだか。まだ頼んでいなければ持たない */
  run?: { state: "待ち行列"; position: number } | { state: "やっている" } | { state: "判断中" } | { state: "終わった" } | { state: "止まった"; reason: string } | { state: "元の項目が変わった" };
  /** 待つ条件（何を待つか・待つ見込み・確かめた結果） */
  condition?: { label: string; expectedWait?: string; observed: "まだ" | "成り立った" | "達成できない" };
  /** 人がやる場所（「開く」ボタンを出す） */
  place?: { label: string; certainty: "確かめた" | "AI が拾った" };
  /** 事実から計画に足した項目なら、もとの事実の題（ADR-0025）。切り出す操作を出し、完了条件で自動で閉じる前に済んでいるかを見る */
  addedFrom?: string;
  /** 書き込みで果たす項目の、ボタンに書く動詞と、書き込む中身の要約 */
  write?: { verb: string; summary: string };
};

/** 分かれ道の選択肢（specs/action-definition.value.ts の Option） */
export type PlanOption = {
  label: string;
  gains: Point[];
  costs: Point[];
  /** Decisions が良くなるか悪くなるかを判断できなかった観点 */
  unclear: Aspect[];
  then: { type: "planned"; plan: PlanGroup } | { type: "planLater"; direction: string };
};

/** 比べる観点（specs/action-definition.value.ts の Aspect。決め打ちの一覧） */
export const ASPECTS = ["期日", "手間", "あとの負担", "お金", "確実さ", "取り返し", "セキュリティ", "ほかの人", "機会", "決まり", "出来"] as const;
export type Aspect = (typeof ASPECTS)[number];

/** 得るもの・失うもの 1 つ（specs/action-definition.value.ts の Point）。観点と、具体的にどうなるか */
export type Point = { aspect: Aspect; detail: string };

/** 分かれ道で比べている観点。選択肢に出てくる観点（判断できなかったものも含む）を、決め打ちの観点の順に並べる */
export const aspectsOf = (options: ReadonlyArray<PlanOption>): Aspect[] => {
  const used = new Set(options.flatMap((option) => [...option.gains.map((point) => point.aspect), ...option.costs.map((point) => point.aspect), ...option.unclear]));
  return ASPECTS.filter((aspect) => used.has(aspect));
};

export type PlanBranch = { option: string; state: "進めている" | "取りやめた"; plan: PlanGroup | null };

export type PlanDecision = {
  type: "decision";
  id: string;
  title: string;
  /** 確かめる: 事実を確かめれば答えが決まる / 選ぶ: 天秤にかけて決める */
  kind: "確かめる" | "選ぶ";
  /** 何を決めるか（決めるために読むもの・選択肢の比べ方） */
  question: string;
  /** どう確かめるか（確かめる分かれ道だけ） */
  howToCheck: string | null;
  /** AI のおすすめ。Decisions が閾値以上で選べたときだけ持ち、理由は Generation が書く */
  recommendation: { label: string; reason: string } | null;
  status: "todo" | "done";
  /** 選ぶ前に見せる選択肢 */
  options: PlanOption[];
  /** 選んで差し込んだ枝（選び直したら、前の枝は取りやめたとして残る） */
  branches: PlanBranch[];
};

export type PlanEffect = { type: "effect"; title: string };

export type PlanGroup = { type: "group"; arrangement: "serial" | "parallel"; items: PlanNode[] };

export type PlanNode = PlanItem | PlanDecision | PlanEffect | PlanGroup;

export type Turn = { state: "済んだ" | "やらない" | "番が来ている" | "番待ち"; waitingOn: string[] };

const activeBranchOf = (decision: PlanDecision) => decision.branches.find((branch) => branch.state === "進めている");

const planLaterLabel = (option: string) => `「${option}」の計画（AI が考えています）`;

/** まだ済んでいない葉の題（後ろの項目が「何を待っているか」として見せる） */
function openTitles(node: PlanNode): string[] {
  if (node.type === "effect") return [];
  if (node.type === "item") return node.status === "todo" ? [node.title] : [];
  if (node.type === "group") return node.items.flatMap(openTitles);
  if (node.status === "todo") return [node.title];
  const active = activeBranchOf(node);
  if (active === undefined) return [];
  return active.plan === null ? [planLaterLabel(active.option)] : openTitles(active.plan);
}

const isComplete = (node: PlanNode) => openTitles(node).length === 0;

/**
 * 後ろの項目から見て、すぐ前にあるまだの項目。直列なら最後のまだの項目、並列ならまだのものすべて。
 * 直列の途中の項目まで並べない理由: 後ろの項目が直接待っているのは、その並びの最後の項目だけなので。
 */
function tailTitles(node: PlanNode): string[] {
  if (node.type === "effect" || node.type === "item") return openTitles(node);
  if (node.type === "group") {
    if (node.arrangement === "parallel") return node.items.flatMap(tailTitles);
    const lastOpen = node.items.findLast((child) => !isComplete(child));
    return lastOpen === undefined ? [] : tailTitles(lastOpen);
  }
  if (node.status === "todo") return [node.title];
  const active = activeBranchOf(node);
  if (active === undefined) return [];
  return active.plan === null ? [planLaterLabel(active.option)] : tailTitles(active.plan);
}

/**
 * 計画の中の位置から、項目ごとに番が来ているかと、番待ちなら何を待っているかを決める。
 * 待っているものは「すぐ前のまだの項目」だけにする。遠い祖先まで並べると、何を片付ければ進むかがかえって読めないため。
 */
export function turnsOf(plan: PlanGroup): Map<string, Turn> {
  const turns = new Map<string, Turn>();

  // 取りやめた枝でも、済んだことは消さない（specs/task.spec.ts の Plan）
  const markSkipped = (node: PlanNode) => {
    if (node.type === "item" || node.type === "decision") turns.set(node.id, { state: node.status === "done" ? "済んだ" : "やらない", waitingOn: [] });
    if (node.type === "group") node.items.forEach(markSkipped);
    if (node.type === "decision") node.branches.forEach((branch) => branch.plan && markSkipped(branch.plan));
  };

  const walk = (node: PlanNode, hasTurn: boolean, blockers: string[]) => {
    if (node.type === "effect") return;
    if (node.type === "item") {
      if (node.status === "done") turns.set(node.id, { state: "済んだ", waitingOn: [] });
      else if (node.status === "skipped") turns.set(node.id, { state: "やらない", waitingOn: [] });
      else turns.set(node.id, hasTurn ? { state: "番が来ている", waitingOn: [] } : { state: "番待ち", waitingOn: blockers });
      return;
    }
    if (node.type === "decision") {
      if (node.status === "todo") {
        turns.set(node.id, hasTurn ? { state: "番が来ている", waitingOn: [] } : { state: "番待ち", waitingOn: blockers });
        // 選び直したあとは、前の枝がすべて取りやめた枝として残っている
        node.branches.forEach((branch) => branch.plan && markSkipped(branch.plan));
        return;
      }
      turns.set(node.id, { state: "済んだ", waitingOn: [] });
      for (const branch of node.branches) {
        if (branch.plan === null) continue;
        if (branch.state === "取りやめた") markSkipped(branch.plan);
        else walk(branch.plan, hasTurn, blockers);
      }
      return;
    }
    if (node.arrangement === "parallel") {
      node.items.forEach((child) => walk(child, hasTurn, blockers));
      return;
    }
    let turn = hasTurn;
    let waitingOn = blockers;
    for (const child of node.items) {
      walk(child, turn, waitingOn);
      if (!isComplete(child)) {
        turn = false;
        waitingOn = tailTitles(child);
      }
    }
  };

  walk(plan, true, []);
  return turns;
}

/** 計画の進み具合。やらなくなった項目と、完了したときにすること（やることではない）は数えない */
export function progressOf(plan: PlanGroup) {
  const states = [...turnsOf(plan).values()].map((turn) => turn.state).filter((state) => state !== "やらない");
  return {
    total: states.length,
    done: states.filter((state) => state === "済んだ").length,
    now: states.filter((state) => state === "番が来ている").length,
    waiting: states.filter((state) => state === "番待ち").length,
  };
}

/** 番が来ている項目（計画の順）。詳細の「今できること」に出す */
export function currentOf(plan: PlanGroup): Array<PlanItem | PlanDecision> {
  const turns = turnsOf(plan);
  const result: Array<PlanItem | PlanDecision> = [];
  const visit = (node: PlanNode) => {
    if ((node.type === "item" || node.type === "decision") && turns.get(node.id)?.state === "番が来ている") result.push(node);
    if (node.type === "group") node.items.forEach(visit);
    if (node.type === "decision") node.branches.forEach((branch) => branch.state === "進めている" && branch.plan && visit(branch.plan));
  };
  visit(plan);
  return result;
}

function mapPlan(group: PlanGroup, change: (node: PlanItem | PlanDecision) => PlanItem | PlanDecision): PlanGroup {
  const visit = (node: PlanNode): PlanNode => {
    if (node.type === "effect") return node;
    if (node.type === "group") return { ...node, items: node.items.map(visit) };
    const changed = change(node);
    if (changed.type === "decision") return { ...changed, branches: changed.branches.map((branch) => ({ ...branch, plan: branch.plan && (visit(branch.plan) as PlanGroup) })) };
    return changed;
  };
  return visit(group) as PlanGroup;
}

export const complete = (plan: PlanGroup, id: string): PlanGroup =>
  mapPlan(plan, (node) => (node.type === "item" && node.id === id ? { ...node, status: "done" } : node));

/** 済んだ項目を戻す。戻せるのは人か Claude Code が果たす項目だけ（待つ条件・書き込みは外で起きたことなので戻さない） */
export const reopenItem = (plan: PlanGroup, id: string): PlanGroup =>
  mapPlan(plan, (node) => (node.type === "item" && node.id === id && node.status === "done" && (node.how === "human" || node.how === "claude") ? { ...node, status: "todo" } : node));

/** この並びの中で、Claude Code がやっている・判断中の項目があるか（選び直す・終えるときに「作業を止めますか」と確かめる） */
export function hasRunningWork(node: PlanNode): boolean {
  if (node.type === "item") return node.run?.state === "やっている" || node.run?.state === "判断中";
  if (node.type === "group") return node.items.some(hasRunningWork);
  if (node.type === "decision") return node.branches.some((branch) => branch.state === "進めている" && branch.plan !== null && hasRunningWork(branch.plan));
  return false;
}

/** 分かれ道で選ぶ。進めていた枝があれば取りやめたにして、選んだ選択肢の先を新しい枝として差し込む */
export const choose = (plan: PlanGroup, id: string, label: string): PlanGroup =>
  mapPlan(plan, (node) => {
    if (node.type !== "decision" || node.id !== id) return node;
    const option = node.options.find((candidate) => candidate.label === label);
    if (option === undefined) return node;
    return {
      ...node,
      status: "done",
      branches: [
        ...node.branches.map((branch) => ({ ...branch, state: "取りやめた" as const })),
        { option: label, state: "進めている", plan: option.then.type === "planned" ? option.then.plan : null },
      ],
    };
  });

/** 選び直す。分かれ道にもう一度番を戻し、進めていた枝は取りやめた枝として残す */
export const rechoose = (plan: PlanGroup, id: string): PlanGroup =>
  mapPlan(plan, (node) =>
    node.type === "decision" && node.id === id
      ? { ...node, status: "todo", branches: node.branches.map((branch) => ({ ...branch, state: "取りやめた" as const })) }
      : node,
  );
