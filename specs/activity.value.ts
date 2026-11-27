/**
 * Source Item に起きた出来事 1 つ（Activity）。Source Item は、出来事を起きた順に履歴として持つ。
 * 変わった項目は、要約ではなく前と後をそのまま持つ。今の姿（latest）から出来事を新しい順に戻していけば、どの時点の姿でも組み立て直せる。
 * 出来事そのものは Task の更新ではない。持っている Task が受け取り、Task の言葉に置き換えたときだけ、Task が変わる（更新マークは Task の変化にだけ付く）。
 */
export type Activity = {
  /** 何が起きたか */
  kind: ActivityKind;
  /** アプリが出来事に気づいた（取り込んだ）時刻。履歴はこの順に並ぶ */
  observedAt: string;
  /** Source で起きた時刻（Source が教えてくれなければ null） */
  sourceAt: string | null;
  /** 消えた理由（消えた出来事だけ持つ） */
  removal: Removal | null;
  /** 変わった項目の前と後。初めて届いたときと消えたときは持たない。また現れたときは、消えていた間に変わった項目を持ってよい */
  changes: FieldChange[];
};

/** 変わった項目 1 つの、前と後 */
export type FieldChange = {
  /** どの項目か */
  field: Field;
  /** アプリが書いた行のときは、その行の名前（それ以外は null） */
  key: string | null;
  /** 前の値（なかったら null） */
  before: string | null;
  /** 後の値（なくなったら null） */
  after: string | null;
};

export const Field = {
  /** タイトル */
  title: "title",
  /** 作った人 */
  author: "author",
  /** アプリが書いた信頼できる行（1 行ずつ） */
  trusted: "trusted",
  /** 本文 */
  body: "body",
} as const;
export type Field = (typeof Field)[keyof typeof Field];

export const ActivityKind = {
  /** 初めて届いた */
  appeared: "appeared",
  /** 中身が変わった（Source での状態・タイトル・本文・コメント・アプリが書く情報）。Source での状態の変化（マージされた など）も、アプリが書く行の変化としてここに入る */
  changed: "changed",
  /** Source から消えた */
  removed: "removed",
  /** 消えたものが、また現れた */
  restored: "restored",
} as const;
export type ActivityKind = (typeof ActivityKind)[keyof typeof ActivityKind];

export const Removal = {
  /** Source で削除された */
  deleted: "削除された",
  /** 見張る範囲・一覧の条件から外れた（閉じた PR が一覧から抜けた など）。削除とは限らない */
  outOfScope: "範囲の外になった",
} as const;
export type Removal = (typeof Removal)[keyof typeof Removal];

export const invariants = {
  "初めて届いた出来事は、変わった項目を持たない": (activity: Activity) => activity.kind !== "appeared" || activity.changes.length === 0,
  "中身が変わった出来事は、変わった項目を 1 つ以上持つ": (activity: Activity) => activity.kind !== "changed" || activity.changes.length > 0,
  "消えた出来事は、変わった項目を持たない": (activity: Activity) => activity.kind !== "removed" || activity.changes.length === 0,
  "変わった項目は、前と後が違う": (activity: Activity) => activity.changes.every((change) => change.before !== change.after),
  "気づいた時刻を持つ": (activity: Activity) => activity.observedAt.trim() !== "",
  "消えた理由は、消えた出来事だけが持つ": (activity: Activity) => (activity.kind === "removed") === (activity.removal !== null),
  "アプリが書いた行の変化は、行の名前を持つ": (activity: Activity) => activity.changes.every((change) => (change.field === "trusted") === (change.key !== null)),
};

export const examples = {
  valid: {
    "初めて届いた": { kind: "appeared", observedAt: "2026-11-28T00:00:00Z", sourceAt: "2026-11-27T23:50:00Z", removal: null, changes: [] },
    "変更を求めるレビューが付いた": {
      kind: "changed",
      observedAt: "2026-11-28T01:00:00Z",
      sourceAt: "2026-11-28T00:58:00Z",
      removal: null,
      changes: [{ field: "trusted", key: "変更を求めるレビュー", before: "なし", after: "あり（octocat）" }],
    },
    "merge された": {
      kind: "changed",
      observedAt: "2026-11-28T02:00:00Z",
      sourceAt: null,
      removal: null,
      changes: [
        { field: "trusted", key: "状態", before: "開いている", after: "マージ済み" },
        { field: "trusted", key: "あなたへのレビュー依頼", before: "あり", after: "なし" },
      ],
    },
    "範囲の外になって消えた": { kind: "removed", observedAt: "2026-11-28T03:00:00Z", sourceAt: null, removal: "範囲の外になった", changes: [] },
    "消えていた間にタイトルが変わって、また現れた": { kind: "restored", observedAt: "2026-11-28T04:00:00Z", sourceAt: null, removal: null, changes: [{ field: "title", key: null, before: "a", after: "b" }] },
  },
  invalid: {
    "変わった項目のない変更": { kind: "changed", observedAt: "2026-11-28T01:00:00Z", sourceAt: null, removal: null, changes: [] },
    "変わった項目を持つ消えた出来事": { kind: "removed", observedAt: "2026-11-28T03:00:00Z", sourceAt: null, removal: "削除された", changes: [{ field: "title", key: null, before: "a", after: "b" }] },
    "前と後が同じ": { kind: "changed", observedAt: "2026-11-28T01:00:00Z", sourceAt: null, removal: null, changes: [{ field: "title", key: null, before: "a", after: "a" }] },
    "時刻がない": { kind: "appeared", observedAt: "", sourceAt: null, removal: null, changes: [] },
    "理由のない消えた出来事": { kind: "removed", observedAt: "2026-11-28T03:00:00Z", sourceAt: null, removal: null, changes: [] },
    "行の名前のない行の変化": { kind: "changed", observedAt: "2026-11-28T01:00:00Z", sourceAt: null, removal: null, changes: [{ field: "trusted", key: null, before: "なし", after: "あり" }] },
  },
} satisfies { valid: Record<string, Activity>; invalid: Record<string, Activity> };
