import { assert, describe, it } from "@effect/vitest";
import { pullRequestCommands, truncateDiff } from "./pull-request-context.js";

describe("pullRequestCommands", () => {
  it("PR の本文・CI の結果・変更したファイルと、差分を、読み取りだけの gh コマンドで集める", () => {
    const commands = pullRequestCommands("https://github.com/acme/app/pull/42");

    assert.deepStrictEqual(commands.view.slice(0, 3), ["pr", "view", "https://github.com/acme/app/pull/42"]);
    assert.include(commands.view[commands.view.indexOf("--json") + 1]!, "statusCheckRollup");
    assert.deepStrictEqual(commands.diff, ["pr", "diff", "https://github.com/acme/app/pull/42"]);
  });
});

describe("truncateDiff", () => {
  it("大きすぎる差分（lockfile など）は上限で切り、切ったことを書き添える", () => {
    const diff = "a".repeat(50);

    assert.strictEqual(truncateDiff(diff, 100), diff);
    assert.match(truncateDiff(diff, 10), /^a{10}\n\n\(差分が大きいため、ここで切った。残り 40 文字\)$/);
  });
});
