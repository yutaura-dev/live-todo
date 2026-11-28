/**
 * Task に起きた出来事 1 つ（Task Activity）。Task は、出来事を起きた順に履歴として持つ（足すだけで、書き換えない）。
 * Source Item の Activity が「外の世界に起きたこと」なのに対し、Task Activity は「自分の仕事が、自分の言葉でどう変わったか」。届いたもの（Task Input）を Task の言葉に置き換えて、項目が変わったときだけ残る。
 * 更新マークは、ユーザーが最後に Task を見た時刻より後に、ユーザー以外が変えた項目があれば付く（例外なし）。既読は出来事ごとには持たない。
 * 同じ項目の変化は、見せるときに項目ごとにまとめる（最初の前と最後の後を見せる。元に戻っていても、出来事があったことは見せる）。
 * 新しく出た Task の仕分け（仕分け中から列が決まった）は、更新マークにしない（新着で見せる）。
 * 履歴はユーザーに見せる記録で、ほかの集約はこれを読んで反応しない（集約どうしの反応は links で書く）。
 * 「Source の出来事」（Source Item の Activity）と「Task の出来事」（これ）と言い分ける。
 */
export type TaskActivity = {
  /** 何が起きたか */
  kind: TaskActivityKind;
  /** だれが起こしたか（ユーザーが起こした出来事は、自分で知っているので更新マークにしない） */
  by: "ユーザー" | "AI" | "同期" | "アプリ";
  /** 起きた時刻。履歴はこの順に並ぶ */
  occurredAt: string;
  /** 変わった項目の前と後（項目が変わった出来事だけ持つ） */
  changes: TaskFieldChange[];
  /** どの入力から来たか（Task Input の sourceId・Agent Run の ID。ユーザーの操作なら null）。同じ入力が 2 度届いても、反映は 1 回にする */
  cause: string | null;
};

/** 変わった項目 1 つの、前と後 */
export type TaskFieldChange = {
  /** どの項目か（Task の言葉で持つ項目だけ。事実・最後に変えた日時は出来事にしない。AI の作業は、始まった・終わった・やめたを数える。ユーザーが待っているのに、知らないうちに作業が終わっていることがないように） */
  field: "列" | "どう終わったか" | "何をするか" | "今の状況と次の一手" | "計画" | "Action Item の進み" | "完了条件" | "完了したときにすること" | "AI の作業";
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
} as const;
export type TaskActivityKind = (typeof TaskActivityKind)[keyof typeof TaskActivityKind];

export const invariants = {
  "項目が変わった出来事だけが、変わった項目を持ち、1 つ以上持つ": (activity: TaskActivity) => (activity.kind === "変わった") === (activity.changes.length > 0),
  "変わった項目は、前と後が違う": (activity: TaskActivity) => activity.changes.every((change) => change.before !== change.after),
  "1 つの出来事の中で、同じ項目は 1 回だけ": (activity: TaskActivity) => new Set(activity.changes.map((change) => change.field)).size === activity.changes.length,
  "起きた時刻を持つ": (activity: TaskActivity) => activity.occurredAt.trim() !== "",
};

export const examples = {
  valid: {
    "Task ができた": { kind: "できた", by: "同期", occurredAt: "2026-11-28T00:00:00Z", changes: [], cause: null },
    "AI が今の状況を書き換えた": {
      kind: "変わった",
      by: "AI",
      occurredAt: "2026-11-28T01:00:00Z",
      changes: [{ field: "今の状況と次の一手", before: "レビュー待ち", after: "レビューで指摘が 2 件。直す" }],
      cause: null,
    },
    "自分で列を動かした": { kind: "変わった", by: "ユーザー", occurredAt: "2026-11-28T01:10:00Z", changes: [{ field: "列", before: "要確認", after: "todo" }], cause: null },
    "PR が merge されたので AI が作業をやめた": {
      kind: "変わった",
      by: "AI",
      occurredAt: "2026-11-28T02:00:00Z",
      changes: [{ field: "AI の作業", before: "作業中", after: "やめた（PR が merge された）" }],
      cause: "agent-run:ar1",
    },
    "merge できなかった": {
      kind: "変わった",
      by: "アプリ",
      occurredAt: "2026-11-28T03:00:00Z",
      changes: [
        { field: "Action Item の進み", before: "merge する: 書き込み中", after: "merge する: 書き込めなかった" },
        { field: "今の状況と次の一手", before: "merge を待つ", after: "merge できなかった（権限が足りない）。権限をもらってからもう一度" },
      ],
      cause: "write:w1",
    },
  },
  invalid: {
    "変わったのに、変わった項目がない": { kind: "変わった", by: "AI", occurredAt: "2026-11-28T01:00:00Z", changes: [], cause: null },
    "前と後が同じ": { kind: "変わった", by: "AI", occurredAt: "2026-11-28T01:00:00Z", changes: [{ field: "列", before: "todo", after: "todo" }], cause: null },
    "できた出来事が、変わった項目を持つ": { kind: "できた", by: "同期", occurredAt: "2026-11-28T00:00:00Z", changes: [{ field: "列", before: null, after: "todo" }], cause: null },
  },
};
