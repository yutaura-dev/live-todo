import type { Effort } from "./action-definition.value.ts";

/**
 * 優先度（いつまでに手を付けるとよいか）。重要さではなく、手を付けるべき時期をラベルで示す。
 * 期日が分かれば、手を付けるべき日（期日のいちばん早い日時 − 手間）から規則で決める。期日がない・今すぐかもしれないものは、Decisions が事実と計画を見て判定する。
 * 自分の返事が他の人を止めているもの（PR のレビュー・返信するだけのもの・自分がブロッカーになっているもの）は、期日がなくても今日中以上にし、今すぐか今日中かを Decisions が判定する。止めているかは、期日と同じく Generation が事実から読み取って Task に書く。
 * 期日までの日数は、今日から期日のいちばん早い日時までを日で数える。期日は Task の期日と、まだの Action Item の期日のそれぞれで見る。期日ごとに、その期日までにやるまだの Action Item の手間を足して引き、残る余裕がいちばん小さいものでラベルを決める。
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
function ruleLevel(input: { 期日まで: number | "期日なし"; 手間: number; 他の人を止めている: boolean }): RuleResult {
  const slack = input.期日まで === "期日なし" ? null : input.期日まで - input.手間;
  if (slack !== null && slack < 0) return "今すぐ";
  if (input.他の人を止めている) return "今日中以上（今すぐかは判定）";
  if (slack === null) return "規則では決めない";
  if (slack < 1) return "今日中";
  if (slack <= 3) return "3 日以内";
  if (slack <= 10) return "10 日以内";
  if (slack <= 30) return "30 日以内";
  return "それより先でよい";
}

export const decisions = {
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
      { input: { 期日まで: 1, 手間: 2, 他の人を止めている: false }, expect: "今すぐ" },
      { input: { 期日まで: 0, 手間: 0, 他の人を止めている: false }, expect: "今日中" },
      { input: { 期日まで: 5, 手間: 3, 他の人を止めている: false }, expect: "3 日以内" },
      { input: { 期日まで: 10, 手間: 1, 他の人を止めている: false }, expect: "10 日以内" },
      { input: { 期日まで: 20, 手間: 1, 他の人を止めている: false }, expect: "30 日以内" },
      { input: { 期日まで: 40, 手間: 1, 他の人を止めている: false }, expect: "それより先でよい" },
      { input: { 期日まで: 20, 手間: 0, 他の人を止めている: true }, expect: "今日中以上（今すぐかは判定）" },
      { input: { 期日まで: "期日なし", 手間: 0, 他の人を止めている: true }, expect: "今日中以上（今すぐかは判定）" },
      { input: { 期日まで: "期日なし", 手間: 1, 他の人を止めている: false }, expect: "規則では決めない" },
    ],
  },
};
