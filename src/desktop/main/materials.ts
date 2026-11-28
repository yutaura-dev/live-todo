import type { SourceItem } from "../../domain/source-item/source-item.js";
import type { Task } from "../../domain/task/task.js";
import type { FactContent, FactMaterial, TaskMaterial } from "../../llm/shared/materials.js";
import type { FactView } from "../shared/api.js";

// ドメインの Task・事実を、src/llm に渡す材料の形にする（外の人が書いた本文は external にだけ置く）

export const sourceOf = (uri: string) => uri.split("://")[0] ?? "";

export function factContentOf(item: SourceItem): FactContent {
  const kind = item.latest.fact.trusted.find((line) => line.key === "種類")?.value ?? "";
  return {
    source: sourceOf(item.uri),
    kind,
    title: item.latest.title,
    appLines: item.latest.fact.trusted.map((line) => `${line.key}: ${line.value}`),
    external: item.latest.fact.body === "" ? [] : [{ author: item.latest.author ?? "", at: item.latest.sourceUpdatedAt, text: item.latest.fact.body }],
  };
}

export const factMaterialOf = (item: SourceItem): FactMaterial => ({ ...factContentOf(item), id: item.id, url: item.url });

export const taskMaterialOf = (task: Task, facts: ReadonlyArray<SourceItem> = []): TaskMaterial => ({
  id: task.id,
  title: task.title,
  brief: task.brief ?? "",
  status: task.status,
  completion: task.completion,
  due: task.due,
  blocksOthers: task.blocksOthers,
  plan: [],
  facts: facts.map((fact) => ({ id: fact.id, source: sourceOf(fact.uri), kind: factContentOf(fact).kind, title: fact.latest.title })),
});

/** 画面に見せる事実（本文は出さず、アプリが書いた行だけ） */
export const factViewOf = (item: SourceItem): FactView => ({
  id: item.id,
  source: sourceOf(item.uri),
  title: item.latest.title,
  url: item.url,
  lines: item.latest.fact.trusted.map((line) => `${line.key}: ${line.value}`),
  present: item.presence === "あり",
});
