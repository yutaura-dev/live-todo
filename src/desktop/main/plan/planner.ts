import { Context, Effect, Layer, Option } from "effect";
import {
  type ActionItem,
  chooseOption,
  completeItem,
  type Definition,
  type DraftTree,
  fillBranch,
  fromDrafts,
  type How,
  itemsOf,
  type PlanGroup,
  reopenItem,
  skipItem,
} from "../../../domain/plan/plan.js";
import { complete, noteProgress, receive, revisePlan, type Task } from "../../../domain/task/task.js";
import { interpretEffort, itemEffortQuestion } from "../../../llm/decision/questions/index.js";
import { type HowDraft, type ItemDraft, type PlanDraft, planWriting } from "../../../llm/generation/writings/index.js";
import type { Effort } from "../../../llm/shared/vocabulary.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { type StoreCorrupted, TaskStore } from "../../../store/task-store.js";
import type { Reply } from "../../shared/api.js";
import { AiServices } from "../ai/ai-services.js";
import { factMaterialOf, taskMaterialOf } from "../materials.js";
import { Prioritizer } from "../prioritizer.js";
import { TaskIds } from "../task-service.js";
import { WRITE_OPERATIONS } from "../writes/write-provider.js";

export type PlanAction =
  | { readonly _tag: "CompleteItem"; readonly itemId: string }
  | { readonly _tag: "ReopenItem"; readonly itemId: string }
  | { readonly _tag: "SkipItem"; readonly itemId: string }
  | { readonly _tag: "ChooseOption"; readonly itemId: string; readonly option: number };

const agent = { kind: "agent" } as const;
const user = { kind: "user" } as const;
const app = { kind: "app" } as const;
const FAILED = "計画を立てられませんでした。もう一度試すか、確かめてください";

/** 下書きの how を、計画の how にする（場所・待つ見込みは、それぞれの縦の一本で足す） */
const howOf = (how: HowDraft, effortOf: (title: string) => Effort): How => {
  switch (how.type) {
    case "human":
      return { type: "human" };
    case "claude":
      return { type: "claude", tools: how.tools, trigger: how.trigger };
    case "condition":
      return { type: "condition", subjectUri: how.subjectUri, name: how.name, label: how.label };
    case "write":
      return { type: "write", subjectUri: how.subjectUri, operation: how.operation, paramsJson: how.paramsJson, trigger: how.trigger };
    case "decision":
      return {
        type: "decision",
        kind: how.kind,
        question: how.question,
        howToCheck: how.howToCheck,
        options: how.options.map((option) => ({
          label: option.label,
          then: option.then.type === "planned" ? { type: "planned", plan: treeOf(option.then.plan, effortOf) } : option.then,
        })),
      };
  }
};

const isItem = (entry: PlanDraft["items"][number]): entry is ItemDraft => entry.type === "item";
const isGroup = (entry: PlanDraft["items"][number]): entry is PlanDraft => entry.type === "serial" || entry.type === "parallel";

/** 完了したときにすること（completionEffect）は、書き込みの縦の一本で足すので、今は落とす */
function treeOf(draft: PlanDraft, effortOf: (title: string) => Effort): DraftTree {
  return {
    type: draft.type,
    items: draft.items.flatMap((entry): Array<Definition | DraftTree> => {
      if (isGroup(entry)) return [treeOf(entry, effortOf)];
      if (!isItem(entry)) return [];
      return [{ title: entry.title, effort: effortOf(entry.title), due: entry.due, completes: entry.completes, how: howOf(entry.how, effortOf) }];
    }),
  };
}

/** 手間を聞く Action Item（分かれ道は手間を数えないので聞かない。選択肢の先の計画の中も聞く） */
function itemsToRate(draft: PlanDraft): ItemDraft[] {
  return draft.items.flatMap((entry) => {
    if (isGroup(entry)) return itemsToRate(entry);
    if (!isItem(entry)) return [];
    if (entry.how.type !== "decision") return [entry];
    return entry.how.options.flatMap((option) => (option.then.type === "planned" ? itemsToRate(option.then.plan) : []));
  });
}

const summaryOfHow = (how: HowDraft) =>
  how.type === "human" ? "人がやる" : how.type === "claude" ? `Claude Code が${how.tools === "直す" ? "直す" : "調べる"}` : how.type === "write" ? "外へ書き込む" : how.type === "condition" ? "待つ" : "分かれ道";

/** 計画を立て（Generation）、Action Item を進め、完了条件をすべて満たしたら Task を終える */
export class Planner extends Context.Service<
  Planner,
  {
    revise(task: Task): Effect.Effect<Reply<null>, StoreCorrupted>;
    act(taskId: string, action: PlanAction): Effect.Effect<Reply<null>, StoreCorrupted>;
    /** ほかの口（書き込み・Claude Code）が計画を進めたのを反映し、完了条件を満たしたら終える */
    progressed(task: Task, plan: PlanGroup, actor: { readonly kind: "user" } | { readonly kind: "app" } | { readonly kind: "agent" }, target: string): Effect.Effect<Reply<null>, StoreCorrupted>;
  }
>()("live-todo/desktop/Planner") {
  static readonly layer = Layer.effect(
    Planner,
    Effect.gen(function* () {
      const tasks = yield* TaskStore;
      const items = yield* SourceItemStore;
      const ai = yield* AiServices;
      const prioritizer = yield* Prioritizer;
      const ids = yield* TaskIds;

      /** Generation に計画を書かせ、手間を Decisions に聞く。書けなかったら null（AI に届かなかったら AiUnreachableError） */
      const draftPlan = (task: Task, direction: string | null) =>
        Effect.gen(function* () {
          const generation = yield* ai.generation;
          const decisions = yield* ai.decisions;
          if (Option.isNone(generation) || Option.isNone(decisions)) return null;
          const facts = yield* items.findMany(task.sourceItemIds);
          const written = yield* generation.value.write(planWriting, {
            task: taskMaterialOf(task, facts),
            facts: facts.map(factMaterialOf),
            // 書き込めるのは、つないでいる Source の操作だけ（ないものは、人がやる Action Item にさせる）
            catalog: { operations: facts.some((fact) => fact.uri.startsWith("github://")) ? [...WRITE_OPERATIONS] : [], conditions: [] },
            direction,
          });
          if (written.answer._tag === "Unanswered") return null;
          const plan = written.answer.value.plan;
          const efforts = new Map<string, Effort>();
          for (const item of itemsToRate(plan)) {
            const asked = yield* decisions.value.ask(itemEffortQuestion, { task: taskMaterialOf(task, facts), item: { title: item.title, how: summaryOfHow(item.how) } });
            const effort = interpretEffort(asked.answers.effort);
            // 決まらなければ重いほうに倒す（すぐ済むと扱うと、優先度を低く見積もる）
            efforts.set(item.title, effort === "判断できなかった" ? "hard" : effort);
          }
          return treeOf(plan, (title) => efforts.get(title) ?? "easy");
        });

      const saveAndPrioritize = (task: Task) =>
        Effect.gen(function* () {
          yield* tasks.save(task);
          yield* tasks.save(yield* prioritizer.refresh(task));
        });

      const revise = (task: Task) =>
        Effect.gen(function* () {
          const tree = yield* draftPlan(task, null).pipe(Effect.catchTag("AiUnreachableError", () => Effect.succeed(undefined)));
          if (tree === undefined) return { ok: false, reason: "AI に届きませんでした。少し待ってから、もう一度試してください" } as const;
          if (tree === null) {
            yield* saveAndPrioritize(yield* Effect.orDie(receive(task, agent, "事実", { brief: "計画を立てられなかった。確かめる" }, `plan:${task.id}:${task.history.length}`)));
            return { ok: false, reason: FAILED } as const;
          }
          const { plan } = fromDrafts(tree, () => Effect.runSync(ids.next));
          const revised = yield* revisePlan(task, agent, plan).pipe(Effect.option);
          if (Option.isNone(revised)) return { ok: false, reason: "やること のときだけ" } as const;
          yield* saveAndPrioritize(revised.value);
          return { ok: true, value: null } as const;
        });

      /** 完了条件をすべて満たしたら終える。事実から足した項目がまだ残っていれば、自動では閉じない（task.spec の complete） */
      const finishIfSatisfied = (task: Task) =>
        Effect.gen(function* () {
          if (task.completion !== "満たした" || task.status !== "やること" || task.plan === null) return task;
          const addedRemains = itemsOf(task.plan, { activeOnly: true }).some((item: ActionItem) => item.addedFrom !== null && item.status === "まだ");
          const closed = yield* complete(task, app, "完了条件を満たした", { effects: "完了したときにすることがない", added: addedRemains ? "足した項目にまだのものがある" : "足した項目はすべて済んだ" }).pipe(Effect.option);
          return Option.getOrElse(closed, () => task);
        });

      const act = (taskId: string, action: PlanAction) =>
        Effect.gen(function* () {
          const found = yield* tasks.find(taskId);
          if (Option.isNone(found) || found.value.plan === null) return { ok: false, reason: "計画が見つかりません" } as const;
          const task = found.value;
          const plan = task.plan!;
          const nextId = () => Effect.runSync(ids.next);
          const changed = yield* (
            action._tag === "CompleteItem"
              ? completeItem(plan, action.itemId, user)
              : action._tag === "ReopenItem"
                ? reopenItem(plan, action.itemId, user)
                : action._tag === "SkipItem"
                  ? skipItem(plan, action.itemId, user)
                  : chooseOption(plan, action.itemId, action.option, user, nextId)
          ).pipe(Effect.result);
          if (changed._tag === "Failure") return { ok: false, reason: changed.failure.reason } as const;
          let next = changed.success;
          // 選んでから考える選択肢なら、その方針で先の計画を書いて枝に入れる（書けなければ、枝は空のまま完了条件は未定）
          if (action._tag === "ChooseOption") {
            const how = itemsOf(plan).find((item) => item.id === action.itemId)?.definition.how;
            const option = how?.type === "decision" ? how.options[action.option] : undefined;
            if (option?.then.type === "planLater") {
              const tree = yield* draftPlan(task, option.then.direction).pipe(Effect.orElseSucceed(() => null));
              if (tree !== null) next = fillBranch(next, action.itemId, fromDrafts(tree, nextId).plan);
            }
          }
          const progressed = yield* noteProgress(task, user, next, action.itemId).pipe(Effect.option);
          if (Option.isNone(progressed)) return { ok: false, reason: "やること のときだけ" } as const;
          yield* saveAndPrioritize(yield* finishIfSatisfied(progressed.value));
          return { ok: true, value: null } as const;
        });

      const progressed = (task: Task, plan: PlanGroup, actor: { readonly kind: "user" } | { readonly kind: "app" } | { readonly kind: "agent" }, target: string) =>
        Effect.gen(function* () {
          const next = yield* noteProgress(task, actor, plan, target).pipe(Effect.option);
          if (Option.isNone(next)) return { ok: false, reason: "やること のときだけ" } as const;
          yield* saveAndPrioritize(yield* finishIfSatisfied(next.value));
          return { ok: true, value: null } as const;
        });

      return Planner.of({ revise, act, progressed });
    }),
  );
}
