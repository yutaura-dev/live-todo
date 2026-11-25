import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { detectActivities } from "./activities.js";

const snapshot = (state: "open" | "resolved" | "removed", fingerprint = "v1") => ({ state, fingerprint });

describe("detectActivities", () => {
  it("初めて見た Item は appeared だけを返す", () => {
    assert.deepStrictEqual(detectActivities(Option.none(), snapshot("open")), ["appeared"]);
  });

  it("内容が変わった Item は changed を返す", () => {
    assert.deepStrictEqual(detectActivities(Option.some(snapshot("open", "v1")), snapshot("open", "v2")), ["changed"]);
  });

  it("内容も状態も変わっていなければ何も返さない", () => {
    assert.deepStrictEqual(detectActivities(Option.some(snapshot("open")), snapshot("open")), []);
  });

  it("open から resolved になった Item は resolved を返す", () => {
    assert.deepStrictEqual(detectActivities(Option.some(snapshot("open")), snapshot("resolved")), ["resolved"]);
  });

  it("resolved から open に戻った Item は reopened を返す", () => {
    assert.deepStrictEqual(detectActivities(Option.some(snapshot("resolved")), snapshot("open")), ["reopened"]);
  });

  it("消えた Item は removed を返す", () => {
    assert.deepStrictEqual(detectActivities(Option.some(snapshot("open")), snapshot("removed")), ["removed"]);
  });

  it("消えた Item が open で戻ってきたら reopened を返す", () => {
    assert.deepStrictEqual(detectActivities(Option.some(snapshot("removed")), snapshot("open")), ["reopened"]);
  });

  it("内容と状態が同時に変わったら changed と resolved の両方を返す", () => {
    assert.deepStrictEqual(detectActivities(Option.some(snapshot("open", "v1")), snapshot("resolved", "v2")), [
      "changed",
      "resolved",
    ]);
  });
});
