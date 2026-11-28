/**
 * Task に届いたもの 1 つ（Task Input）。Source と Task の間の抽象化を受け持つ型で、保存しない。
 * Task の入口は receive の 1 本で、届いたものを、AI か規則が Task の言葉（項目の変化）に置き換える。項目が変わったときだけ、Task の出来事（Task Activity）が残る。
 * 何も変えなかった入力（関係ないと判定した など）と判定できなかった入力は、Task の外の受け取りのログに残す。ユーザーには見せず、デバッグと判定の精度の見直しに使う（本文やトークンは残さない）。
 * AI の作業の始まり・終わり・やめたは、noteWork で受け、「AI の作業」の出来事として残す（作業中かは Task に持たず、Agent Run から導く）。Agent は Task を直接は変えないので、Agent の成果物（調べた結果・下書き など）は「AI の作業の成果」として届き、Generationが Task の言葉に置き換える。
 */
export type TaskInput = {
  /** 何が届いたか */
  kind: TaskInputKind;
  /** どこから来たか（Source の出来事・書き込みの ID）。Task の出来事の cause にそのまま写す */
  sourceId: string;
  /** 一言（書き込めなかった理由 など。事実の入力では null） */
  reason: string | null;
};

export const TaskInputKind = {
  /** 事実が Task に増えた（振り分けで持たせた） */
  factAdded: "事実が増えた",
  /** 持っている事実が変わった */
  factChanged: "事実が変わった",
  /** 事実が Task から外れた */
  factDetached: "事実が外れた",
  /** 外への書き込みができなかった（Action Item の書き込み・完了したときにすることの書き込み） */
  writeFailed: "書き込めなかった",
  /** Agent の作業の成果（調べた結果・下書き など） */
  agentResult: "AI の作業の成果",
  /** 待つ条件が達成できなくなった（PR が閉じられた・アカウントを外した など。Generation が計画を立て直すか、ユーザーに知らせる） */
  conditionFailed: "待つ条件が達成できない",
} as const;
export type TaskInputKind = (typeof TaskInputKind)[keyof typeof TaskInputKind];

export const invariants = {
  "どこから来たかを持つ": (input: TaskInput) => input.sourceId.trim() !== "",
  "書き込めなかった入力は、理由を持つ": (input: TaskInput) => input.kind !== "書き込めなかった" || input.reason !== null,
};

export const examples = {
  valid: {
    "PR が merge された（事実が変わった）": { kind: "事実が変わった", sourceId: "activity:s1:3", reason: null },
    "Slack で返信が来た（事実が増えた）": { kind: "事実が増えた", sourceId: "activity:s7:1", reason: null },
    "merge できなかった": { kind: "書き込めなかった", sourceId: "write:w1", reason: "権限が足りない" },
    "Agent が調べ終えた": { kind: "AI の作業の成果", sourceId: "agent-run:ar1", reason: null },
  },
  invalid: {
    "どこから来たかがない": { kind: "事実が変わった", sourceId: "", reason: null },
    "書き込めなかった理由がない": { kind: "書き込めなかった", sourceId: "write:w1", reason: null },
  },
};
