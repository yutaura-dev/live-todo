import type { ActionItem } from "./action-item.spec.ts";
import type { CompletionEffect } from "./completion-effect.spec.ts";
import type { Task } from "./task.spec.ts";

/**
 * Task と、その計画の中の Action Item・完了したときにすること。どちらも Task を通してだけ扱い、Task と一緒に変わる。
 * Task がいつ終わるか・AI が作業中か・Action Item に番が来たかは、Task の計画と Action Item の状態を一緒に見て決まる。
 */
export const displayName = "Task";
export const root = "task";
export const entities = ["action-item", "completion-effect"];

const isRunning = (item: ActionItem) => item.progress.type === "claude" && item.progress.run === "やっている";

export const invariants = {
  "書き込みを頼んで結果を待っている完了したときにすることは、完了待ちの Task にだけある": (task: Task, _items: ReadonlyArray<ActionItem>, effects: ReadonlyArray<CompletionEffect>) =>
    task.status === "完了待ち" || effects.every((effect) => effect.delivery !== "頼んだ"),
  "やらないことにした Task には、まだ書き込むかもしれない完了したときにすることがない": (task: Task, _items: ReadonlyArray<ActionItem>, effects: ReadonlyArray<CompletionEffect>) =>
    task.closure?.outcome !== "dismissed" || effects.every((effect) => effect.delivery === "書き込んだ" || effect.delivery === "取りやめた" || !effect.checked),
  "やり終えた（done）Task には、☑ が付いたまま書き込んでいない完了したときにすることがない（すべて書き込めた・外されてから終わる）": (task: Task, _items: ReadonlyArray<ActionItem>, effects: ReadonlyArray<CompletionEffect>) =>
    task.closure?.outcome !== "done" || effects.every((effect) => effect.delivery === "書き込んだ" || effect.delivery === "取りやめた" || !effect.checked),
  "Claude Code がやっている Action Item があれば、Task は AI が作業中": (task: Task, items: ReadonlyArray<ActionItem>) => !items.some(isRunning) || task.work === "作業中",
  "完了条件を満たした Task では、完了条件の Action Item がすべて果たされている（まだ選んでいない分かれ道は、すべての枝で）": (task: Task, items: ReadonlyArray<ActionItem>) =>
    task.completion !== "満たした" || items.filter((item) => item.definition.completes).every((item) => item.status === "done"),
  "完了条件が決まった Task には、完了条件の Action Item が 1 つ以上ある": (task: Task, items: ReadonlyArray<ActionItem>) =>
    task.completion === "未定" || items.some((item) => item.definition.completes),
  "終わった Task には、Claude Code がやっている Action Item がない": (task: Task, items: ReadonlyArray<ActionItem>) => task.status !== "closed" || !items.some(isRunning),
  "やらないことにした Task には、まだの Action Item がない": (task: Task, items: ReadonlyArray<ActionItem>) =>
    task.closure?.outcome !== "dismissed" || items.every((item) => item.status !== "todo"),
};
