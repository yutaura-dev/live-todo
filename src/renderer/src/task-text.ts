import type { CardJudgment, TaskDetailChange } from "../../shared/api.js";

const STATUS_LABELS: Record<string, string> = {
  needs_review: "要確認",
  todo: "Todo",
  in_progress: "進行中",
  done: "完了",
  dismissed: "削除済み",
  archived: "元の項目が消えた",
};

const FIELD_LABELS: Record<string, string> = { status: "ステータス", title: "タイトル" };
const ACTOR_LABELS: Record<string, string> = { user: "あなたが", sync: "同期で" };

const METHOD_LABELS: Record<string, string> = { rule: "規則で決まった", decisions: "OpenAI Decisions", structured: "LLM" };

/** 判定の結果を 1 行で。確率や理由があれば方法に続けて書く */
export function judgmentText(judgment: CardJudgment): string {
  const method = METHOD_LABELS[judgment.method] ?? judgment.method;
  if (judgment.probability !== undefined) return `${method}・自分の対応が要る確率 ${Math.round(judgment.probability * 100)}%`;
  if (judgment.reason !== undefined) return `${method}・${judgment.reason}`;
  return method;
}

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
