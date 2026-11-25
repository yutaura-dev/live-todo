import { assert, describe, it } from "@effect/vitest";
import { chooseMergeMethod } from "./merge-method.js";

const all = { allowSquashMerge: true, allowMergeCommit: true, allowRebaseMerge: true };
const squash = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Update thing (#${i + 1})`, parents: 1 }));
const merges = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Merge pull request #${i + 1} from a/b`, parents: 2 }));
const plain = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `fix: thing ${i}`, parents: 1 }));

describe("chooseMergeMethod", () => {
  it("許されている方法が 1 つだけなら、それを使う", () => {
    assert.deepInclude(chooseMergeMethod({ allowSquashMerge: false, allowMergeCommit: false, allowRebaseMerge: true }, merges(10)), {
      method: "rebase",
    });
  });

  it("最近の commit で squash（タイトル (#番号)）が多ければ squash にし、理由に件数を書く", () => {
    const choice = chooseMergeMethod(all, [...squash(18), ...merges(2)]);

    assert.strictEqual(choice.method, "squash");
    assert.include(choice.reason, "20 件中 18 件");
  });

  it("merge commit（親が 2 つ）が多ければ merge にする", () => {
    assert.strictEqual(chooseMergeMethod(all, [...merges(12), ...squash(3)]).method, "merge");
  });

  it("どちらでもない 1 つ親の commit が多ければ rebase にする", () => {
    assert.strictEqual(chooseMergeMethod(all, [...plain(15), ...squash(2)]).method, "rebase");
  });

  it("慣習の方法が許されていなければ、許されている方法から squash・merge・rebase の順で選ぶ", () => {
    const choice = chooseMergeMethod({ allowSquashMerge: false, allowMergeCommit: true, allowRebaseMerge: true }, squash(10));

    assert.strictEqual(choice.method, "merge");
  });

  it("commit が読めなければ、許されている方法から squash・merge・rebase の順で選ぶ", () => {
    assert.strictEqual(chooseMergeMethod(all, []).method, "squash");
  });
});
