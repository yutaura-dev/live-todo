import { ensure } from "@yutaura/live-spec";

/**
 * 振り分け（届いた事実 1 件を、どの Task についての事実にするか）。Source Item が届くたびに 1 つでき、その Source Item ごとに 1 つ持つ。
 * 確かなものから順に決める。同じ URL・同じスレッドなど識別子で決まるものは同期が決め、残りは候補の Task を絞ってから AI が選ぶ。どれにも当たらなければ、「この事実は、自分に新しい行動を求めるか」を判定して、新しい Task を生むかを決める（マージ済みの PR のように、もう行動を求めない事実からは生まない）。
 * 迷ったら（確率が中間・refusal）、新しい Task にも既存の Task にも黙って入れず、ユーザーに決めてもらう（fail closed）。
 * 1 つの事実を、いくつの Task が持ってもよい。ただし自動で紐づけるのは 1 つの Task だけで、2 つ目以降は、識別子で確実に決まるときとユーザーが手で足したときだけ。
 * どの Task がこの事実を持つかは、Task が持つ（つながりの持ち主は Task）。振り分けは、どの Task に持たせるかを決めて Task に頼み、段階と判定の記録だけを持つ。
 */
export type Routing = {
  /** 振り分けの段階 */
  status: RoutingStatus;
  /** どの事実の振り分けか @ref source-item */
  sourceItemId: string;
  /** 振り分けたときの判定（方法・確率・理由）。対象外にしたものも、あとから見直せるように残す */
  judgment: string | null;
};

export const RoutingStatus = {
  /** まだ振り分けていない */
  pending: "未振り分け",
  /** 1 つ以上の Task の事実にした */
  routed: "振り分けた",
  /** どの Task のものでもない（自分には関係がない） */
  ignored: "対象外",
  /** 迷ったので、ユーザーが決めるのを待つ。どの Task にも入れていない */
  waitingForUser: "ユーザー待ち",
} as const;
export type RoutingStatus = (typeof RoutingStatus)[keyof typeof RoutingStatus];

/** 振り分けの結果 */
type Outcome = "既存の Task の事実にする" | "新しい Task を生む" | "対象外" | "迷う";

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
 * 同期は識別子で決まるものだけを決めるので、迷わない。迷うのは、候補から選ぶ AI だけ。
 *
 * アプリが作る操作で作ったもの（Write が持つ作ったものの URI と一致し、その URI が Write の作る場所の中にある Source Item）は、Decisions を通さず、その Write の Task に振り分ける。どちらかが成り立たなければ、ふつうの振り分けに任せる。
 */
export function route(routing: Routing, actor: Actor, outcome: Outcome): Routing {
  ensure(actor.kind === "sync" || actor.kind === "agent", "同期か AI だけ");
  ensure(routing.status === "未振り分け", "まだ振り分けていないときだけ");
  ensure(outcome !== "迷う" || actor.kind === "agent", "迷うのは AI だけ（同期は識別子で決まるものしか決めない）");
  return { ...routing, status: outcome === "対象外" ? "対象外" : outcome === "迷う" ? "ユーザー待ち" : "振り分けた" };
}

/**
 * ユーザーが振り分ける
 *
 * ユーザー待ちの事実を決める・対象外にした事実を拾い直す・振り分けを直す。既存の Task に移すときは、前に持っていた Task からは外す。対象外にするときは、すべての Task から外す。
 */
export function routeByUser(routing: Routing, actor: Actor, outcome: Exclude<Outcome, "迷う">): Routing {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(routing.status !== "未振り分け", "自動の振り分けのあとだけ");
  return { ...routing, status: outcome === "対象外" ? "対象外" : "振り分けた" };
}

/**
 * ほかの Task にも持たせる
 *
 * 2 つ目以降の Task に持たせるのは、識別子で確実に決まるとき（同期）と、ユーザーが手で足したときだけ。AI は 2 つ目以降を選ばない（誤って紐づけるのを避けるため）。
 */
export function addTask(routing: Routing, actor: Actor): Routing {
  ensure(actor.kind === "sync" || actor.kind === "user", "同期かユーザーだけ");
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
 * 振り分けた事実なら、持ち主の Task に変化を伝える。対象外にした事実なら、行動を求めるようになったかもしれないので、振り分けをやり直す（たとえば、あとから自分へのレビュー依頼が付いた）。
 * ユーザー待ち・未振り分けの事実は、そのまま待つ（振り分けるときに今の姿を見る）。
 */
export function factChanged(routing: Routing, actor: Actor): Routing {
  ensure(actor.kind === "sync", "同期だけ");
  return { ...routing, status: routing.status === "対象外" ? "未振り分け" : routing.status };
}

export const inputs = {
  route: {
    "既存の Task へ": ["既存の Task の事実にする"],
    "新しい Task": ["新しい Task を生む"],
    対象外: ["対象外"],
    迷う: ["迷う"],
  },
  routeByUser: {
    "既存の Task へ": ["既存の Task の事実にする"],
    "新しい Task": ["新しい Task を生む"],
    対象外: ["対象外"],
  },
  removeTask: { ほかに残る: ["ほかの Task に残る"], どこにも残らない: ["どの Task にも残らない"] },
};

export const invariants = {
  "Task に持たせたら、未振り分けには戻らない": (before: Routing, after: Routing) => before.status !== "振り分けた" || after.status !== "未振り分け",
};

export const links = [
  { from: route, to: "task", action: "triage", label: "新しい Task を生むなら、Task を作って仕分ける" },
  { from: route, to: "task", action: "attachFact", label: "Task（既存か、新しく作ったもの）に事実を持たせる" },
  { from: routeByUser, to: "task", action: "attachFact", label: "選んだ Task に事実を持たせる" },
  { from: routeByUser, to: "task", action: "detachFact", label: "移すなら前の Task から、対象外にするならすべての Task から、事実を外す" },
  { from: addTask, to: "task", action: "attachFact", label: "足した Task に事実を持たせる" },
  { from: removeTask, to: "task", action: "detachFact", label: "その Task から事実を外す" },
  { from: factChanged, to: "task", action: "receive", label: "振り分けた事実なら、持ち主の Task が変化を受け取る（事実が変わった、として届く）" },
];

export const scenarios = {
  "届いた PR から新しい Task を生む": [
    { do: initial, by: "同期", expect: { status: "未振り分け" } },
    { do: route, by: "AI", input: "新しい Task", expect: { status: "振り分けた" } },
    { do: route, by: "AI", input: "既存の Task へ", denied: "まだ振り分けていないときだけ" },
  ],
  "対象外にした事実が変わったら、振り分けをやり直す": [
    { do: initial, by: "同期" },
    { do: route, by: "AI", input: "対象外", expect: { status: "対象外" } },
    { do: factChanged, by: "AI", denied: "同期だけ" },
    { do: factChanged, by: "同期", expect: { status: "未振り分け" } },
    { do: route, by: "AI", input: "既存の Task へ", expect: { status: "振り分けた" } },
    { do: factChanged, by: "同期", expect: { status: "振り分けた" } },
  ],
  "迷った事実は、ユーザーが決めるまでどこにも入れない": [
    { do: initial, by: "同期" },
    { do: route, by: "同期", input: "迷う", denied: "迷うのは AI だけ（同期は識別子で決まるものしか決めない）" },
    { do: route, by: "AI", input: "迷う", expect: { status: "ユーザー待ち" } },
    { do: routeByUser, by: "AI", input: "既存の Task へ", denied: "ユーザーだけ" },
    { do: routeByUser, by: "ユーザー", input: "既存の Task へ", expect: { status: "振り分けた" } },
  ],
  "2 つ目以降の Task に持たせるのは、同期（識別子で決まる）かユーザーだけ": [
    { do: initial, by: "同期" },
    { do: addTask, by: "同期", denied: "振り分けたあとだけ" },
    { do: removeTask, by: "ユーザー", input: "ほかに残る", denied: "振り分けたあとだけ" },
    { do: routeByUser, by: "ユーザー", input: "対象外", denied: "自動の振り分けのあとだけ" },
    { do: route, by: "同期", input: "既存の Task へ" },
    { do: addTask, by: "AI", denied: "同期かユーザーだけ" },
    { do: addTask, by: "同期", expect: { status: "振り分けた" } },
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
  "indistinguishable-example:route:既存の Task へ,新しい Task": "どちらも振り分けたになる。違いは、既存の Task が事実を受け取るか、新しい Task を作るかで、つながり（links）に書いている",
  "indistinguishable-example:routeByUser:既存の Task へ,新しい Task": "どちらも振り分けたになる。違いは、既存の Task が事実を受け取るか、新しい Task を作るかで、つながり（links）に書いている",
  "anytime:factChanged": "事実はいつでも変わりうる。変わったときにどうするかは、振り分けの段階で決まる（振り分けたなら Task に伝え、対象外なら振り分け直す）",
  "same-for-similar-actors:addTask": "2 つ目以降の Task に持たせるのは、識別子で確実に決まるとき（同期）と、ユーザーが手で足したとき。AI だけを外すのが決まり（シナリオで確かめている）",
};

export const questions = [
  {
    ask: "事実への書き込み（メールのアーカイブ・既読など）は、同じ事実を持つほかの Task にも響く。ほかの開いている Task も持っているときは、承認の画面で知らせるか、自動では書き込まないか？",
  },
];
