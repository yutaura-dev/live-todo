import { Option, Schema } from "effect";

/** 定期の Task をいつ作るか。いまは毎月だけ（day: その月の何日か。ない日なら月末。leadDays: 何日前から出すか） */
export const RecurrenceSchedule = Schema.Struct({
  kind: Schema.Literal("monthly"),
  day: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  leadDays: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 27 })),
});
export type RecurrenceSchedule = typeof RecurrenceSchedule.Type;

export type CalendarDate = { year: number; month: number; day: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const shift = (year: number, month: number, by: number) => {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};
const key = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/**
 * 今日の時点で、どの月の分の Task があるべきか（"YYYY-MM"）。出す日（決めた日から leadDays 前）を過ぎた月のうち、いちばん新しい月。
 * 日付だけで数える（時刻やタイムゾーンは呼ぶ側で、その PC の日付に直してから渡す）
 */
export function periodToCreate(schedule: RecurrenceSchedule, today: CalendarDate): Option.Option<string> {
  const todayMs = Date.UTC(today.year, today.month - 1, today.day);
  for (const offset of [1, 0, -1]) {
    const { year, month } = shift(today.year, today.month, offset);
    const due = Date.UTC(year, month - 1, Math.min(schedule.day, daysInMonth(year, month)));
    if (due - schedule.leadDays * DAY_MS <= todayMs) return Option.some(key(year, month));
  }
  return Option.none();
}

export function periodLabel(period: string, currentYear: number): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return year === currentYear ? `${month}月分` : `${year}年${month}月分`;
}
