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

export type PlanIssue =
  | "empty"
  | "url_in_title"
  | "manual_mail_operation"
  | "web_step_without_link"
  | "no_actor"
  | "claude_cannot_write"
  | "human_could_research";

const URL_IN_TITLE = /https?:\/\//;
// アプリのボタンでできるメールの操作（gmail_action・process_mail にすべきもの）
const MAIL_OPERATION = /(ラベル|既読|アーカイブ|ゴミ箱|確認済み)/;
// Web のページを開かないとできない手順
const WEB_STEP = /(開き|開く|ログイン|ページ|画面|ダッシュボード|Search Console|サイト)/;
// 外に書き込む・本人がする操作（Claude Code の手順では読むことと報告しかできない）
const WRITE_STEP = /(返信|送る|送信|投稿|push|merge|マージ|承認|申し込|支払|登録する|変更する|設定する|ログイン|押す|返答|連絡する|コメントする|閉じる|close|作る|直す|修正する|更新する|削除)/i;
// 調べて報告するだけでできる手順
const RESEARCH_STEP = /(調べ|まとめ|洗い出|読み比べ|比較|要約|書き出)/;

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
    if (step.kind === "manual" && step.actor !== undefined && step.actor !== "human" && WRITE_STEP.test(step.title)) issues.add("claude_cannot_write");
    if (step.kind === "manual" && step.actor === "human" && RESEARCH_STEP.test(step.title) && !WRITE_STEP.test(step.title)) issues.add("human_could_research");
  }
  return [...issues];
}

