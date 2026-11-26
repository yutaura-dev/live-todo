import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { loginShellArgs, mergePath, pathFromShellOutput } from "./login-shell-path.js";

describe("pathFromShellOutput（ログインシェルの PATH を読む）", () => {
  it("目印で挟んだ PATH だけを取り出す（設定ファイルが出したほかの文字は無視する）", () => {
    const output = "Welcome!\n__LIVE_TODO_PATH__/nix/profile/bin:/opt/homebrew/bin:/usr/bin__LIVE_TODO_PATH__\n";

    assert.deepStrictEqual(pathFromShellOutput(output), Option.some("/nix/profile/bin:/opt/homebrew/bin:/usr/bin"));
  });

  it("目印がない・PATH が空なら none", () => {
    assert.isTrue(Option.isNone(pathFromShellOutput("/usr/bin")));
    assert.isTrue(Option.isNone(pathFromShellOutput("__LIVE_TODO_PATH____LIVE_TODO_PATH__")));
  });
});

describe("mergePath", () => {
  it("ログインシェルの PATH を前に置き、今の PATH にしかないものを後ろに残す（重ねない）", () => {
    assert.strictEqual(mergePath("/usr/bin:/bin:/usr/sbin", "/nix/profile/bin:/usr/bin"), "/nix/profile/bin:/usr/bin:/bin:/usr/sbin");
    assert.strictEqual(mergePath(undefined, "/nix/profile/bin"), "/nix/profile/bin");
  });
});

describe("loginShellArgs", () => {
  it("ログインかつ対話のシェルとして起動し、PATH を目印で挟んで出させる（.zshrc などの PATH も入るように）", () => {
    assert.deepStrictEqual(loginShellArgs, ["-ilc", "printf '__LIVE_TODO_PATH__%s__LIVE_TODO_PATH__' \"$PATH\""]);
  });
});
