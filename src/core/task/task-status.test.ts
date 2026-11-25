import { assert, describe, it } from "@effect/vitest";
import { deriveTaskStatus } from "./task-status.js";

describe("deriveTaskStatus", () => {
  it("tracks の Item が解決したら、開いている Task を done にする", () => {
    assert.strictEqual(deriveTaskStatus("todo", ["resolved"]), "done");
    assert.strictEqual(deriveTaskStatus("in_progress", ["resolved"]), "done");
    assert.strictEqual(deriveTaskStatus("needs_review", ["resolved"]), "done");
  });

  it("tracks の Item がひとつでも open なら、done にしない", () => {
    assert.strictEqual(deriveTaskStatus("todo", ["resolved", "open"]), "todo");
  });

  it("done の Task は、tracks の Item が open に戻ったら todo に戻す", () => {
    assert.strictEqual(deriveTaskStatus("done", ["open"]), "todo");
  });

  it("ユーザーが選んだ in_progress は、Item が open のままなら変えない", () => {
    assert.strictEqual(deriveTaskStatus("in_progress", ["open"]), "in_progress");
  });

  it("tracks の Item がすべて消えたら、開いている Task を archived にする", () => {
    assert.strictEqual(deriveTaskStatus("todo", ["removed"]), "archived");
  });

  it("消えた Item と解決した Item が混ざっていれば done にする", () => {
    assert.strictEqual(deriveTaskStatus("todo", ["removed", "resolved"]), "done");
  });

  it("done の Task は、tracks の Item が消えても done のままにする", () => {
    assert.strictEqual(deriveTaskStatus("done", ["removed"]), "done");
  });

  it("ユーザーが dismissed にした Task は変えない", () => {
    assert.strictEqual(deriveTaskStatus("dismissed", ["open"]), "dismissed");
    assert.strictEqual(deriveTaskStatus("dismissed", ["resolved"]), "dismissed");
  });

  it("tracks の Item がなければ変えない", () => {
    assert.strictEqual(deriveTaskStatus("todo", []), "todo");
  });
});
