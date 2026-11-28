/**
 * Task に起きた出来事 1 つ（Task Activity）。Task は、出来事を起きた順に履歴として持つ（足すだけで、書き換えない）。
 * Source Item の Activity が「外の世界に起きたこと」なのに対し、Task Activity は「自分の仕事に起きたこと」（項目が変わった・AI が作業をやめた・書き込めなかった など）。
 * 更新マークは、ユーザーが最後に Task を見た時刻より後に、ユーザー以外が起こした出来事があれば付く。既読は出来事ごとには持たない。
 * 同じ項目の変化は、見せるときに項目ごとにまとめる（最初の前と最後の後を見せる。元に戻っていても、出来事があったことは見せる）。
 */
export type TaskActivity = {
  /** 何が起きたか */
  kind: TaskActivityKind;
  /** だれが起こしたか（ユーザーが起こした出来事は、自分で知っているので更新マークにしない） */
  by: "ユーザー" | "AI" | "同期" | "アプリ";
  /** 起きた時刻。履歴はこの順に並ぶ */
  at: string;
  /** 変わった項目の前と後（項目が変わった出来事だけ持つ） */
  changes: TaskFieldChange[];
  /** 出来事の中身の一言（AI が作業をやめた理由・書き込めなかった理由 など。項目が変わった出来事では null） */
  detail: string | null;
};

/** 変わった項目 1 つの、前と後 */
export type TaskFieldChange = {
  /** どの項目か（Task の言葉で持つ項目だけ。事実・AI が作業中か・最後に変えた日時は出来事にしない） */
  field: "列" | "どう終わったか" | "何をするか" | "今の状況と次の一手" | "計画" | "Action Item の進み" | "完了条件" | "完了したときにすること" | "優先度" | "Epic";
  /** 前の値（なかったら null） */
  before: string | null;
  /** 後の値（なくなったら null） */
  after: string | null;
};

export const TaskActivityKind = {
  /** Task ができた（新しく出た Task は、最後に見た時刻がないので新着の印で見せる） */
  created: "できた",
  /** Task の項目が変わった */
  changed: "変わった",
  /** AI が作業をやめた（追う項目が片付いたので Claude Code がやめた など。ADR-0016） */
  workStopped: "AI が作業をやめた",
  /** 外への書き込みができなかった（Action Item の書き込み・完了したときにすることの書き込み） */
  writeFailed: "書き込めなかった",
} as const;
export type TaskActivityKind = (typeof TaskActivityKind)[keyof typeof TaskActivityKind];

export const invariants = {
  "項目が変わった出来事だけが、変わった項目を持ち、1 つ以上持つ": (activity: TaskActivity) => (activity.kind === "変わった") === (activity.changes.length > 0),
  "変わった項目は、前と後が違う": (activity: TaskActivity) => activity.changes.every((change) => change.before !== change.after),
  "AI が作業をやめた・書き込めなかった出来事は、中身の一言を持つ": (activity: TaskActivity) =>
    (activity.kind !== "AI が作業をやめた" && activity.kind !== "書き込めなかった") || activity.detail !== null,
  "起きた時刻を持つ": (activity: TaskActivity) => activity.at.trim() !== "",
};

export const examples = {
  valid: {
    "Task ができた": { kind: "できた", by: "同期", at: "2026-11-28T00:00:00Z", changes: [], detail: null },
    "AI が今の状況を書き換えた": {
      kind: "変わった",
      by: "AI",
      at: "2026-11-28T01:00:00Z",
      changes: [{ field: "今の状況と次の一手", before: "レビュー待ち", after: "レビューで指摘が 2 件。直す" }],
      detail: null,
    },
    "自分で列を動かした": { kind: "変わった", by: "ユーザー", at: "2026-11-28T01:10:00Z", changes: [{ field: "列", before: "要確認", after: "todo" }], detail: null },
    "PR が merge されたので AI が作業をやめた": { kind: "AI が作業をやめた", by: "AI", at: "2026-11-28T02:00:00Z", changes: [], detail: "PR が merge されたので、直す作業をやめた" },
    "merge できなかった": { kind: "書き込めなかった", by: "アプリ", at: "2026-11-28T03:00:00Z", changes: [], detail: "権限が足りないので merge できなかった" },
  },
  invalid: {
    "変わったのに、変わった項目がない": { kind: "変わった", by: "AI", at: "2026-11-28T01:00:00Z", changes: [], detail: null },
    "前と後が同じ": { kind: "変わった", by: "AI", at: "2026-11-28T01:00:00Z", changes: [{ field: "列", before: "todo", after: "todo" }], detail: null },
    "やめた理由がない": { kind: "AI が作業をやめた", by: "AI", at: "2026-11-28T02:00:00Z", changes: [], detail: null },
    "できた出来事が、変わった項目を持つ": { kind: "できた", by: "同期", at: "2026-11-28T00:00:00Z", changes: [{ field: "列", before: null, after: "todo" }], detail: null },
  },
};
