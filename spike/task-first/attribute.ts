import { Effect, Result, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import type { Fact, TaskDossier } from "./model.js";

const NONE = "none";

/** 候補の Task の説明（選択肢の説明）。Task の title と、紐づく事実の要点 */
export const summaryOf = (task: TaskDossier) =>
  [
    `Task: ${task.title}`,
    ...(task.brief === undefined ? [] : [`状況: ${task.brief}`]),
    ...task.facts.slice(0, 4).map((fact) => {
      // URL と PR の番号を入れる（「#205 の件」のような、番号だけの言及を結び付けられなかった）
      const number = fact.url?.match(/\/(?:pull|issues)\/(\d+)/)?.[1];
      const ref = fact.url === undefined ? "" : ` / ${number === undefined ? "" : `#${number} `}${fact.url}`;
      return `- ${fact.trusted.filter((line) => !line.startsWith("あなた（")).join(" / ")}${ref} / ${fact.body.replace(/\s+/g, " ").slice(0, 160)}`;
    }),
  ].join("\n");

export type Attribution = { taskId: string | undefined; probability: number | undefined; role: "tracks" | "context" | undefined; roleProbability: number | undefined; top?: string };

/** 届いた事実が、候補のどの Task についてのものか。どれでもなければ taskId は undefined */
export const attribute = Effect.fnUntraced(function* (fact: Fact, candidates: ReadonlyArray<TaskDossier>) {
  if (candidates.length === 0) return { taskId: undefined, probability: 1, role: undefined, roleProbability: undefined } satisfies Attribution;
  const model = yield* DecisionModel.DecisionModel;
  const criteria: Record<string, string> = Object.fromEntries(candidates.map((task) => [`task_${task.id}`, summaryOf(task)]));
  criteria[NONE] =
    "どの Task の話でもない。同じ人・同じリポジトリ・似た言葉でも、別の PR・別の Issue・別の依頼・別の件・別の障害・別の予定なら、こちら";
  const definition = Decision.make({
    input: Schema.Struct({ source: Schema.String, trusted: Schema.Array(Schema.String), body: Schema.String }),
    decisions: {
      task: Decision.classify({
        instructions:
          "届いた事実（input）は、どの Task についての事実か。同じ仕事（同じ PR・同じ依頼・同じ件）についての続き・関連なら、その Task を選ぶ。言葉が似ているだけで別の仕事なら none を選ぶ。",
        criteria,
      }),
      role: Decision.classify({
        instructions: "届いた事実は、何かの仕事そのもの（PR・Issue・依頼のメッセージ・予定など、その完了が仕事の完了を決めるもの）か、ある仕事についての会話や補足か。",
        criteria: { tracks: "仕事そのもの", context: "仕事についての会話・補足・催促" },
      }),
    },
  });
  const { outcomes } = yield* model.decideSettled(definition, { input: { source: fact.source, trusted: fact.trusted, body: fact.body } });
  if (!Result.isSuccess(outcomes.task)) return { taskId: undefined, probability: undefined, role: undefined, roleProbability: undefined } satisfies Attribution;
  const label = outcomes.task.success.label;
  const role = Result.isSuccess(outcomes.role) ? outcomes.role.success : undefined;
  return {
    taskId: label === NONE ? undefined : label.slice("task_".length),
    probability: outcomes.task.success.probabilities[label],
    top: label,
    role: role?.label as "tracks" | "context" | undefined,
    roleProbability: role === undefined ? undefined : role.probabilities[role.label],
  } satisfies Attribution;
});
