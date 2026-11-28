import type { Effort } from "./action-definition.value.ts";

/**
 * 優先度（いつまでに手を付けるとよいか）。重要さではなく、手を付けるべき時期をラベルで示す。
 * 期日が分かれば、手を付けるべき日（期日のいちばん早い日時 − 自分の手間 − 待つ見込み）から規則で決める。待つ見込みは、待つ条件の Action Item（だれかの返事・申請の承認 など）が持つ長いほうの日数（営業日なら土日・祝日を除いて数える）。見込みが分からない待ちがあれば規則では決めず、Decisions が事実と一緒に見て判定する（手間だけでもう間に合わないなら、規則で今すぐ）。期日がない・今すぐかもしれないものは、Decisions が事実と計画を見て判定する。
 * 自分の返事が他の人を止めているもの（PR のレビュー・返信するだけのもの・自分がブロッカーになっているもの）は、期日がなくても今日中以上にし、今すぐか今日中かを Decisions が判定する。止めているかは、Decisions が事実から判定して Task に書く（真偽で答えられ、文章が要らないため。期日は文章を伴うので Generation が読み取る）。
 * 期日までの日数は、今日から期日のいちばん早い日時までを日で数える。期日は Task の期日と、まだの Action Item の期日のそれぞれで見る。期日ごとに、その期日までにやるまだの Action Item の手間と待つ見込みを足して引き、残る余裕がいちばん小さいものでラベルを決める（判断表「どの期日で決まるか」）。
 */
export type Priority = {
  /** いつまでに手を付けるとよいか */
  level: Level;
  /** なぜそのラベルか（見せるための一言。「期日まで 2 日で、手間が 1 日」など） */
  reason: string;
};

export const Level = {
  now: "今すぐ",
  today: "今日中",
  in3days: "3 日以内",
  in10days: "10 日以内",
  in30days: "30 日以内",
  later: "それより先でよい",
} as const;
export type Level = (typeof Level)[keyof typeof Level];

/** 判定表「規則で決まる優先度」の結果 */
export type RuleResult = Level | "今日中以上（今すぐかは判定）" | "規則では決めない";

export const invariants = {
  "なぜそのラベルかがある": (priority: Priority) => priority.reason.trim() !== "",
};

export const examples = {
  valid: {
    "期日が過ぎそう": { level: "今すぐ", reason: "期日まで 1 日で、手間が 2 日" },
    "レビューを待たれている": { level: "今日中", reason: "PR のレビューを待たれている" },
    "急がない": { level: "それより先でよい", reason: "期日まで 40 日" },
  },
  invalid: {
    "理由がない": { level: "今日中", reason: "" },
  },
} satisfies { valid: Record<string, Priority>; invalid: Record<string, Priority> };

/** 手間の日数（まだの Action Item の難易度から見積もる。待つ・分かれ道は数えない） */
function effortDays(effort: Effort): number {
  if (effort === "easy") return 0;
  if (effort === "normal") return 1;
  if (effort === "tedious") return 2;
  return 3;
}

/** 規則で決まる優先度（LLM を呼ばずに決められるもの） */
function ruleLevel(input: { 期日まで: number | "期日なし"; 手間: number; 待ち: number | "分からない"; 他の人を止めている: boolean }): RuleResult {
  const withoutWait = input.期日まで === "期日なし" ? null : input.期日まで - input.手間;
  const slack = withoutWait === null || input.待ち === "分からない" ? null : withoutWait - input.待ち;
  if ((withoutWait !== null && withoutWait < 0) || (slack !== null && slack < 0)) return "今すぐ";
  if (input.他の人を止めている) return "今日中以上（今すぐかは判定）";
  if (slack === null) return "規則では決めない";
  if (slack < 1) return "今日中";
  if (slack <= 3) return "3 日以内";
  if (slack <= 10) return "10 日以内";
  if (slack <= 30) return "30 日以内";
  return "それより先でよい";
}

type Deadline = { 名前: string; 期日まで: number; 手間: number; 待ち: number | "分からない" };

/**
 * どの期日でラベルが決まるか（Task の期日と、まだの Action Item の期日のそれぞれについて、その期日までにやるまだの Action Item の手間と待ちを足したもの）
 *
 * 余裕（期日まで − 手間 − 待ち）がいちばん小さい期日で決める。見込みの分からない待ちを含む期日は、余裕が読めないので、いちばん先に見る（規則では決めず Decisions に渡す）。
 */
function tightestDeadline(deadlines: Deadline[]): string | "期日なし" {
  if (deadlines.length === 0) return "期日なし";
  const unknown = deadlines.find((d) => d.待ち === "分からない");
  if (unknown) return unknown.名前;
  const slack = (d: Deadline) => d.期日まで - d.手間 - (d.待ち === "分からない" ? 0 : d.待ち);
  return deadlines.reduce((a, b) => (slack(b) < slack(a) ? b : a)).名前;
}

export const decisions = {
  どの期日で決まるか: {
    decide: tightestDeadline,
    cases: [
      { input: [], expect: "期日なし" },
      { input: [{ 名前: "Task の期日", 期日まで: 10, 手間: 1, 待ち: 0 }], expect: "Task の期日" },
      {
        input: [
          { 名前: "Task の期日", 期日まで: 10, 手間: 2, 待ち: 0 },
          { 名前: "申請を出す（Action Item の期日）", 期日まで: 4, 手間: 1, 待ち: 2 },
        ],
        expect: "申請を出す（Action Item の期日）",
      },
      {
        input: [
          { 名前: "Task の期日", 期日まで: 3, 手間: 1, 待ち: 0 },
          { 名前: "承認を待つ（見込みが分からない）", 期日まで: 20, 手間: 0, 待ち: "分からない" },
        ],
        expect: "承認を待つ（見込みが分からない）",
      },
    ],
  },
  手間の日数: {
    decide: effortDays,
    cases: [
      { input: "easy", expect: 0 },
      { input: "normal", expect: 1 },
      { input: "tedious", expect: 2 },
      { input: "hard", expect: 3 },
    ],
  },
  規則で決まる優先度: {
    decide: ruleLevel,
    cases: [
      { input: { 期日まで: 1, 手間: 2, 待ち: 0, 他の人を止めている: false }, expect: "今すぐ" },
      { input: { 期日まで: 0, 手間: 0, 待ち: 0, 他の人を止めている: false }, expect: "今日中" },
      { input: { 期日まで: 5, 手間: 3, 待ち: 0, 他の人を止めている: false }, expect: "3 日以内" },
      { input: { 期日まで: 10, 手間: 1, 待ち: 0, 他の人を止めている: false }, expect: "10 日以内" },
      { input: { 期日まで: 20, 手間: 1, 待ち: 0, 他の人を止めている: false }, expect: "30 日以内" },
      { input: { 期日まで: 40, 手間: 1, 待ち: 0, 他の人を止めている: false }, expect: "それより先でよい" },
      { input: { 期日まで: 20, 手間: 0, 待ち: 0, 他の人を止めている: true }, expect: "今日中以上（今すぐかは判定）" },
      { input: { 期日まで: 2, 手間: 1, 待ち: 5, 他の人を止めている: true }, expect: "今すぐ" },
      { input: { 期日まで: "期日なし", 手間: 0, 待ち: 0, 他の人を止めている: true }, expect: "今日中以上（今すぐかは判定）" },
      { input: { 期日まで: "期日なし", 手間: 1, 待ち: 0, 他の人を止めている: false }, expect: "規則では決めない" },
      { input: { 期日まで: 5, 手間: 1, 待ち: 3, 他の人を止めている: false }, expect: "3 日以内" },
      { input: { 期日まで: 5, 手間: 1, 待ち: 5, 他の人を止めている: false }, expect: "今すぐ" },
      { input: { 期日まで: 20, 手間: 1, 待ち: 7, 他の人を止めている: false }, expect: "30 日以内" },
      { input: { 期日まで: 20, 手間: 1, 待ち: "分からない", 他の人を止めている: false }, expect: "規則では決めない" },
      { input: { 期日まで: 1, 手間: 2, 待ち: "分からない", 他の人を止めている: false }, expect: "今すぐ" },
    ],
  },
};
