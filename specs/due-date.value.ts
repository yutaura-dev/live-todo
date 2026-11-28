/**
 * 期日（いつまでにやるか）。はっきりした日時（12 月 15 日 15 時まで）も、だいたいの時期（来週中・12 月中旬・12 月中）も、いちばん早い日時〜いちばん遅い日時の範囲で持つ。
 * 事実（メールの「金曜までに」・カレンダーの予定 など）から Generation が読み取り、ユーザーが直すこともできる。画面では元の書き方のまま見せる。
 * 優先度を決めるときは、間に合わないことがないように、いちばん早い日時を期日とみなす（12 月中旬なら 12/11）。
 */
export type DueDate = {
  /** 元の書き方（「12 月中旬」「金曜までに」）。画面ではこれを見せる */
  text: string;
  /** いちばん早い日時 */
  earliest: string;
  /** いちばん遅い日時 */
  latest: string;
  /** どこまで細かく分かっているか */
  precision: "時刻" | "日" | "週" | "旬" | "月";
};

export const invariants = {
  "元の書き方がある": (due: DueDate) => due.text.trim() !== "",
  "いちばん早い日時は、いちばん遅い日時より後にならない": (due: DueDate) => due.earliest <= due.latest,
  "時刻まで分かっているときは、範囲を持たない": (due: DueDate) => due.precision !== "時刻" || due.earliest === due.latest,
};

export const examples = {
  valid: {
    "時刻まで決まっている": { text: "12 月 15 日 15 時まで", earliest: "2026-12-15T15:00", latest: "2026-12-15T15:00", precision: "時刻" },
    "日まで決まっている": { text: "12 月 15 日まで", earliest: "2026-12-15T00:00", latest: "2026-12-15T23:59", precision: "日" },
    "来週中": { text: "来週中", earliest: "2026-12-07T00:00", latest: "2026-12-13T23:59", precision: "週" },
    "12 月中旬": { text: "12 月中旬", earliest: "2026-12-11T00:00", latest: "2026-12-20T23:59", precision: "旬" },
    "12 月中": { text: "12 月中", earliest: "2026-12-01T00:00", latest: "2026-12-31T23:59", precision: "月" },
  },
  invalid: {
    "元の書き方がない": { text: "", earliest: "2026-12-15T00:00", latest: "2026-12-15T23:59", precision: "日" },
    "範囲が逆": { text: "12 月中旬", earliest: "2026-12-20T00:00", latest: "2026-12-11T23:59", precision: "旬" },
    "時刻なのに範囲がある": { text: "15 時まで", earliest: "2026-12-15T14:00", latest: "2026-12-15T15:00", precision: "時刻" },
  },
} satisfies { valid: Record<string, DueDate>; invalid: Record<string, DueDate> };
