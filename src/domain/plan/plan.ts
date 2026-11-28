import { Effect, Schema } from "effect";
import { Effort } from "../../llm/shared/vocabulary.js";
import { guard } from "../denied.js";
import { DueDate } from "../values.js";

// specs/task.spec.ts の Plan・Branch と specs/action-item.spec.ts の Action Item、action-definition.value.ts の中身

export interface DraftTree {
  readonly type: "serial" | "parallel";
  readonly items: ReadonlyArray<Definition | DraftTree>;
}
export type Option = {
  readonly label: string;
  readonly then: { readonly type: "planned"; readonly plan: DraftTree } | { readonly type: "planLater"; readonly direction: string };
};
export type How =
  | { readonly type: "human" }
  | { readonly type: "claude"; readonly tools: "読むだけ" | "直す"; readonly trigger: "on_request" | "auto" }
  | { readonly type: "condition"; readonly subjectUri: string; readonly name: string; readonly label: string }
  | { readonly type: "write"; readonly subjectUri: string; readonly operation: string; readonly paramsJson: string; readonly trigger: "on_request" | "auto" }
  | {
      readonly type: "decision";
      readonly kind: "確かめる" | "選ぶ";
      readonly question: string;
      readonly howToCheck: string | null;
      readonly options: ReadonlyArray<Option>;
    };
export type Definition = { readonly title: string; readonly effort: Effort; readonly due: DueDate | null; readonly completes: boolean; readonly how: How };
export type ItemStatus = "まだ" | "済んだ" | "やらなくなった";
export type ActionItem = { readonly id: string; readonly status: ItemStatus; readonly definition: Definition; readonly addedFrom: string | null; readonly chosen?: number | null | undefined };
export type PlanNode =
  | { readonly type: "item"; readonly item: ActionItem }
  | { readonly type: "group"; readonly group: PlanGroup }
  | { readonly type: "branch"; readonly decisionId: string; readonly option: string; readonly state: "進めている" | "取りやめた"; readonly plan: PlanGroup | null };
export interface PlanGroup {
  readonly arrangement: "serial" | "parallel";
  readonly nodes: ReadonlyArray<PlanNode>;
}

const suspendedDraft = Schema.suspend((): Schema.Codec<DraftTree> => DraftTreeSchema);
const suspendedGroup = Schema.suspend((): Schema.Codec<PlanGroup> => PlanGroupSchema);
const Trigger = Schema.Literals(["on_request", "auto"]);
const HowSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("human") }),
  Schema.Struct({ type: Schema.Literal("claude"), tools: Schema.Literals(["読むだけ", "直す"]), trigger: Trigger }),
  Schema.Struct({ type: Schema.Literal("condition"), subjectUri: Schema.String, name: Schema.String, label: Schema.String }),
  Schema.Struct({ type: Schema.Literal("write"), subjectUri: Schema.String, operation: Schema.String, paramsJson: Schema.String, trigger: Trigger }),
  Schema.Struct({
    type: Schema.Literal("decision"),
    kind: Schema.Literals(["確かめる", "選ぶ"]),
    question: Schema.String,
    howToCheck: Schema.NullOr(Schema.String),
    options: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        then: Schema.Union([Schema.Struct({ type: Schema.Literal("planned"), plan: suspendedDraft }), Schema.Struct({ type: Schema.Literal("planLater"), direction: Schema.String })]),
      }),
    ),
  }),
]);
export const DefinitionSchema = Schema.Struct({ title: Schema.String, effort: Effort, due: Schema.NullOr(DueDate), completes: Schema.Boolean, how: HowSchema });
const DraftTreeSchema: Schema.Codec<DraftTree> = Schema.Struct({ type: Schema.Literals(["serial", "parallel"]), items: Schema.Array(Schema.Union([DefinitionSchema, suspendedDraft])) });
const ActionItemSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["まだ", "済んだ", "やらなくなった"]),
  definition: DefinitionSchema,
  addedFrom: Schema.NullOr(Schema.String),
  chosen: Schema.optional(Schema.NullOr(Schema.Number)),
});
const PlanNodeSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("item"), item: ActionItemSchema }),
  Schema.Struct({ type: Schema.Literal("group"), group: suspendedGroup }),
  Schema.Struct({ type: Schema.Literal("branch"), decisionId: Schema.String, option: Schema.String, state: Schema.Literals(["進めている", "取りやめた"]), plan: Schema.NullOr(suspendedGroup) }),
]);
export const PlanGroupSchema: Schema.Codec<PlanGroup> = Schema.Struct({ arrangement: Schema.Literals(["serial", "parallel"]), nodes: Schema.Array(PlanNodeSchema) });

export type PlanActor = { readonly kind: "user" } | { readonly kind: "sync" } | { readonly kind: "agent" } | { readonly kind: "scheduler" } | { readonly kind: "app" };
export type Turn = "番が来ている" | "番待ち" | "済んだ" | "やらない";

const isTree = (entry: Definition | DraftTree): entry is DraftTree => "items" in entry;

/** 計画の中身（Generation の下書き・選んだ選択肢の先）から、Action Item の並びを作る */
export function fromDrafts(draft: DraftTree, nextId: () => string, addedFrom: string | null = null): { plan: PlanGroup } {
  const build = (tree: DraftTree): PlanGroup => ({
    arrangement: tree.type,
    nodes: tree.items.map((entry) => (isTree(entry) ? { type: "group", group: build(entry) } : { type: "item", item: { id: nextId(), status: "まだ", definition: entry, addedFrom, chosen: null } })),
  });
  return { plan: build(draft) };
}

const finished = (node: PlanNode): boolean => {
  if (node.type === "item") return node.item.status !== "まだ";
  if (node.type === "group") return node.group.nodes.every(finished);
  if (node.state === "取りやめた") return true;
  return node.plan !== null && node.plan.nodes.every(finished);
};

/** 番を、Action Item ごとに出す（前から順の並びは、まだのものの先頭にだけ。同時の並びは、すべてに） */
export function turnsOf(plan: PlanGroup): Map<string, Turn> {
  const turns = new Map<string, Turn>();
  const walk = (group: PlanGroup, active: boolean) => {
    let open = active;
    for (const node of group.nodes) {
      const here = group.arrangement === "parallel" ? active : open;
      if (node.type === "item") turns.set(node.item.id, node.item.status === "済んだ" ? "済んだ" : node.item.status === "やらなくなった" ? "やらない" : here ? "番が来ている" : "番待ち");
      if (node.type === "group") walk(node.group, here);
      if (node.type === "branch" && node.plan !== null) walk(node.plan, here && node.state === "進めている");
      if (group.arrangement === "serial" && !finished(node)) open = false;
    }
  };
  walk(plan, true);
  return turns;
}

export const turnOf = (plan: PlanGroup, id: string): Turn | undefined => turnsOf(plan).get(id);

export function itemsOf(plan: PlanGroup, options: { activeOnly: boolean } = { activeOnly: false }): ActionItem[] {
  return plan.nodes.flatMap((node) => {
    if (node.type === "item") return [node.item];
    if (node.type === "group") return itemsOf(node.group, options);
    if (options.activeOnly && node.state === "取りやめた") return [];
    return node.plan === null ? [] : itemsOf(node.plan, options);
  });
}

const findItem = (plan: PlanGroup, id: string) => itemsOf(plan).find((item) => item.id === id);

const mapItems = (plan: PlanGroup, change: (item: ActionItem) => ActionItem): PlanGroup => ({
  ...plan,
  nodes: plan.nodes.map((node) => {
    if (node.type === "item") return { ...node, item: change(node.item) };
    if (node.type === "group") return { ...node, group: mapItems(node.group, change) };
    return node.plan === null ? node : { ...node, plan: mapItems(node.plan, change) };
  }),
});

const setStatus = (plan: PlanGroup, id: string, status: ItemStatus, chosen?: number) =>
  mapItems(plan, (item) => (item.id === id ? { ...item, status, ...(chosen === undefined ? {} : { chosen }) } : item));

/** 完了条件の状態を、計画から導く（task.spec の Completion） */
export function completionOf(plan: PlanGroup | null): "未定" | "まだ" | "満たした" {
  if (plan === null) return "未定";
  let undetermined = false;
  let pending = false;
  let criteria = 0;
  const walk = (group: PlanGroup) => {
    for (const node of group.nodes) {
      if (node.type === "group") walk(node.group);
      if (node.type === "branch") {
        if (node.state === "取りやめた") continue;
        if (node.plan === null) undetermined = true;
        else walk(node.plan);
      }
      if (node.type !== "item") continue;
      const { item } = node;
      if (item.definition.how.type === "decision" && item.status === "まだ") {
        for (const option of item.definition.how.options) {
          if (option.then.type === "planLater") undetermined = true;
          else if (draftHasCriteria(option.then.plan)) {
            criteria += 1;
            pending = true;
          }
        }
      }
      if (item.definition.completes && item.status !== "やらなくなった") {
        criteria += 1;
        if (item.status === "まだ") pending = true;
      }
    }
  };
  walk(plan);
  if (undetermined || criteria === 0) return "未定";
  return pending ? "まだ" : "満たした";
}

const draftHasCriteria = (tree: DraftTree): boolean => tree.items.some((entry) => (isTree(entry) ? draftHasCriteria(entry) : entry.completes));

const fulfilledByHand = (item: ActionItem) => item.definition.how.type === "human" || item.definition.how.type === "claude";

export const completeItem = Effect.fn("Plan.completeItem")(function* (plan: PlanGroup, id: string, actor: PlanActor) {
  const ensure = guard("action-item", "complete");
  const item = findItem(plan, id);
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(item?.status === "まだ", "まだのときだけ");
  yield* ensure(turnOf(plan, id) === "番が来ている", "番が来ているときだけ");
  yield* ensure(item !== undefined && fulfilledByHand(item), "人か Claude Code が果たす Action Item だけ");
  return setStatus(plan, id, "済んだ");
});

export const reopenItem = Effect.fn("Plan.reopenItem")(function* (plan: PlanGroup, id: string, actor: PlanActor) {
  const ensure = guard("action-item", "reopen");
  const item = findItem(plan, id);
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(item?.status === "済んだ", "済んだときだけ");
  yield* ensure(item !== undefined && fulfilledByHand(item), "人か Claude Code が果たす Action Item だけ");
  return setStatus(plan, id, "まだ");
});

export const skipItem = Effect.fn("Plan.skipItem")(function* (plan: PlanGroup, id: string, actor: PlanActor) {
  const ensure = guard("action-item", "skip");
  yield* ensure(actor.kind === "user" || actor.kind === "sync" || actor.kind === "agent", "ユーザーか同期か AI だけ");
  yield* ensure(findItem(plan, id)?.status === "まだ", "まだのときだけ");
  return setStatus(plan, id, "やらなくなった");
});

/** 分かれ道で選ぶ。先の計画が決まっていれば、その中身から Action Item を作って、分かれ道のすぐ後ろに枝として差し込む */
export const chooseOption = Effect.fn("Plan.chooseOption")(function* (plan: PlanGroup, id: string, optionIndex: number, actor: PlanActor, nextId: () => string) {
  const ensure = guard("action-item", "choose");
  const item = findItem(plan, id);
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(item?.status === "まだ", "まだのときだけ");
  yield* ensure(turnOf(plan, id) === "番が来ている", "番が来ているときだけ");
  const how = item?.definition.how;
  if (how?.type !== "decision") return yield* guard("action-item", "choose")(false, "分かれ道だけ").pipe(Effect.as(plan));
  const option = how.options[optionIndex];
  if (option === undefined) return yield* guard("action-item", "choose")(false, "選択肢から選ぶときだけ").pipe(Effect.as(plan));
  const branch: PlanNode = {
    type: "branch",
    decisionId: id,
    option: option.label,
    state: "進めている",
    plan: option.then.type === "planned" ? fromDrafts(option.then.plan, nextId).plan : null,
  };
  const insert = (group: PlanGroup): PlanGroup => ({
    ...group,
    nodes: group.nodes.flatMap((node): PlanNode[] => {
      if (node.type === "item") return node.item.id === id ? [{ ...node, item: { ...node.item, status: "済んだ", chosen: optionIndex } }, branch] : [node];
      if (node.type === "group") return [{ ...node, group: insert(node.group) }];
      return [node.plan === null ? node : { ...node, plan: insert(node.plan) }];
    }),
  });
  return insert(plan);
});

/** 選んでから考える枝に、Generation が考えた先の計画を入れる */
export const fillBranch = (plan: PlanGroup, decisionId: string, filled: PlanGroup): PlanGroup => ({
  ...plan,
  nodes: plan.nodes.map((node) => {
    if (node.type === "branch") return node.decisionId === decisionId && node.plan === null ? { ...node, plan: filled } : node.plan === null ? node : { ...node, plan: fillBranch(node.plan, decisionId, filled) };
    if (node.type === "group") return { ...node, group: fillBranch(node.group, decisionId, filled) };
    return node;
  }),
});

/** 事実から計画に Action Item を足す（計画の最後に並べる。どの事実から足したかを持つ） */
export const appendItem = (plan: PlanGroup, item: ActionItem): PlanGroup => ({ ...plan, nodes: [...plan.nodes, { type: "item", item }] });

/** 計画を立て直すときに、前の計画のまだの Action Item をやらなくする（済んだものは消さない） */
export const retire = (plan: PlanGroup): PlanGroup => mapItems(plan, (item) => (item.status === "まだ" ? { ...item, status: "やらなくなった" } : item));
