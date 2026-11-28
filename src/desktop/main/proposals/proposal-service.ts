import { Context, Effect, Layer, Option } from "effect";
import { accept, decline } from "../../../domain/proposal/task-proposal.js";
import { routeByUser } from "../../../domain/routing/routing.js";
import { attachFact, create } from "../../../domain/task/task.js";
import { DocumentStore } from "../../../store/document-store.js";
import { SourceItemStore } from "../../../store/source-item-store.js";
import { type StoreCorrupted, TaskStore } from "../../../store/task-store.js";
import type { FactView, ProposalView, Reply } from "../../shared/api.js";
import { proposals, routings } from "../ingest/router.js";
import { factViewOf } from "../materials.js";
import { Prioritizer } from "../prioritizer.js";
import { TaskIds } from "../task-service.js";
import { Planner } from "../plan/planner.js";

const user = { kind: "user" } as const;


export type FactRouting = { _tag: "NewTask" } | { _tag: "Ignore" } | { _tag: "AttachTo"; taskId: string };

/** 提案を受け入れる・見送る、AI が決められなかった事実をユーザーが振り分ける */
export class ProposalService extends Context.Service<
  ProposalService,
  {
    list(): Effect.Effect<ReadonlyArray<ProposalView>, StoreCorrupted>;
    undecided(): Effect.Effect<ReadonlyArray<FactView>, StoreCorrupted>;
    accept(id: string): Effect.Effect<Reply<{ taskId: string }>, StoreCorrupted>;
    decline(id: string): Effect.Effect<Reply<null>, StoreCorrupted>;
    routeFact(sourceItemId: string, to: FactRouting): Effect.Effect<Reply<{ taskId: string | null }>, StoreCorrupted>;
  }
>()("live-todo/desktop/ProposalService") {
  static readonly layer = Layer.effect(
    ProposalService,
    Effect.gen(function* () {
      const tasks = yield* TaskStore;
      const items = yield* SourceItemStore;
      const prioritizer = yield* Prioritizer;
      const ids = yield* TaskIds;
      const docs = yield* DocumentStore;
      const planner = yield* Planner;

      const newTask = (input: { title: string; brief: string | null; sourceItemIds: ReadonlyArray<string>; origin: "提案を受け入れた" | "手で足した" }) =>
        Effect.gen(function* () {
          const task = yield* Effect.orDie(create({ id: yield* ids.next, title: input.title, brief: input.brief, actor: user, origin: input.origin, sourceItemIds: input.sourceItemIds }));
          yield* tasks.save(task);
          yield* tasks.save(yield* prioritizer.refresh(task));
          // 受け入れた Task は、計画を立てる（立てられなくても Task は残り、完了条件は未定のまま）
          if (input.origin === "提案を受け入れた") yield* planner.revise(Option.getOrElse(yield* tasks.find(task.id), () => task));
          return task.id;
        });

      const attachTo = (taskId: string, sourceItemIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const found = yield* tasks.find(taskId);
          if (Option.isNone(found)) return false;
          let task = found.value;
          for (const id of sourceItemIds) {
            const attached = yield* attachFact(task, user, id).pipe(Effect.option);
            if (Option.isNone(attached)) return false;
            task = attached.value;
          }
          yield* tasks.save(task);
          return true;
        });

      const list = () =>
        Effect.gen(function* () {
          const all = (yield* proposals.all()).filter((p) => p.status === "提案中" || p.status === "見送った");
          return yield* Effect.forEach(all, (p) =>
            Effect.gen(function* () {
              const facts = yield* items.findMany(p.sourceItemIds);
              const target = p.targetTaskId === null ? Option.none() : yield* tasks.find(p.targetTaskId);
              return {
                id: p.id,
                status: p.status,
                kind: p.kind,
                title: p.title,
                brief: p.brief,
                targetTaskId: p.targetTaskId,
                targetTitle: Option.isSome(target) ? target.value.title : null,
                facts: facts.map(factViewOf),
                createdAt: p.createdAt,
              } as ProposalView;
            }),
          );
        });

      const undecided = () =>
        Effect.gen(function* () {
          const waiting = (yield* routings.all()).filter((r) => r.status === "ユーザー待ち");
          return (yield* items.findMany(waiting.map((r) => r.sourceItemId))).map(factViewOf);
        });

      const acceptOne = (id: string) =>
        Effect.gen(function* () {
          const found = yield* proposals.find(id);
          if (Option.isNone(found)) return { ok: false, reason: "提案が見つかりません" } as const;
          const accepted = yield* accept(found.value, user).pipe(Effect.option);
          if (Option.isNone(accepted)) return { ok: false, reason: "提案中のときだけ" } as const;
          const proposal = found.value;
          let taskId: string;
          if (proposal.kind === "新しい Task" || proposal.targetTaskId === null) {
            taskId = yield* newTask({ title: proposal.title, brief: proposal.brief, sourceItemIds: proposal.sourceItemIds, origin: "提案を受け入れた" });
          } else {
            if (!(yield* attachTo(proposal.targetTaskId, proposal.sourceItemIds))) return { ok: false, reason: "寄せ先の Task が、もう開いていません" } as const;
            taskId = proposal.targetTaskId;
          }
          yield* proposals.save(accepted.value);
          return { ok: true, value: { taskId } } as const;
        });

      const declineOne = (id: string) =>
        Effect.gen(function* () {
          const found = yield* proposals.find(id);
          if (Option.isNone(found)) return { ok: false, reason: "提案が見つかりません" } as const;
          const declined = yield* decline(found.value, user).pipe(Effect.option);
          if (Option.isNone(declined)) return { ok: false, reason: "提案中のときだけ" } as const;
          yield* proposals.save(declined.value);
          return { ok: true, value: null } as const;
        });

      const routeFact = (sourceItemId: string, to: FactRouting) =>
        Effect.gen(function* () {
          const routing = yield* routings.find(sourceItemId);
          const item = yield* items.find(sourceItemId);
          if (Option.isNone(routing) || Option.isNone(item)) return { ok: false, reason: "事実が見つかりません" } as const;
          const outcome = to._tag === "Ignore" ? "対象外" : to._tag === "NewTask" ? "新しい Task を作る" : "既存の Task の事実にする";
          const next = yield* routeByUser(routing.value, user, outcome).pipe(Effect.option);
          if (Option.isNone(next)) return { ok: false, reason: "自動の振り分けのあとだけ" } as const;
          let taskId: string | null = null;
          if (to._tag === "NewTask") taskId = yield* newTask({ title: item.value.latest.title, brief: null, sourceItemIds: [sourceItemId], origin: "手で足した" });
          if (to._tag === "AttachTo") {
            if (!(yield* attachTo(to.taskId, [sourceItemId]))) return { ok: false, reason: "その Task は、もう開いていません" } as const;
            taskId = to.taskId;
          }
          yield* routings.save({ ...next.value, id: sourceItemId });
          return { ok: true, value: { taskId } } as const;
        });

      const withDocs = <A, E>(effect: Effect.Effect<A, E, DocumentStore>) => Effect.provideService(effect, DocumentStore, docs);
      return ProposalService.of({
        list: () => withDocs(list()),
        undecided: () => withDocs(undecided()),
        accept: (id) => withDocs(acceptOne(id)),
        decline: (id) => withDocs(declineOne(id)),
        routeFact: (id, to) => withDocs(routeFact(id, to)),
      });
    }),
  );
}
