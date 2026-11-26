import type { CardJudgment, TaskDetailChange } from "../../shared/api.js";

const STATUS_LABELS: Record<string, string> = {
  needs_review: "要確認",
  todo: "Todo",
  in_progress: "進行中",
  done: "完了",
  dismissed: "削除済み",
  archived: "元の項目が消えた",
  agent_running: "AI が調査中",
};

const CONCLUSION_LABELS: Record<string, string> = {
  mergeable: "merge 可能",
  mergeable_after_fix: "修正すれば merge 可能",
  not_mergeable: "merge できない",
};

export const conclusionLabel = (conclusion: string) => CONCLUSION_LABELS[conclusion] ?? conclusion;

const FIELD_LABELS: Record<string, string> = { status: "ステータス", title: "タイトル", brief: "今の状況" };
const ACTOR_LABELS: Record<string, string> = { user: "あなたが", sync: "同期で", agent: "AI が", filter: "フィルタで" };

const METHOD_LABELS: Record<string, string> = { rule: "規則で決まった", decisions: "OpenAI Decisions", structured: "LLM" };

/** 判定の結果を 1 行で。確率や理由があれば方法に続けて書く */
export function judgmentText(judgment: CardJudgment): string {
  const method = METHOD_LABELS[judgment.method] ?? judgment.method;
  if (judgment.probability !== undefined) return `${method}・自分の対応が要る確率 ${Math.round(judgment.probability * 100)}%`;
  if (judgment.reason !== undefined) return `${method}・${judgment.reason}`;
  return method;
}

/** "タイトル（owner/repo）" をタイトルとリポジトリに分ける */
export function splitTitle(title: string): { main: string; repository?: string } {
  const match = /^(.*)（([^（）\s]+\/[^（）\s]+)）$/.exec(title);
  return match ? { main: match[1]!, repository: match[2]! } : { main: title };
}

const EFFORT_LABELS: Record<string, string> = { easy: "簡単", normal: "普通", hard: "難しい", tedious: "めんどくさい" };
export const effortLabel = (effort: string) => EFFORT_LABELS[effort] ?? effort;

/** Task の番号。作られた順の連番（id）を、GitHub の issue のように #42 と書く */
export const taskNumber = (id: number) => `#${id}`;

export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;

const valueText = (field: string | null, value: unknown) => {
  if (value === null || value === undefined) return "（なし）";
  if (field === "status" && typeof value === "string") return statusLabel(value);
  return typeof value === "string" ? value : JSON.stringify(value);
};

/** 変更履歴の 1 行。誰が・何を・どう変えたかを、画面の言葉で書く */
export function describeChange(change: TaskDetailChange): string {
  const actor = ACTOR_LABELS[change.actor] ?? change.actor;
  if (change.kind === "created") return `${actor} 作られた`;
  if (change.kind === "link_added") return `${actor} 元の項目が追加された`;
  const field = change.field === null ? "項目" : (FIELD_LABELS[change.field] ?? change.field);
  return `${actor} ${field}を「${valueText(change.field, change.before)}」から「${valueText(change.field, change.after)}」に変えた`;
}

/** 元の項目をどこで開くか（カードのボタンの文言） */
export function openLabel(url: string): string {
  if (!URL.canParse(url)) return "開く";
  const host = new URL(url).hostname;
  if (host === "github.com") return "GitHub で開く";
  if (host === "slack.com" || host.endsWith(".slack.com")) return "Slack で開く";
  if (host === "mail.google.com") return "Gmail で開く";
  return "開く";
}

/** Gmail の送り主ごと・スレッドごとのまとまりを追う Task か（ゴミ箱に入れる操作を出す） */
export function tracksGmail(items: ReadonlyArray<{ role: string; source: string }>): boolean {
  return items.some((item) => item.role === "tracks" && /^gmail:[a-z0-9][a-z0-9-]*:(senders|threads)$/.test(item.source));
}

/** Slack の To-do・Saved（slack:<id>）を追う Task か。メンション・DM（slack:<id>:inbox）は To-do の操作ができない */
export function tracksSlackSaved(items: ReadonlyArray<{ role: string; source: string }>): boolean {
  return items.some((item) => item.role === "tracks" && /^slack:[a-z0-9][a-z0-9-]*$/.test(item.source));
}
