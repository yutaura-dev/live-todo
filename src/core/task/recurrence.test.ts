import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { periodLabel, periodToCreate, upcomingPeriod } from "./recurrence.js";

const monthly = (day: number, leadDays = 0) => ({ kind: "monthly" as const, day, leadDays });
const today = (year: number, month: number, day: number) => ({ year, month, day });

describe("periodToCreate（定期の Task を、どの月の分として作るか）", () => {
  it("決めた日になったら、その月の分を作る。前の日はまだ作らない（前の月の分のまま）", () => {
    assert.deepStrictEqual(periodToCreate(monthly(1), today(2026, 12, 1)), Option.some("2026-12"));
    assert.deepStrictEqual(periodToCreate(monthly(5), today(2026, 12, 4)), Option.some("2026-11"));
  });

  it("その月にない日（31 日など）は、月末に作る", () => {
    assert.deepStrictEqual(periodToCreate(monthly(31), today(2027, 2, 28)), Option.some("2027-02"));
    assert.deepStrictEqual(periodToCreate(monthly(31), today(2027, 2, 27)), Option.some("2027-01"));
  });

  it("何日前から出すかを決めれば、月をまたいでも前もって次の月の分を作る", () => {
    assert.deepStrictEqual(periodToCreate(monthly(1, 3), today(2026, 11, 28)), Option.some("2026-12"));
    assert.deepStrictEqual(periodToCreate(monthly(1, 3), today(2026, 11, 27)), Option.some("2026-11"));
  });

  it("年をまたいでも数えられる", () => {
    assert.deepStrictEqual(periodToCreate(monthly(1, 2), today(2026, 12, 30)), Option.some("2027-01"));
  });
});

describe("upcomingPeriod（ゴーストとして予告する、次の月の分）", () => {
  it("作る日の 7 日前から、まだ作っていない次の月の分を、作る日と残りの日数つきで返す", () => {
    assert.deepStrictEqual(upcomingPeriod(monthly(1), today(2026, 11, 24), "2026-11"), Option.some({ period: "2026-12", date: { year: 2026, month: 12, day: 1 }, daysLeft: 7 }));
    assert.deepStrictEqual(upcomingPeriod(monthly(1), today(2026, 11, 23), "2026-11"), Option.none());
  });

  it("何日前から出すかを決めていれば、その日（本当に作る日）を基準にする", () => {
    assert.deepStrictEqual(
      upcomingPeriod(monthly(10, 3), today(2026, 11, 30), "2026-11"),
      Option.some({ period: "2026-12", date: { year: 2026, month: 12, day: 7 }, daysLeft: 7 }),
    );
  });

  it("もう作った月の分は予告しない（今すぐ作ったあとなど）", () => {
    assert.deepStrictEqual(upcomingPeriod(monthly(1), today(2026, 11, 28), "2026-12"), Option.none());
  });
});

describe("periodLabel", () => {
  it("Task のタイトルに付ける、何月分か。今年でなければ年も付ける", () => {
    assert.strictEqual(periodLabel("2026-12", 2026), "12月分");
    assert.strictEqual(periodLabel("2027-01", 2026), "2027年1月分");
  });
});
