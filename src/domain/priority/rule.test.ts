import { assert, describe, it } from "@effect/vitest";
import { decisions } from "../../../specs/priority.value.ts";
import { daysUntil, effortDays, ruleLevel, tightestDeadline } from "./rule.js";

// spec の判断表の cases を、実装の関数にそのまま当てる（spec を変えたら、ここが落ちて気づける）
describe("規則で決まる優先度（spec の判断表）", () => {
  for (const { input, expect } of decisions["規則で決まる優先度"].cases) {
    it(`${JSON.stringify(input)} → ${expect}`, () => {
      assert.strictEqual(ruleLevel(input as Parameters<typeof ruleLevel>[0]), expect);
    });
  }
});

describe("どの期日で決まるか（spec の判断表）", () => {
  for (const { input, expect } of decisions["どの期日で決まるか"].cases) {
    it(`${input.map((d) => d.名前).join("・") || "期日なし"} → ${expect}`, () => {
      assert.strictEqual(tightestDeadline(input as Parameters<typeof tightestDeadline>[0]), expect);
    });
  }
});

describe("手間の日数（spec の判断表）", () => {
  for (const { input, expect } of decisions["手間の日数"].cases) {
    it(`${input} → ${expect} 日`, () => {
      assert.strictEqual(effortDays(input as Parameters<typeof effortDays>[0]), expect);
    });
  }
});

describe("期日までの日数", () => {
  it("今日から期日のいちばん早い日時までを、その地域の暦の日で数える", () => {
    assert.strictEqual(daysUntil("2026-11-28", "2026-12-01T00:00:00.000Z", "Asia/Tokyo"), 3);
  });

  it("日本の 0 時は UTC では前の日なので、地域の日付に直してから数える", () => {
    assert.strictEqual(daysUntil("2026-11-28", "2026-11-28T15:30:00.000Z", "Asia/Tokyo"), 1);
  });

  it("過ぎた期日は負の日数", () => {
    assert.strictEqual(daysUntil("2026-11-28", "2026-11-26T03:00:00.000Z", "Asia/Tokyo"), -2);
  });
});
