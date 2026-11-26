import type { NextActionPlan, Step } from "../task/next-actions.js";

/**
 * メールの判定の評価（mail:eval）の採点。expected の either は「どちらでもよい」で、正解率に数えない
 */
export type TriageExpectation = "task" | "none" | "either";
export type TriagePrediction = "task" | "none" | "failed";

export function scoreTriage(cases: ReadonlyArray<{ id: string; expected: TriageExpectation; predicted: TriagePrediction }>) {
  const counted = cases.filter((entry) => entry.expected !== "either");
  const correct = counted.filter((entry) => entry.expected === entry.predicted).length;
  const predictedTasks = counted.filter((entry) => entry.predicted === "task");
  const expectedTasks = counted.filter((entry) => entry.expected === "task");
  const truePositives = predictedTasks.filter((entry) => entry.expected === "task").length;
  const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 1 : Math.round((numerator / denominator) * 1000) / 1000);
  return {
    total: counted.length,
    correct,
    accuracy: ratio(correct, counted.length),
    precision: ratio(truePositives, predictedTasks.length),
    recall: ratio(truePositives, expectedTasks.length),
    missed: expectedTasks.filter((entry) => entry.predicted !== "task").map((entry) => entry.id),
    falseTasks: counted.filter((entry) => entry.expected === "none" && entry.predicted === "task").map((entry) => entry.id),
  };
}

export type PlanIssue = "empty" | "url_in_title" | "manual_mail_operation" | "web_step_without_link" | "no_actor";

const URL_IN_TITLE = /https?:\/\//;
// アプリのボタンでできるメールの操作（gmail_action・process_mail にすべきもの）
const MAIL_OPERATION = /(ラベル|既読|アーカイブ|ゴミ箱|確認済み)/;
// Web のページを開かないとできない手順
const WEB_STEP = /(開き|開く|ログイン|ページ|画面|ダッシュボード|Search Console|サイト)/;

const flatten = (steps: ReadonlyArray<Step>): Step[] =>
  steps.flatMap((step) => (step.kind === "decision" ? [step, ...step.options.flatMap((option) => flatten(option.steps))] : [step]));

// 分かれ道は、選んだあとの手順のどれかに開く先があればよい（ボタンはそこに出る）
const hasLink = (step: Step): boolean => step.link !== undefined || (step.kind === "decision" && step.options.some((option) => option.steps.some(hasLink)));

/** 手順の決まりごとに外れているところ（同じ種類は 1 つにまとめ、見つけた順に返す） */
export function planIssues(plan: NextActionPlan): PlanIssue[] {
  if (plan.steps.length === 0) return ["empty"];
  const issues = new Set<PlanIssue>();
  for (const step of flatten(plan.steps)) {
    if (URL_IN_TITLE.test(step.title)) issues.add("url_in_title");
    if (step.kind === "manual" && MAIL_OPERATION.test(step.title)) issues.add("manual_mail_operation");
    if ((step.kind === "manual" || step.kind === "decision") && WEB_STEP.test(step.title) && !hasLink(step)) issues.add("web_step_without_link");
    if (step.kind === "manual" && step.actor === undefined) issues.add("no_actor");
  }
  return [...issues];
}

