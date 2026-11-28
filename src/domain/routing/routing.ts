import { Effect, Schema } from "effect";
import { guard } from "../denied.js";

// specs/routing.spec.ts の Routing（届いた事実 1 件の振り分け）

export const RoutingStatus = Schema.Literals(["未振り分け", "振り分けた", "対象外", "ユーザー待ち"]);
export const Routing = Schema.Struct({
  status: RoutingStatus,
  sourceItemId: Schema.String,
  /** 振り分けたときの判定（問いの ID・版・確率）。Decisions は理由を返さないので、あとから追えるように残す */
  judgment: Schema.NullOr(Schema.String),
});
export type Routing = typeof Routing.Type;

export type RoutingOutcome = "既存の Task の事実にする" | "新しい Task を作る" | "提案にする" | "対象外" | "判断できなかった";
export type RoutingActor = { readonly kind: "sync" } | { readonly kind: "agent" } | { readonly kind: "user" };

export const startRouting = Effect.fn("Routing.start")(function* (sourceItemId: string, actor: RoutingActor) {
  yield* guard("routing", "initial")(actor.kind === "sync", "同期だけ");
  const routing: Routing = { status: "未振り分け", sourceItemId, judgment: null };
  return routing;
});

export const route = Effect.fn("Routing.route")(function* (routing: Routing, actor: RoutingActor, outcome: RoutingOutcome, judgment: string) {
  const ensure = guard("routing", "route");
  yield* ensure(actor.kind === "sync" || actor.kind === "agent", "同期か AI だけ");
  yield* ensure(routing.status === "未振り分け", "まだ振り分けていないときだけ");
  yield* ensure((outcome !== "提案にする" && outcome !== "判断できなかった") || actor.kind === "agent", "提案と判断できなかったは AI だけ（同期は識別子と規則で決まるものしか決めない）");
  const status = outcome === "対象外" ? ("対象外" as const) : outcome === "判断できなかった" ? ("ユーザー待ち" as const) : ("振り分けた" as const);
  return { ...routing, status, judgment };
});

export const routeByUser = Effect.fn("Routing.routeByUser")(function* (routing: Routing, actor: RoutingActor, outcome: "既存の Task の事実にする" | "新しい Task を作る" | "対象外") {
  const ensure = guard("routing", "routeByUser");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(routing.status !== "未振り分け", "自動の振り分けのあとだけ");
  return { ...routing, status: outcome === "対象外" ? ("対象外" as const) : ("振り分けた" as const) };
});

export const addTask = Effect.fn("Routing.addTask")(function* (routing: Routing, _actor: RoutingActor) {
  yield* guard("routing", "addTask")(routing.status === "振り分けた", "振り分けたあとだけ");
  return routing;
});

export const removeTask = Effect.fn("Routing.removeTask")(function* (routing: Routing, actor: RoutingActor, remaining: "ほかの Task に残る" | "どの Task にも残らない") {
  const ensure = guard("routing", "removeTask");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(routing.status === "振り分けた", "振り分けたあとだけ");
  return { ...routing, status: remaining === "ほかの Task に残る" ? ("振り分けた" as const) : ("ユーザー待ち" as const) };
});

export const factChanged = Effect.fn("Routing.factChanged")(function* (routing: Routing, actor: RoutingActor, owners: "開いている Task がある" | "持ち主の Task がすべて終わった") {
  yield* guard("routing", "factChanged")(actor.kind === "sync", "同期だけ");
  if (routing.status === "振り分けた" && owners === "持ち主の Task がすべて終わった") return { ...routing, status: "未振り分け" as const };
  return { ...routing, status: routing.status === "対象外" ? ("未振り分け" as const) : routing.status };
});

type Band = "高い" | "中間" | "低い" | "判断できなかった";

/** 判定 1: 識別子が一致すれば紐づけ、そうでなければ緩めに（中くらいでも）紐づける */
export function linkTo(input: { 識別子: "一致する" | "一致しない"; "関係するかの確率": "高い" | "中くらい" | "低い" | "判断できなかった" }): "紐づける" | "紐づけない" | "判断できなかった" {
  if (input.識別子 === "一致する") return "紐づける";
  if (input["関係するかの確率"] === "判断できなかった") return "判断できなかった";
  return input["関係するかの確率"] === "低い" ? "紐づけない" : "紐づける";
}

/** 判定 2: 寄せ先の完了条件が未定なら、自動では足さずに提案にする */
export function placeWork(input: { "事実が求める作業": "ある" | "ない"; "寄せ先の完了条件": "決まっている" | "未定"; "完了したあとも残るかの確率": Band }):
  | "事実として持つだけ"
  | "計画に足す"
  | "足す提案にする"
  | "新しい Task の候補にする"
  | "判断できなかった" {
  if (input["事実が求める作業"] === "ない") return "事実として持つだけ";
  const p = input["完了したあとも残るかの確率"];
  if (p === "判断できなかった") return "判断できなかった";
  if (p === "高い") return "新しい Task の候補にする";
  if (p === "中間" || input["寄せ先の完了条件"] === "未定") return "足す提案にする";
  return "計画に足す";
}

/** 判定 3: 作業ごとに、確信が高ければ自動で作り、迷えば提案にする */
export function createTask(input: { "行動が要るかの確率": Band }): "自動で Task を作る" | "新しい Task の提案にする" | "作らない" | "判断できなかった" {
  const p = input["行動が要るかの確率"];
  if (p === "高い") return "自動で Task を作る";
  if (p === "中間") return "新しい Task の提案にする";
  if (p === "低い") return "作らない";
  return "判断できなかった";
}
