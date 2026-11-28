import type { WireTask } from "./model.js";
import { tasks } from "./fixtures.js";
import { blockedPlan, decisionPlan, parallelPlan, straightPlan } from "./plan/plan-fixtures.js";
import type { PlanGroup } from "./plan/plan.js";

/** 完了したときにすること（specs/completion-effect.spec.ts） */
export type EffectView = {
  title: string;
  checked: boolean;
  delivery: "まだ" | "頼んだ" | "書き込んだ" | "書き込めなかった" | "取りやめた";
  addedBy: "AI" | "ユーザー";
  failure?: string;
};

export type TaskDetailData = {
  task: WireTask;
  /** 期日の元の書き方（specs/due-date.value.ts）。なければ null */
  due: string | null;
  /** 計画。まだ立てていなければ null */
  plan: PlanGroup | null;
  /** 事実（Source Item）。lines はアプリが書いた行（specs/snapshot.value.ts の trusted） */
  facts: Array<{ source: string; title: string; lines: string[]; heldByOthers?: number }>;
  effects: EffectView[];
  questions: Array<{ question: string; answer: string | null }>;
  history: Array<{ at: string; by: string; what: string }>;
  /** AI が置いた「定期の Task にしませんか」の下書き */
  recurringDraft?: { title: string; rule: string };
};

const taskOf = (id: number): WireTask => {
  const found = tasks.find((task) => task.id === id);
  if (found === undefined) throw new Error(`fixtures に Task #${id} がない`);
  return found;
};

export const mergeDetail: TaskDetailData = {
  task: taskOf(103),
  due: null,
  plan: straightPlan,
  facts: [{ source: "github", title: "acme/web#482 chore(deps): bump vite", lines: ["種類: PullRequest", "状態: 開いている", "CI: 通った", "あなたへのレビュー依頼: あり"] }],
  effects: [],
  questions: [],
  history: [
    { at: "8:40", by: "AI", what: "Action Item の進み: PR #482 に CI の結果が付く が済んだ" },
    { at: "8:12", by: "AI", what: "今の状況と次の一手 を書いた" },
    { at: "8:02", by: "同期", what: "Task ができた" },
  ],
};

export const decisionDetail: TaskDetailData = {
  task: taskOf(108),
  due: "12 月 7 日まで",
  plan: decisionPlan,
  facts: [{ source: "notion", title: "勉強会 2026 冬 の募集ページ", lines: ["種類: ページ", "締め切り: 12 月 7 日"] }],
  effects: [],
  questions: [{ question: "去年はどんなテーマが多かった？", answer: "ツールの紹介が 6 件、設計の話が 3 件でした。設計の話のほうが質問が多く出ています。" }],
  history: [{ at: "昨日", by: "AI", what: "計画 を立てた" }],
};

export const workingDetail: TaskDetailData = {
  task: taskOf(105),
  due: null,
  plan: parallelPlan,
  facts: [
    { source: "slack", title: "#incident のスレッド", lines: ["種類: スレッド", "あなたへのメンション: あり"] },
    { source: "github", title: "acme/api#902 決済の 500 エラー", lines: ["種類: Issue", "状態: 開いている"], heldByOthers: 1 },
  ],
  effects: [],
  questions: [{ question: "影響を受けたユーザーは何人くらい？", answer: null }],
  history: [{ at: "8:51", by: "AI", what: "AI の作業 を始めた" }],
};

export const waitingDetail: TaskDetailData = {
  task: taskOf(106),
  due: "12 月 5 日まで",
  plan: blockedPlan,
  facts: [{ source: "gmail", title: "【人事】年末調整のお願い", lines: ["種類: スレッド", "未読: なし"] }],
  effects: [],
  questions: [],
  history: [],
  recurringDraft: { title: "年末調整の書類を出す", rule: "毎年 11 月 20 日（7 日前に作る）" },
};

export const undecidedDetail: TaskDetailData = {
  task: taskOf(109),
  due: null,
  plan: null,
  facts: [],
  effects: [],
  questions: [],
  history: [{ at: "9:00", by: "アプリ", what: "優先度 を決められなかった" }],
};

export const awaitingDetail: TaskDetailData = {
  task: { ...taskOf(104), status: "完了待ち", now: [], priority: null },
  due: null,
  plan: null,
  facts: [{ source: "slack", title: "#team-weekly のスレッド", lines: ["種類: スレッド", "あなたの返信: あり"] }],
  effects: [
    { title: "Slack の To-do を完了にする", checked: true, delivery: "まだ", addedBy: "AI" },
    { title: "スレッドに「済み」のリアクションを付ける", checked: true, delivery: "まだ", addedBy: "AI" },
    { title: "カレンダーの予定に出席と返事をする", checked: false, delivery: "まだ", addedBy: "ユーザー" },
  ],
  questions: [],
  history: [{ at: "9:00", by: "ユーザー", what: "列 を 完了待ち にした" }],
};

export const awaitingFailedDetail: TaskDetailData = {
  ...awaitingDetail,
  effects: [
    { title: "Slack の To-do を完了にする", checked: true, delivery: "書き込んだ", addedBy: "AI" },
    { title: "スレッドに「済み」のリアクションを付ける", checked: true, delivery: "書き込めなかった", addedBy: "AI", failure: "Slack のセッションが切れています。設定でつなぎ直してください" },
    { title: "カレンダーの予定に出席と返事をする", checked: false, delivery: "まだ", addedBy: "ユーザー" },
  ],
};
