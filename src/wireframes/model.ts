/**
 * ワイヤーフレームで使う Task の形。specs/ の言葉（status・work・Priority・Task Activity）に合わせているが、
 * 画面の検討用に必要なところだけを抜き出したもの。実装の型（BoardCard など）とはまだつながない。
 */
export type Level = "今すぐ" | "今日中" | "3 日以内" | "10 日以内" | "30 日以内" | "それより先でよい";

/** Task の言葉で持つ項目（specs/task-activity.value.ts の TaskFieldChange.field） */
export type TaskField =
  | "列"
  | "どう終わったか"
  | "何をするか"
  | "今の状況と次の一手"
  | "計画"
  | "Action Item の進み"
  | "完了条件"
  | "完了したときにすること"
  | "AI の作業"
  | "優先度"
  | "期日"
  | "他の人を止めているか";

export type PriorityView =
  | { status: "アプリが決めた" | "ユーザーが決めた"; level: Level; reason: string }
  /** Decisions の答えが返らない・閾値の間・断られた。ユーザーに決めてもらう */
  | { status: "ラベル未定" }
  /** まだ一度も決めていない */
  | { status: "未判定" };

export type WireStatus = "triaging" | "needs_review" | "todo" | "完了待ち" | "closed";

/** 次の一手が、何によって果たされるか（specs/action-definition.value.ts の How） */
export type How = "human" | "claude" | "condition" | "write" | "decision";

export type WireTask = {
  id: number;
  title: string;
  brief: string | null;
  status: WireStatus;
  work: "なし" | "作業中";
  /** 優先度の決まり方と、いま見せるラベル（specs/prioritization.spec.ts）。開いていない Task は null */
  priority: PriorityView | null;
  blocksOthers: boolean;
  sources: string[];
  /** いま着手できる Action Item（番が来ているもの）。並列のまとまりに番が来ていれば複数ある。なければ空 */
  now: Array<{ title: string; how: How; working?: boolean }>;
  lastSeenAt: string | null;
  /** Task Activity（specs/task-activity.value.ts）。field は変わった項目 */
  history: Array<{ by: "ユーザー" | "AI" | "同期" | "アプリ"; field: TaskField; occurredAt: string; summary: string }>;
};
