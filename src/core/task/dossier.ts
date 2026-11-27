import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Database } from "../db/database.js";
import { sourceItems, taskLinks, tasks } from "../db/schema.js";
import type { ItemFact, ItemState } from "../source/source-item.js";
import type { LinkRole, TaskStatus } from "./task.js";

export type DossierFact = { source: string; url: string; state: ItemState; trusted: ReadonlyArray<string>; body: string };

/**
 * Task を判断の材料にするときの形（ADR-0019）。trusted はアプリが書いた情報、title・brief・facts[].body は外の人や AI が書いた文。
 * ルールの判定や振り分けで、どちらを信じてよいかを分けて渡すため
 */
export type TaskDossier = {
  id: number;
  title: string;
  brief: string | null;
  trusted: ReadonlyArray<string>;
  facts: ReadonlyArray<DossierFact>;
};

type TaskRow = { id: number; title: string; brief: string | null; status: TaskStatus; recurringTaskId: number | null };
type LinkedItem = { source: string; title: string; url: string; state: ItemState; author: string | null; fact: ItemFact | null };

const ROLE_LINES: Record<LinkRole, string> = { tracks: "紐づき方: この事実の完了が Task の完了を決める", context: "紐づき方: 関連する情報" };

const factOf = (role: LinkRole, item: LinkedItem): DossierFact => {
  // 事実を残す前に取り込んだ Item は、分かっていることだけで代わりにする（タイトルは外の人が書いたものなので本文の側）
  const fact = item.fact ?? { trusted: [`Source: ${item.source}`, ...(item.author === null ? [] : [`作成者: @${item.author}`])], body: `タイトル: ${item.title}` };
  return { source: item.source, url: item.url, state: item.state, trusted: [...fact.trusted, ROLE_LINES[role]], body: fact.body };
};

const originOf = (task: TaskRow, linkCount: number) =>
  task.recurringTaskId !== null ? "定期の Task" : linkCount > 0 ? "届いた事実から作った" : "利用者が手で作った";

export function dossierOf(task: TaskRow, links: ReadonlyArray<{ role: LinkRole; item: LinkedItem }>): TaskDossier {
  return {
    id: task.id,
    title: task.title,
    brief: task.brief,
    trusted: [`状態: ${task.status}`, `作られ方: ${originOf(task, links.length)}`, `紐づく事実の数: ${links.length}`],
    facts: links.map(({ role, item }) => factOf(role, item)),
  };
}

/**
 * Decisions に渡す形。text: false のときは、外の人や AI が書いた文（title・brief・本文）を渡さない。
 * アプリの情報だけで答える問いに、本文の偽の主張（「作成者: dependabot」など）を届かせないため（ADR-0019 の spike）
 */
export function dossierInput(dossier: TaskDossier, options: { text: boolean }) {
  const facts = dossier.facts.map((fact) => ({
    source: fact.source,
    state: fact.state,
    trusted: fact.trusted,
    ...(options.text ? { body: fact.body } : {}),
  }));
  return {
    task: { trusted: dossier.trusted, ...(options.text ? { title: dossier.title, ...(dossier.brief === null ? {} : { brief: dossier.brief }) } : {}) },
    facts,
  };
}

export const loadDossier = Effect.fnUntraced(function* (taskId: number) {
  const db = yield* Database;
  const [task] = yield* db
    .select({ id: tasks.id, title: tasks.title, brief: tasks.brief, status: tasks.status, recurringTaskId: tasks.recurringTaskId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .pipe(Effect.orDie);
  if (task === undefined) return undefined;
  const links = yield* db
    .select({
      role: taskLinks.role,
      source: sourceItems.source,
      title: sourceItems.title,
      url: sourceItems.url,
      state: sourceItems.state,
      author: sourceItems.author,
      fact: sourceItems.fact,
    })
    .from(taskLinks)
    .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
    .where(eq(taskLinks.taskId, taskId))
    .orderBy(asc(taskLinks.id))
    .pipe(Effect.orDie);
  return dossierOf(task, links.map(({ role, ...item }) => ({ role, item })));
});
