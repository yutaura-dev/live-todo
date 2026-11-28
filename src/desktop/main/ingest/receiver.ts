import { Context, Effect, Layer, Option } from "effect";
import { factChanged } from "../../../domain/routing/routing.js";
import type { SourceItem } from "../../../domain/source-item/source-item.js";
import { receive, type Task } from "../../../domain/task/task.js";
import { arrivalImpactQuestion, interpretArrivalImpact } from "../../../llm/decision/questions/index.js";
import { rewriteTaskWriting } from "../../../llm/generation/writings/index.js";
import { DocumentStore } from "../../../store/document-store.js";
import { type StoreCorrupted, TaskStore } from "../../../store/task-store.js";
import { AiServices } from "../ai/ai-services.js";
import { factMaterialOf, taskMaterialOf } from "../materials.js";
import { Prioritizer } from "../prioritizer.js";
import { routings } from "./router.js";

const agent = { kind: "agent" } as const;
const sync = { kind: "sync" } as const;
const UNSURE = "判定できなかった事実の変化がある。確かめる";

export type ReceiveResult = { changedTaskIds: ReadonlyArray<string>; reroute: boolean };

/**
 * 事実が変わったのを、持ち主の Task が受け取る（task.spec の receive と判断表「届いたものを、どの使い道で Task の言葉にするか」）。
 * まず Decisions で効くかを見て、効くときだけ Generation が書き直す。迷ったら黙って変えず「確かめる」を書く（fail closed）。
 * 持ち主の Task がすべて終わっていたら・対象外にした事実なら、振り分けをやり直す（routing.spec の factChanged）。
 */
export class Receiver extends Context.Service<Receiver, { receive(item: SourceItem): Effect.Effect<ReceiveResult, StoreCorrupted> }>()("live-todo/desktop/Receiver") {
  static readonly layer = Layer.effect(
    Receiver,
    Effect.gen(function* () {
      const tasks = yield* TaskStore;
      const ai = yield* AiServices;
      const prioritizer = yield* Prioritizer;
      const docs = yield* DocumentStore;

      const translate = (task: Task, item: SourceItem, cause: string) =>
        Effect.gen(function* () {
          const decisions = yield* ai.decisions;
          const generation = yield* ai.generation;
          if (Option.isNone(decisions) || Option.isNone(generation)) return null;
          const last = item.history.at(-1);
          const changedLines = (last?.changes ?? []).map((change) => ({
            before: change.before === null ? null : `${change.key ?? change.field}: ${change.before}`,
            after: change.after === null ? null : `${change.key ?? change.field}: ${change.after}`,
          }));
          const lines = last?.kind === "removed" ? [...changedLines, { before: "Source に: ある", after: "Source に: 見えなくなった" }] : changedLines;
          const fact = factMaterialOf(item);
          const asked = yield* decisions.value.ask(arrivalImpactQuestion, { task: taskMaterialOf(task), arrival: "事実が変わった", fact, changedLines: lines });
          const impact = interpretArrivalImpact(asked.answers.impact);
          if (impact === "関係ない") return task;
          if (impact === "迷った") return yield* Effect.orDie(receive(task, agent, "事実", { brief: UNSURE }, cause));
          const written = yield* generation.value.write(rewriteTaskWriting, { task: taskMaterialOf(task), arrival: { kind: "事実が変わった", fact, changedLines: lines, agentOutcome: null } });
          if (written.answer._tag === "Unanswered") return yield* Effect.orDie(receive(task, agent, "事実", { brief: UNSURE }, cause));
          return yield* Effect.orDie(receive(task, agent, "事実", { title: written.answer.value.title, brief: written.answer.value.brief }, cause));
        });

      const receiveItem = (item: SourceItem) =>
        Effect.gen(function* () {
          const routing = yield* routings.find(item.id);
          if (Option.isNone(routing)) return { changedTaskIds: [], reroute: false } as ReceiveResult;
          const owners = (yield* tasks.listForBoard()).filter((task) => task.sourceItemIds.includes(item.id));
          const open = owners.filter((task) => task.status === "やること");
          const next = yield* Effect.orDie(factChanged(routing.value, sync, open.length > 0 ? "開いている Task がある" : "持ち主の Task がすべて終わった"));
          if (next.status !== routing.value.status) {
            yield* routings.save({ ...next, id: item.id });
            return { changedTaskIds: [], reroute: next.status === "未振り分け" } as ReceiveResult;
          }
          if (routing.value.status !== "振り分けた") return { changedTaskIds: [], reroute: false } as ReceiveResult;
          const cause = `activity:${item.id}:${item.history.length - 1}`;
          const changed: string[] = [];
          for (const task of open) {
            if (task.history.some((activity) => activity.cause === cause)) continue;
            // AI に届かなかったら、その Task は今回は受け取らない（次に事実が変わったとき、今の姿で受け取る）
            const after = yield* translate(task, item, cause).pipe(Effect.catchTag("AiUnreachableError", () => Effect.succeed(null)));
            if (after === null || after === task) continue;
            yield* tasks.save(yield* prioritizer.refresh(after));
            changed.push(task.id);
          }
          return { changedTaskIds: changed, reroute: false } as ReceiveResult;
        });

      return Receiver.of({ receive: (item) => receiveItem(item).pipe(Effect.provideService(DocumentStore, docs)) });
    }),
  );
}
