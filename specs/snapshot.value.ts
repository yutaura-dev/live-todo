/**
 * Source Item の、ある時点の姿（Snapshot）。Source Item は今の姿（latest）を 1 つ持ち、振り分けと判定はこれを見る。
 * 昔の姿は持たない。出来事の履歴（Activity の、変わった項目の前と後）を新しい順に戻していけば、どの時点の姿でも組み立て直せる。
 */
export type Snapshot = {
  /** Source でのタイトル */
  title: string;
  /** 作った人（GitHub のログイン名など）。作った人はここにだけ持ち、事実の行には書かない */
  author: string | null;
  /** この時点の事実。振り分けとルールの判定の材料 */
  fact: Fact;
  /** Source 側で最後に更新された時刻（GitHub の PR の updated_at など）。Source が教えてくれなければ null */
  sourceUpdatedAt: string | null;
  /** アプリがこの姿を取り込んだ時刻 */
  capturedAt: string;
};

/**
 * 事実。アプリが書いた信頼できる情報と、外の人が書いた本文を分けて持つ（本文に書かれた偽の行を、アプリの情報と取り違えないため）
 */
export type Fact = {
  /** アプリが API の値から書いた行（種類・状態を Source の言葉で（マージ済み・マージされずに閉じた など）・自分へのレビュー依頼の有無 など）。行ごとに名前（key）を持ち、値がなくても「なし」と書く */
  trusted: TrustedLine[];
  /** 外の人が書いた本文 */
  body: string;
};

/** アプリが書いた行 1 つ */
export type TrustedLine = {
  /** 行の名前（種類・状態・あなたへのレビュー依頼 など）。同じ姿の中で重ならない */
  key: string;
  /** 値（Source の言葉で。なければ「なし」） */
  value: string;
};

export const invariants = {
  "アプリが書いた行の名前は重ならない": (snapshot: Snapshot) => new Set(snapshot.fact.trusted.map((line) => line.key)).size === snapshot.fact.trusted.length,
  "アプリが書いた行は、値が空でない（なければ「なし」と書く）": (snapshot: Snapshot) => snapshot.fact.trusted.every((line) => line.value.trim() !== ""),
  "タイトルが空でない": (snapshot: Snapshot) => snapshot.title.trim() !== "",
  "取り込んだ時刻を持つ": (snapshot: Snapshot) => snapshot.capturedAt.trim() !== "",
  "Source 側の更新時刻は、取り込んだ時刻より後にならない": (snapshot: Snapshot) => snapshot.sourceUpdatedAt === null || snapshot.sourceUpdatedAt <= snapshot.capturedAt,
};

export const examples = {
  valid: {
    "開いている PR": {
      title: "axios を 1.8 に上げる",
      author: "dependabot[bot]",
      fact: { trusted: [{ key: "種類", value: "PullRequest" }, { key: "状態", value: "開いている" }, { key: "あなたへのレビュー依頼", value: "あり" }], body: "" },
      sourceUpdatedAt: "2026-11-27T23:50:00Z",
      capturedAt: "2026-11-28T00:00:00Z",
    },
    "更新時刻を教えない Source": { title: "Slack の会話", author: "alice", fact: { trusted: [{ key: "種類", value: "会話" }], body: "レビューお願いします" }, sourceUpdatedAt: null, capturedAt: "2026-11-28T00:00:00Z" },
  },
  invalid: {
    "行の名前が重なる": { title: "PR", author: null, fact: { trusted: [{ key: "状態", value: "開いている" }, { key: "状態", value: "マージ済み" }], body: "" }, sourceUpdatedAt: null, capturedAt: "2026-11-28T00:00:00Z" },
    "行の値が空": { title: "PR", author: null, fact: { trusted: [{ key: "あなたへのレビュー依頼", value: "" }], body: "" }, sourceUpdatedAt: null, capturedAt: "2026-11-28T00:00:00Z" },
    "タイトルが空": { title: " ", author: null, fact: { trusted: [], body: "" }, sourceUpdatedAt: null, capturedAt: "2026-11-28T00:00:00Z" },
    "取り込んだ時刻がない": { title: "PR", author: null, fact: { trusted: [], body: "" }, sourceUpdatedAt: null, capturedAt: "" },
    "更新時刻が取り込んだ時刻より後": { title: "PR", author: null, fact: { trusted: [], body: "" }, sourceUpdatedAt: "2026-11-29T00:00:00Z", capturedAt: "2026-11-28T00:00:00Z" },
  },
} satisfies { valid: Record<string, Snapshot>; invalid: Record<string, Snapshot> };
