import { Context, Effect, Layer, Option, Schema } from "effect";
import { TaskProposal, propose } from "../../../domain/proposal/task-proposal.js";
import { createTask, linkTo, placeWork, Routing, route, startRouting } from "../../../domain/routing/routing.js";
import type { SourceItem } from "../../../domain/source-item/source-item.js";
import { attachFact, create, type Task } from "../../../domain/task/task.js";
import type { DecisionResult } from "../../../llm/decision/decisions.js";
import {
  factBelongsToTaskQuestion,
  factRequestsWorkQuestion,
  routingBand,
  workNeedsNewActionQuestion,
  workOutlivesTaskQuestion,
} from "../../../llm/decision/questions/index.js";
import { extractWorkWriting, proposalReasonWriting, taskDraftWriting } from "../../../llm/generation/writings/index.js";
import type { Work } from "../../../llm/shared/materials.js";
import type { CallRecord } from "../../../llm/shared/record.js";
import { DocumentStore, documentsOf } from "../../../store/document-store.js";
import type { StoreCorrupted } from "../../../store/task-store.js";
import { TaskStore } from "../../../store/task-store.js";
import { AiServices } from "../ai/ai-services.js";
import { factContentOf, factMaterialOf, taskMaterialOf } from "../materials.js";
import { Prioritizer } from "../prioritizer.js";
import { TaskIds } from "../task-service.js";

export const routings = documentsOf("routing", Schema.Struct({ ...Routing.fields, id: Schema.String }));
export const proposals = documentsOf("proposal", TaskProposal);

const agent = { kind: "agent" } as const;
const sync = { kind: "sync" } as const;

/** 振り分けで決めたこと（AI を呼び終えてから、まとめて書く） */
type Plan = {
  links: Task[];
  create: Array<{ title: string; brief: string; due: Work["due"] }>;
  propose: Array<{ kind: "新しい Task" | "既存の Task に足す"; title: string; brief: string; targetTaskId: string | null }>;
  undecided: boolean;
  records: CallRecord[];
};

const summaryOf = (records: ReadonlyArray<CallRecord>) =>
  records
    .map((record) => {
      const probabilities = Object.values(record.answers).map((answer) => (answer._tag === "Answered" ? Object.values(answer.probabilities).map((p) => p.toFixed(2)).join("/") : answer.reason));
      return `${record.purpose} v${record.version} ${probabilities.join(",")}`.trim();
    })
    .join("・");

export type RouteResult = { status: Routing["status"]; changedTaskIds: ReadonlyArray<string> };

/**
 * 届いた事実を振り分ける（routing.spec の判断表 1〜3）。開いている Task には緩めに紐づけ、作業は既存の Task で受ける方に倒し、迷ったら提案にする（ADR-0025）。
 * AI に届かなかったら何も書かずに未振り分けのまま返す（次の同期でやり直す）。答えなかったら、ユーザー待ちにする（fail closed）。
 */
export class Router extends Context.Service<Router, { route(item: SourceItem): Effect.Effect<RouteResult, StoreCorrupted> }>()("live-todo/desktop/Router") {
  static readonly layer = Layer.effect(
    Router,
    Effect.gen(function* () {
      const tasks = yield* TaskStore;
      const ai = yield* AiServices;
      const prioritizer = yield* Prioritizer;
      const ids = yield* TaskIds;
      const docs = yield* DocumentStore;

      const decide = (item: SourceItem, open: ReadonlyArray<Task>) =>
        Effect.gen(function* () {
          const decisionsOption = yield* ai.decisions;
          const generationOption = yield* ai.generation;
          if (Option.isNone(decisionsOption) || Option.isNone(generationOption)) return null;
          const decisions = decisionsOption.value;
          const generation = generationOption.value;
          const plan: Plan = { links: [], create: [], propose: [], undecided: false, records: [] };
          const noted = <D extends Record<string, never>>(result: DecisionResult<D> | { record: CallRecord }) => {
            plan.records.push(result.record);
            return result;
          };
          const fact = factMaterialOf(item);

          // 判定 1: 開いている Task ごとに、緩めに紐づける（識別子が一致するものは、もう持っている）
          for (const task of open) {
            if (task.sourceItemIds.includes(item.id)) {
              plan.links.push(task);
              continue;
            }
            const result = yield* decisions.ask(factBelongsToTaskQuestion, { fact, task: taskMaterialOf(task) });
            noted(result as never);
            const band = routingBand(factBelongsToTaskQuestion, result.answers.belongs);
            const decided = linkTo({ 識別子: "一致しない", 関係するかの確率: band === "中間" ? "中くらい" : band });
            if (decided === "紐づける") plan.links.push(task);
            if (decided === "判断できなかった") plan.undecided = true;
          }

          // 作業を求めない事実は、切り出しを呼ばずに持たせるだけ（迷ったときは切り出して確かめる）
          const asks = yield* decisions.ask(factRequestsWorkQuestion, { fact: factContentOf(item) });
          noted(asks as never);
          if (routingBand(factRequestsWorkQuestion, asks.answers.requestsWork) === "低い") return plan;

          const extracted = yield* generation.write(extractWorkWriting, { fact, linkedTasks: plan.links.map((task) => taskMaterialOf(task)) });
          plan.records.push(extracted.record);
          if (extracted.answer._tag === "Unanswered") return { ...plan, undecided: true };

          for (const work of extracted.answer.value.works) {
            // 判定 2: 紐づけた Task ごとに、完了条件を満たしたあとも残るかで、その Task で受けるかを決める
            let placed = false;
            for (const task of plan.links) {
              const outlives = yield* decisions.ask(workOutlivesTaskQuestion, { work, task: taskMaterialOf(task) });
              noted(outlives as never);
              const placement = placeWork({
                事実が求める作業: "ある",
                寄せ先の完了条件: task.completion === "未定" ? "未定" : "決まっている",
                完了したあとも残るかの確率: routingBand(workOutlivesTaskQuestion, outlives.answers.outlives),
              });
              if (placement === "計画に足す") placed = true;
              if (placement === "判断できなかった") plan.undecided = true;
              if (placement === "足す提案にする") {
                const reason = yield* generation.write(proposalReasonWriting, { kind: "計画に足す", work, facts: [fact], target: taskMaterialOf(task) });
                plan.records.push(reason.record);
                plan.propose.push({ kind: "既存の Task に足す", title: work.title, brief: reason.answer._tag === "Answered" ? reason.answer.value.brief : work.detail, targetTaskId: task.id });
                placed = true;
              }
              if (placed) break;
            }
            if (placed) continue;

            // 判定 3: どの Task にも入らない作業ごとに、確信が高ければ作り、迷えば提案にする（識別子は渡さない）
            const needs = yield* decisions.ask(workNeedsNewActionQuestion, { work, fact: factContentOf(item) });
            noted(needs as never);
            const decision = createTask({ 行動が要るかの確率: routingBand(workNeedsNewActionQuestion, needs.answers.needsAction) });
            if (decision === "判断できなかった") plan.undecided = true;
            if (decision === "作らない" || decision === "判断できなかった") continue;
            const draft = yield* generation.write(taskDraftWriting, { work, facts: [fact] });
            plan.records.push(draft.record);
            const drafted = draft.answer._tag === "Answered" ? draft.answer.value : { title: work.title, brief: work.detail, due: work.due };
            if (decision === "自動で Task を作る") {
              plan.create.push(drafted);
              continue;
            }
            const reason = yield* generation.write(proposalReasonWriting, { kind: "新しい Task", work, facts: [fact], target: null });
            plan.records.push(reason.record);
            plan.propose.push({ kind: "新しい Task", title: drafted.title, brief: reason.answer._tag === "Answered" ? reason.answer.value.brief : drafted.brief, targetTaskId: null });
          }
          return plan;
        });

      const apply = (item: SourceItem, routing: Routing, plan: Plan) =>
        Effect.gen(function* () {
          const changed: string[] = [];
          const judgment = summaryOf(plan.records);
          for (const task of plan.links) {
            yield* tasks.save(yield* Effect.orDie(attachFact(task, agent, item.id)));
            changed.push(task.id);
          }
          for (const draft of plan.create) {
            const task = yield* Effect.orDie(create({ id: yield* ids.next, title: draft.title, brief: draft.brief, due: draft.due, actor: agent, origin: "事実から自動で作った", sourceItemIds: [item.id] }));
            // 優先度の決まり方は Task を指すので、Task を先に保存する
            yield* tasks.save(task);
            yield* tasks.save(yield* prioritizer.refresh(task));
            changed.push(task.id);
          }
          for (const proposal of plan.propose) {
            yield* proposals.save(yield* Effect.orDie(propose({ id: yield* ids.next, ...proposal, sourceItemId: item.id, judgment }, agent)));
          }
          const outcome =
            plan.create.length > 0
              ? "新しい Task を作る"
              : plan.propose.length > 0
                ? "提案にする"
                : plan.undecided
                  ? "判断できなかった"
                  : plan.links.length > 0
                    ? "既存の Task の事実にする"
                    : "対象外";
          const next = yield* Effect.orDie(route(routing, agent, outcome, judgment));
          yield* routings.save({ ...next, id: item.id });
          return { status: next.status, changedTaskIds: changed };
        });

      const routeItem = (item: SourceItem) =>
        Effect.gen(function* () {
          const found = yield* routings.find(item.id);
          const routing = Option.isSome(found) ? found.value : yield* Effect.orDie(startRouting(item.id, sync));
          if (Option.isNone(found)) yield* routings.save({ ...routing, id: item.id });
          if (routing.status !== "未振り分け") return { status: routing.status, changedTaskIds: [] } as RouteResult;
          const open = (yield* tasks.listForBoard()).filter((task) => task.status === "やること");
          const plan = yield* decide(item, open).pipe(Effect.catchTag("AiUnreachableError", () => Effect.succeed(null)));
          if (plan === null) return { status: "未振り分け", changedTaskIds: [] } as RouteResult;
          return yield* apply(item, routing, plan);
        });

      return Router.of({ route: (item) => routeItem(item).pipe(Effect.provideService(DocumentStore, docs)) });
    }),
  );
}
