import type { Fact, TaskDossier } from "./model.js";

const URL_PATTERN = /https?:\/\/[^\s)>」』"]+/g;

/** 事実の本文と URL に出てくる URL（末尾の句読点を除く） */
export const urlsOf = (fact: Fact) =>
  new Set([...(fact.url === undefined ? [] : [fact.url]), ...(fact.body.match(URL_PATTERN) ?? [])].map((url) => url.replace(/[.,、。]+$/, "")));

/** 識別子で決まる Task（事実の URL が、その Task に紐づく事実の URL と同じ）。AI を使わない */
export function linkByIdentifier(fact: Fact, tasks: ReadonlyArray<TaskDossier>): TaskDossier | undefined {
  const mine = urlsOf(fact);
  const hits = tasks.filter((task) => task.facts.some((other) => other.url !== undefined && mine.has(other.url)));
  // 2 つ以上の Task に当たるなら決めない（AI に選ばせる）
  return hits.length === 1 ? hits[0] : undefined;
}

const tokens = (text: string) => {
  const words = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.\-/]+|[\p{Script=Han}\p{Script=Katakana}ー]{2,}/gu)) words.add(match[0]);
  return words;
};

const peopleOf = (fact: Fact) => new Set([...fact.trusted.join("\n").matchAll(/@[\w.\-\[\]]+/g), ...fact.body.matchAll(/@[\w.\-\[\]]+/g)].map((m) => m[0].toLowerCase()));
const reposOf = (fact: Fact) => new Set([...fact.trusted.join("\n").matchAll(/リポジトリ: (\S+)/g), ...fact.body.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)].map((m) => m[1]!.toLowerCase()));

/** 候補の Task を、事実との重なりの点数が高い順に並べる。点数が 0 の Task は候補にしない */
export function candidatesFor(fact: Fact, tasks: ReadonlyArray<TaskDossier>, limit = 5): TaskDossier[] {
  const factWords = tokens(`${fact.body}`);
  const factPeople = peopleOf(fact);
  const factRepos = reposOf(fact);
  const factUrls = urlsOf(fact);
  const scored = tasks.map((task) => {
    const taskWords = tokens([task.title, task.brief ?? "", ...task.facts.map((f) => f.body)].join("\n"));
    const taskPeople = new Set(task.facts.flatMap((f) => [...peopleOf(f)]));
    const taskRepos = new Set(task.facts.flatMap((f) => [...reposOf(f)]));
    const taskUrls = new Set(task.facts.flatMap((f) => [...urlsOf(f)]));
    let score = 0;
    for (const url of factUrls) if (taskUrls.has(url)) score += 10;
    for (const word of factWords) if (taskWords.has(word)) score += 1;
    // 自分のアカウント名はどの Task にも出てくるので数えない
    for (const person of factPeople) if (person !== "@yutaura" && taskPeople.has(person)) score += 2;
    for (const repo of factRepos) if (taskRepos.has(repo)) score += 1;
    return { task, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.task);
}

/** それ自体が 1 つの仕事になる事実（PR・Issue） */
export const isWorkItem = (fact: Fact) => fact.trusted.some((line) => /^種類: GitHub の (PullRequest|Issue)$/.test(line));

/**
 * AI で紐づけてよい候補に絞る。PR・Issue は、すでに別の PR・Issue を追っている Task には AI で紐づけない（URL で決まるときだけ）。
 * 同じ人・同じリポジトリの別の PR を、似ているというだけで 1 つの Task に混ぜたため（spike の neg-1）
 */
export function aiEligible(fact: Fact, tasks: ReadonlyArray<TaskDossier>): TaskDossier[] {
  if (!isWorkItem(fact)) return [...tasks];
  return tasks.filter((task) => !task.facts.some((other) => isWorkItem(other) && other.url !== fact.url));
}
