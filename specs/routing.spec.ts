import { ensure } from "@yutaura/live-spec";

/**
 * 振り分け（届いた事実 1 件を、どの Task についての事実にし、何を生むか）。Source Item が届くたびに 1 つでき、その Source Item ごとに 1 つ持つ（ADR-0025）。
 * 届いた事実について、AI は 3 つを別々に判定する（判断表 1〜3）。
 * 判定 1 は、既存のどの Task の事実か。緩めに、いくつの Task にでも自動で紐づける（間違えても、外す・移すで安く直せる）。同じ URL・同じスレッドなど識別子で決まるものは同期が決める。
 * 判定 2 は、紐づけた Task ごとに、事実が求める作業をその Task の計画に足すか。軸は「その Task の完了条件をすべて満たしたあとも、その作業をやる意味が残るか」で、残らないなら計画に足し（Task の数を増やさない）、残るなら新しい Task の候補にする。
 * 判定 3 は、新しい Task を生むか。どの Task の計画にも入らない作業ごとに（0 個のことも、複数のこともある）、確信が高ければ自動で作り、迷えば提案にする。
 * 識別子は判定 1 の材料にだけ使い、判定 3 の材料にはしない（同じスレッドに別の依頼が来ることはよくある）。
 * 迷ったら（確率が中間）、黙って足しも作りもせず、提案にしてユーザーに見せる（fail closed。提案は Task ではないので、Task の数は増えない）。
 * AI が見たのに決められなかった（refusal・答えが形に合わない）ときは、事実をユーザー待ちにする。AI に届かなかった（API が落ちている・時間切れ）ときは、未振り分けのまま次の同期でやり直す。
 * どの Task がこの事実を持つかは、Task が持つ（つながりの持ち主は Task）。振り分けは、段階と判定の記録（問いの版・確率）だけを持つ。
 */
export type Routing = {
  /** 振り分けの段階 */
  status: RoutingStatus;
  /** どの事実の振り分けか @ref source-item */
  sourceItemId: string;
  /** 振り分けたときの判定（方法・問いの版・確率）。Decisions は理由を返さないので、あとから追えるように、対象外にしたものも残す */
  judgment: string | null;
};

export const RoutingStatus = {
  /** まだ振り分けていない（AI に届かなかったときも、ここで次の同期を待つ） */
  pending: "未振り分け",
  /** Task か提案に持たせた（既存の Task の事実にした・計画に足した・新しい Task を作った・提案にした） */
  routed: "振り分けた",
  /** どの Task のものでもなく、新しい行動も求めない（自分には関係がない） */
  ignored: "対象外",
  /** AI が見たのに決められなかった（refusal・答えが形に合わない）、またはユーザーがすべての Task から外した。どうするかをユーザーが決める */
  waitingForUser: "ユーザー待ち",
} as const;
export type RoutingStatus = (typeof RoutingStatus)[keyof typeof RoutingStatus];

/** 振り分けの結果（1 件の事実から、紐づける・足す・作る・提案するが同時に起きることもある。ここでは、振り分けの段階を決める代表の結果だけを持つ） */
type Outcome =
  | "既存の Task の事実にする"
  | "新しい Task を作る"
  | "提案にする"
  | "対象外"
  | "判断できなかった";

type Actor = { kind: "sync" } | { kind: "agent" } | { kind: "user" };

export const actors: Record<string, Actor> = {
  同期: { kind: "sync" },
  AI: { kind: "agent" },
  ユーザー: { kind: "user" },
};

/** 届いた事実の振り分けを始める（Source Item が取り込まれたとき） */
export function initial(actor: Actor): Routing {
  ensure(actor.kind === "sync", "同期だけ");
  return { status: "未振り分け", sourceItemId: "s1", judgment: null };
}

/**
 * 振り分ける
 *
 * 同期は、識別子で決まるもの（既存の Task の事実にする）と、規則で決まるもの（自分へのレビュー依頼から Task を作る・絞り込みの外は対象外）だけを決める。提案にする・判断できなかったは、確率で判定する AI だけ。
 *
 * アプリが作る操作で作ったもの（Write が持つ作ったものの URI と一致し、その URI が Write の作る場所の中にある Source Item）は、Decisions を通さず、その Write の Task の事実にする。
 */
export function route(routing: Routing, actor: Actor, outcome: Outcome): Routing {
  ensure(actor.kind === "sync" || actor.kind === "agent", "同期か AI だけ");
  ensure(routing.status === "未振り分け", "まだ振り分けていないときだけ");
  ensure((outcome !== "提案にする" && outcome !== "判断できなかった") || actor.kind === "agent", "提案と判断できなかったは AI だけ（同期は識別子と規則で決まるものしか決めない）");
  return { ...routing, status: outcome === "対象外" ? "対象外" : outcome === "判断できなかった" ? "ユーザー待ち" : "振り分けた" };
}

/**
 * ユーザーが振り分ける
 *
 * ユーザー待ちの事実を決める・対象外にした事実を拾い直す・振り分けを直す。既存の Task に移すときは、前に持っていた Task からは外す。対象外にするときは、すべての Task から外す。
 */
export function routeByUser(routing: Routing, actor: Actor, outcome: "既存の Task の事実にする" | "新しい Task を作る" | "対象外"): Routing {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(routing.status !== "未振り分け", "自動の振り分けのあとだけ");
  return { ...routing, status: outcome === "対象外" ? "対象外" : "振り分けた" };
}

/**
 * ほかの Task にも持たせる
 *
 * 関係しそうな Task には、いくつでも紐づけてよい（緩めに紐づける。間違えたら外す・移すで直す）。同期は識別子で、AI は判定で、ユーザーは手で足す。
 * 自動で紐づける数に上限は置かない（判定 1 が適切なら、関係する Task の数だけ紐づくのが正しい。判定 2 の呼び出しが増える費用は、判定 1 の精度で抑える）。
 */
export function addTask(routing: Routing, _actor: Actor): Routing {
  ensure(routing.status === "振り分けた", "振り分けたあとだけ");
  return { ...routing };
}

/**
 * ある Task から外す
 *
 * ほかの Task にまだ残るなら振り分けたまま。どの Task にも残らないなら、どうするかを決めてもらうまでユーザー待ちにする。
 */
export function removeTask(routing: Routing, actor: Actor, remaining: "ほかの Task に残る" | "どの Task にも残らない"): Routing {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(routing.status === "振り分けた", "振り分けたあとだけ");
  return { ...routing, status: remaining === "ほかの Task に残る" ? "振り分けた" : "ユーザー待ち" };
}

/**
 * 事実が変わったことを受ける
 *
 * 振り分けた事実なら、持ち主の Task・提案に変化を伝える（見送った提案の事実が行動を求めるように変われば、もう一度提案する）。対象外にした事実なら、行動を求めるようになったかもしれないので、振り分けをやり直す（たとえば、あとから自分へのレビュー依頼が付いた）。
 * 持ち主の Task がすべて終わっていたら、振り分けをやり直す（自分で片付けた Task に事実が残ったままだと、同じ PR に新しいレビュー依頼が来ても、どの Task にも届かないため。終わった Task に関係する事実からは、新しい Task を作る）。
 * ユーザー待ち・未振り分けの事実は、そのまま待つ（振り分けるときに今の姿を見る）。
 */
export function factChanged(routing: Routing, actor: Actor, owners: "開いている Task がある" | "持ち主の Task がすべて終わった"): Routing {
  ensure(actor.kind === "sync", "同期だけ");
  if (routing.status === "振り分けた" && owners === "持ち主の Task がすべて終わった") return { ...routing, status: "未振り分け" };
  return { ...routing, status: routing.status === "対象外" ? "未振り分け" : routing.status };
}

export const inputs = {
  factChanged: { 開いている: ["開いている Task がある"], すべて終わった: ["持ち主の Task がすべて終わった"] },
  route: {
    "既存の Task へ": ["既存の Task の事実にする"],
    "新しい Task": ["新しい Task を作る"],
    提案: ["提案にする"],
    対象外: ["対象外"],
    判断できなかった: ["判断できなかった"],
  },
  routeByUser: {
    "既存の Task へ": ["既存の Task の事実にする"],
    "新しい Task": ["新しい Task を作る"],
    対象外: ["対象外"],
  },
  removeTask: { ほかに残る: ["ほかの Task に残る"], どこにも残らない: ["どの Task にも残らない"] },
};

export const invariants = {};

export const links = [
  { from: route, to: "task", action: "attachFact", label: "紐づける Task（いくつでも）に事実を持たせる" },
  { from: route, to: "task", action: "receive", label: "計画に足すと判定した Task が、事実を受け取って計画を直す（足した項目として印を付ける）" },
  { from: route, to: "task", label: "確信が高い新しい Task を作る（作業ごとに 1 つ。複数のこともある）" },
  { from: route, to: "task-proposal", label: "迷った作業は提案にする（新しい Task の提案か、寄せ先つきの足す提案）。同じ件の提案があれば、そこに事実を足す" },
  { from: routeByUser, to: "task", action: "attachFact", label: "選んだ Task に事実を持たせる" },
  { from: routeByUser, to: "task", action: "detachFact", label: "移すなら前の Task から、対象外にするならすべての Task から、事実を外す" },
  { from: addTask, to: "task", action: "attachFact", label: "足した Task に事実を持たせる" },
  { from: removeTask, to: "task", action: "detachFact", label: "その Task から事実を外す" },
  { from: factChanged, to: "task", action: "receive", label: "振り分けた事実なら、持ち主の Task が変化を受け取る（事実が変わった、として届く）" },
  { from: factChanged, to: "task-proposal", action: "repropose", label: "見送った提案の事実が行動を求めるように変われば、もう一度提案する（もう行動を求めなくなったら、提案を取り下げる）" },
];

/** 判定 1: この事実を、候補の Task の事実にするか（候補ごとに判定する。候補は開いている Task だけ。終わった Task に関係する事実は、新しい Task の材料にする） */
function linkTo(input: {
  識別子: "一致する" | "一致しない";
  "関係するかの確率": "高い" | "中くらい" | "低い" | "判断できなかった";
}): "紐づける" | "紐づけない" | "判断できなかった" {
  if (input.識別子 === "一致する") return "紐づける";
  if (input["関係するかの確率"] === "判断できなかった") return "判断できなかった";
  // 緩めに紐づける（中くらいでも紐づける）。間違えても、外す・移すで安く直せ、計画に足すかは判定 2 で別に決めるため
  return input["関係するかの確率"] === "低い" ? "紐づけない" : "紐づける";
}

/**
 * 判定 2: 紐づけた Task ごとに、事実が求める作業を、その Task の計画に足すか
 *
 * Decisions への問い: 「この事実が求める作業は、Task『X』の完了条件をすべて満たしたあとも、やる意味が残るか」。入力は事実と、Task の題・今の状況・計画（まだ済んでいない Action Item と完了条件）。
 * 「一緒に終わるか」と未来を推測させる形にしない（確率が中間に割れる）。手元の完了条件と比べさせる。
 * 完了条件が未定の Task（計画を立てる前・選んでから考える選択肢の先がまだ）では、この問いに答えられないので、自動では足さず、足す提案にする。
 */
function placeWork(input: {
  "事実が求める作業": "ある" | "ない";
  "寄せ先の完了条件": "決まっている" | "未定";
  "完了したあとも残るかの確率": "低い" | "中間" | "高い" | "判断できなかった";
}): "計画に足す" | "足す提案にする" | "新しい Task の候補にする" | "事実として持つだけ" | "判断できなかった" {
  if (input["事実が求める作業"] === "ない") return "事実として持つだけ";
  const p = input["完了したあとも残るかの確率"];
  if (p === "判断できなかった") return "判断できなかった";
  if (p === "高い") return "新しい Task の候補にする";
  if (input["寄せ先の完了条件"] === "未定") return "足す提案にする";
  return p === "低い" ? "計画に足す" : "足す提案にする";
}

/**
 * 判定 3: どの Task の計画にも入らない作業から、新しい Task を生むか（作業ごとに判定する。1 つの事実から複数の Task が生まれることもある）
 *
 * Decisions への問い: 「この作業は、自分が新しく行動する必要があるか」。識別子（同じスレッド・同じ PR）は材料にしない。
 */
function createTask(input: { "行動が要るかの確率": "高い" | "中間" | "低い" | "判断できなかった" }): "自動で Task を作る" | "新しい Task の提案にする" | "作らない" | "判断できなかった" {
  const p = input["行動が要るかの確率"];
  if (p === "判断できなかった") return "判断できなかった";
  if (p === "高い") return "自動で Task を作る";
  if (p === "中間") return "新しい Task の提案にする";
  return "作らない";
}

export const decisions = {
  "1. 候補の Task の事実にするか（緩めに紐づける）": {
    decide: linkTo,
    cases: [
      { input: { 識別子: "一致する", "関係するかの確率": "低い" }, expect: "紐づける" },
      { input: { 識別子: "一致しない", "関係するかの確率": "高い" }, expect: "紐づける" },
      { input: { 識別子: "一致しない", "関係するかの確率": "中くらい" }, expect: "紐づける" },
      { input: { 識別子: "一致しない", "関係するかの確率": "低い" }, expect: "紐づけない" },
      { input: { 識別子: "一致しない", "関係するかの確率": "判断できなかった" }, expect: "判断できなかった" },
    ],
  },
  "2. 紐づけた Task の計画に足すか（その Task が終わっても、作業が残るか）": {
    decide: placeWork,
    cases: [
      { input: { "事実が求める作業": "ない", "寄せ先の完了条件": "決まっている", "完了したあとも残るかの確率": "低い" }, expect: "事実として持つだけ" },
      { input: { "事実が求める作業": "ある", "寄せ先の完了条件": "決まっている", "完了したあとも残るかの確率": "低い" }, expect: "計画に足す" },
      { input: { "事実が求める作業": "ある", "寄せ先の完了条件": "決まっている", "完了したあとも残るかの確率": "中間" }, expect: "足す提案にする" },
      { input: { "事実が求める作業": "ある", "寄せ先の完了条件": "決まっている", "完了したあとも残るかの確率": "高い" }, expect: "新しい Task の候補にする" },
      { input: { "事実が求める作業": "ある", "寄せ先の完了条件": "未定", "完了したあとも残るかの確率": "低い" }, expect: "足す提案にする" },
      { input: { "事実が求める作業": "ある", "寄せ先の完了条件": "未定", "完了したあとも残るかの確率": "高い" }, expect: "新しい Task の候補にする" },
      { input: { "事実が求める作業": "ある", "寄せ先の完了条件": "決まっている", "完了したあとも残るかの確率": "判断できなかった" }, expect: "判断できなかった" },
    ],
  },
  "3. 新しい Task を生むか（作業ごと）": {
    decide: createTask,
    cases: [
      { input: { "行動が要るかの確率": "高い" }, expect: "自動で Task を作る" },
      { input: { "行動が要るかの確率": "中間" }, expect: "新しい Task の提案にする" },
      { input: { "行動が要るかの確率": "低い" }, expect: "作らない" },
      { input: { "行動が要るかの確率": "判断できなかった" }, expect: "判断できなかった" },
    ],
  },
};

export const scenarios = {
  "持ち主の Task がすべて終わった事実が変わったら、振り分け直す": [
    { do: initial, by: "同期" },
    { do: route, by: "同期", input: "既存の Task へ" },
    { do: factChanged, by: "同期", input: "すべて終わった", expect: { status: "未振り分け" } },
  ],
  "届いた PR から新しい Task を作る": [
    { do: initial, by: "同期", expect: { status: "未振り分け" } },
    { do: route, by: "AI", input: "新しい Task", expect: { status: "振り分けた" } },
    { do: route, by: "AI", input: "既存の Task へ", denied: "まだ振り分けていないときだけ" },
  ],
  "迷った作業は提案にする（提案にできるのは AI だけ）": [
    { do: initial, by: "同期" },
    { do: route, by: "同期", input: "提案", denied: "提案と判断できなかったは AI だけ（同期は識別子と規則で決まるものしか決めない）" },
    { do: route, by: "AI", input: "提案", expect: { status: "振り分けた" } },
  ],
  "対象外にした事実が変わったら、振り分けをやり直す": [
    { do: initial, by: "同期" },
    { do: route, by: "AI", input: "対象外", expect: { status: "対象外" } },
    { do: factChanged, by: "AI", input: "開いている", denied: "同期だけ" },
    { do: factChanged, by: "同期", input: "開いている", expect: { status: "未振り分け" } },
    { do: route, by: "AI", input: "既存の Task へ", expect: { status: "振り分けた" } },
    { do: factChanged, by: "同期", input: "開いている", expect: { status: "振り分けた" } },
  ],
  "AI が決められなかった事実は、ユーザーが決めるまでどこにも入れない": [
    { do: initial, by: "同期" },
    { do: route, by: "同期", input: "判断できなかった", denied: "提案と判断できなかったは AI だけ（同期は識別子と規則で決まるものしか決めない）" },
    { do: route, by: "AI", input: "判断できなかった", expect: { status: "ユーザー待ち" } },
    { do: routeByUser, by: "AI", input: "既存の Task へ", denied: "ユーザーだけ" },
    { do: routeByUser, by: "ユーザー", input: "既存の Task へ", expect: { status: "振り分けた" } },
  ],
  "いくつの Task にでも紐づけられ、すべての Task から外したらユーザー待ちになる": [
    { do: initial, by: "同期" },
    { do: addTask, by: "AI", denied: "振り分けたあとだけ" },
    { do: removeTask, by: "ユーザー", input: "ほかに残る", denied: "振り分けたあとだけ" },
    { do: routeByUser, by: "ユーザー", input: "対象外", denied: "自動の振り分けのあとだけ" },
    { do: route, by: "同期", input: "既存の Task へ" },
    { do: addTask, by: "AI", expect: { status: "振り分けた" } },
    { do: removeTask, by: "同期", input: "ほかに残る", denied: "ユーザーだけ" },
    { do: removeTask, by: "ユーザー", input: "ほかに残る", expect: { status: "振り分けた" } },
    { do: removeTask, by: "ユーザー", input: "どこにも残らない", expect: { status: "ユーザー待ち" } },
    { do: routeByUser, by: "ユーザー", input: "対象外", expect: { status: "対象外" } },
  ],
  "振り分けを始めるのは同期だけ": [{ do: initial, by: "AI", denied: "同期だけ" }],
  "自動の振り分けは同期か AI だけ": [
    { do: initial, by: "同期" },
    { do: route, by: "ユーザー", input: "対象外", denied: "同期か AI だけ" },
    { do: route, by: "同期", input: "対象外", expect: { status: "対象外" } },
  ],
};

export const reviewed = {
  "indistinguishable-example:route:既存の Task へ,新しい Task": "どちらも振り分けたになる。違いは、既存の Task が事実を受け取るか・新しい Task を作るかで、つながり（links）と判断表に書いている",
  "indistinguishable-example:routeByUser:既存の Task へ,新しい Task": "どちらも振り分けたになる。違いは、既存の Task が事実を受け取るか、新しい Task を作るかで、つながり（links）に書いている",
  "anytime:factChanged": "事実はいつでも変わりうる。変わったときにどうするかは、振り分けの段階で決まる（振り分けたなら Task・提案に伝え、対象外なら振り分け直す）",
  "anyone-can:addTask": "ほかの Task に紐づけるのは、同期（識別子）・AI（判定。緩めに紐づける）・ユーザー（手で足す）の誰でもよい（ADR-0025）",
  "same-for-similar-actors:addTask": "ほかの Task に紐づけるのは、同期・AI・ユーザーの誰でもよく、誰が紐づけても同じように持つ。数の上限も置かない（ADR-0025）",
};

export const questions = [
  {
    ask: "事実への書き込み（メールのアーカイブ・既読など）は、同じ事実を持つほかの Task にも響く。ほかの開いている Task も持っているときは、承認の画面で知らせるか、自動では書き込まないか？",
  },
];
