/**
 * 待つ見込み（だれかの返事・申請の承認 などを、どれくらい待つか）。言われていれば（「2〜3 営業日」）、その範囲で持つ。分からなければ持たない（null）。
 * 事実から Generation が読み取り、計画を立てるときに待つ条件の Action Item に入れる。優先度を決めるときは、間に合わないことがないように長いほうを使う。
 */
export type WaitEstimate = {
  /** 元の書き方（「2〜3 営業日」「1 週間ほど」）。画面ではこれを見せる */
  text: string;
  /** 短いほうの日数 */
  minDays: number;
  /** 長いほうの日数 */
  maxDays: number;
  /** 営業日で数えるか（土日・祝日を除く） */
  businessDays: boolean;
};

export const invariants = {
  "元の書き方がある": (wait: WaitEstimate) => wait.text.trim() !== "",
  "短いほうは 0 日以上で、長いほうを超えない": (wait: WaitEstimate) => 0 <= wait.minDays && wait.minDays <= wait.maxDays,
};

export const examples = {
  valid: {
    "2〜3 営業日": { text: "2〜3 営業日", minDays: 2, maxDays: 3, businessDays: true },
    "1 週間ほど": { text: "1 週間ほど", minDays: 5, maxDays: 7, businessDays: false },
    "今日中に返事が来る": { text: "今日中に返します", minDays: 0, maxDays: 0, businessDays: false },
  },
  invalid: {
    "元の書き方がない": { text: "", minDays: 2, maxDays: 3, businessDays: true },
    "範囲が逆": { text: "2〜3 営業日", minDays: 3, maxDays: 2, businessDays: true },
  },
} satisfies { valid: Record<string, WaitEstimate>; invalid: Record<string, WaitEstimate> };
