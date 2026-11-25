import { assert, describe, it } from "@effect/vitest";
import { workspaceCommands } from "./agent-workspace.js";

describe("workspaceCommands", () => {
  it("初めてなら、浅く clone する", () => {
    assert.deepStrictEqual(workspaceCommands({ exists: false, repository: "acme/app", dir: "/w/repo/acme/app" }), [
      ["gh", ["repo", "clone", "acme/app", "/w/repo/acme/app", "--", "--depth", "1"]],
    ]);
  });

  it("2 回目からは、最新の commit だけを取り直してその状態に合わせる（浅い clone の pull は失敗しやすいため）", () => {
    assert.deepStrictEqual(workspaceCommands({ exists: true, repository: "acme/app", dir: "/w/repo/acme/app" }), [
      ["git", ["-C", "/w/repo/acme/app", "fetch", "--depth", "1", "origin", "HEAD"]],
      ["git", ["-C", "/w/repo/acme/app", "reset", "--hard", "FETCH_HEAD"]],
    ]);
  });
});
