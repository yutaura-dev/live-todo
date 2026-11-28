import type { Effort } from "../../llm/shared/vocabulary.js";
import type { PriorityLevel } from "../../llm/shared/vocabulary.js";

// specs/priority.value.ts の判断表（規則で決まる優先度・どの期日で決まるか・手間の日数）。LLM を呼ばずに決められる分

export type RuleResult = PriorityLevel | "今日中以上（今すぐかは判定）" | "規則では決めない";

export function effortDays(effort: Effort): number {
  if (effort === "easy") return 0;
  if (effort === "normal") return 1;
  if (effort === "tedious") return 2;
  return 3;
}

export function ruleLevel(input: { 期日まで: number | "期日なし"; 手間: number; 待ち: number | "分からない"; 他の人を止めている: boolean }): RuleResult {
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

export type Deadline = { 名前: string; 期日まで: number; 手間: number; 待ち: number | "分からない" };

/** 見込みの分からない待ちを含む期日は、余裕が読めないので先に返す（規則では決めず Decisions に渡す） */
export function tightestDeadline(deadlines: ReadonlyArray<Deadline>): string | "期日なし" {
  if (deadlines.length === 0) return "期日なし";
  const unknown = deadlines.find((d) => d.待ち === "分からない");
  if (unknown) return unknown.名前;
  const slack = (d: Deadline) => d.期日まで - d.手間 - (d.待ち === "分からない" ? 0 : d.待ち);
  return deadlines.reduce((a, b) => (slack(b) < slack(a) ? b : a)).名前;
}

const localDate = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

const dayNumber = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** 今日（その地域の日付）から、期日のいちばん早い日時を同じ地域の日付に直した日までの日数 */
export const daysUntil = (today: string, earliestIso: string, timeZone: string): number => dayNumber(localDate(earliestIso, timeZone)) - dayNumber(today);
