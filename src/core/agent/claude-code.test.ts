import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { childEnv, claudeArgs, decodeClaudeOutput } from "./claude-code.js";

const request = {
  prompt: "調べて",
  cwd: "/tmp/work",
  jsonSchema: { type: "object" },
  allowedTools: ["Read", "Bash(gh pr view:*)"],
};

describe("claudeArgs", () => {
  it("非対話で JSON を返させ、回答の形を JSON Schema で固定する", () => {
    const args = claudeArgs(request);

    assert.includeMembers(args, ["-p", "--output-format", "json"]);
    assert.strictEqual(args[args.indexOf("--json-schema") + 1], '{"type":"object"}');
  });

  it("許可したツールだけを使わせ、それ以外は確認を出さずに拒否させる", () => {
    const args = claudeArgs(request);

    assert.strictEqual(args[args.indexOf("--permission-prompts") + 1], "none");
    assert.deepStrictEqual(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--allowedTools") + 3), ["Read", "Bash(gh pr view:*)"]);
    for (const dangerous of ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions"]) {
      assert.notInclude(args, dangerous);
    }
  });

  it("リポジトリの設定（hooks など）と MCP を読み込まず、ファイルの読み取りを作業ディレクトリに閉じる", () => {
    const args = claudeArgs(request);

    assert.includeMembers(args, ["--restricted", "--strict-mcp-config"]);
  });

  it("使えるツールを、許可したツールの名前だけにする", () => {
    const args = claudeArgs(request);

    assert.deepStrictEqual(args.slice(args.indexOf("--tools") + 1, args.indexOf("--tools") + 3), ["Read", "Bash"]);
  });

  it("作業ディレクトリのほかに読ませるフォルダを --add-dir で渡す", () => {
    const args = claudeArgs({ ...request, addDirs: ["/work/task-1/context"] });

    assert.strictEqual(args[args.indexOf("--add-dir") + 1], "/work/task-1/context");
    assert.notInclude(claudeArgs(request), "--add-dir");
  });

  it("プロンプトは引数に入れない（--allowedTools が後ろの引数をツール名として読むため、標準入力で渡す）", () => {
    assert.notInclude(claudeArgs(request), "調べて");
  });

  it("session id があれば、その会話を続ける", () => {
    const args = claudeArgs({ ...request, resumeSessionId: "abc" });

    assert.strictEqual(args[args.indexOf("--resume") + 1], "abc");
    assert.notInclude(claudeArgs(request), "--resume");
  });

  it("モデルと予算の上限を渡せる", () => {
    const args = claudeArgs({ ...request, model: "sonnet", maxBudgetUsd: 1.5 });

    assert.strictEqual(args[args.indexOf("--model") + 1], "sonnet");
    assert.strictEqual(args[args.indexOf("--max-budget-usd") + 1], "1.5");
  });
});

describe("claudeArgs（禁止するツール）", () => {
  it("禁止したツール（git push など）を --disallowedTools で渡す", () => {
    const args = claudeArgs({ ...request, disallowedTools: ["Bash(git push:*)", "Bash(gh:*)"] });
    const at = args.indexOf("--disallowedTools");

    assert.isAbove(at, -1);
    assert.deepStrictEqual(args.slice(at + 1, at + 3), ["Bash(git push:*)", "Bash(gh:*)"]);
    assert.isBelow(at, args.indexOf("--allowedTools"));
  });
});

describe("childEnv（認証を渡さない）", () => {
  it("書き込みを伴うコマンドを任せるときは、git・gh の認証と SSH エージェントを使えないようにする", () => {
    const env = childEnv(
      { PATH: "/usr/bin", HOME: "/Users/me", GH_TOKEN: "ghp_x", GITHUB_TOKEN: "ghp_y", SSH_AUTH_SOCK: "/tmp/agent" },
      { withoutCredentials: { ghConfigDir: "/work/empty-gh" } },
    );

    assert.deepStrictEqual(env, {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "false",
      GH_CONFIG_DIR: "/work/empty-gh",
    });
  });
});

describe("childEnv", () => {
  it("アプリの秘密情報（LIVE_TODO_SECRET_*）は claude に渡さない", () => {
    const env = childEnv({ PATH: "/usr/bin", HOME: "/Users/me", LIVE_TODO_SECRET_GITHUB_PERSONAL_TOKEN: "ghp_x", LIVE_TODO_SECRET_LLM_OPENAI_API_KEY: "sk", EMPTY: undefined });

    assert.deepStrictEqual(env, { PATH: "/usr/bin", HOME: "/Users/me" });
  });
});

describe("decodeClaudeOutput", () => {
  const output = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-1",
      total_cost_usd: 0.12,
      permission_denials: [],
      structured_output: { conclusion: "mergeable" },
      ...overrides,
    });

  it.effect("session id・構造化された回答・費用を取り出す", () =>
    Effect.gen(function* () {
      const result = yield* decodeClaudeOutput(output({}));

      assert.deepStrictEqual(result, { sessionId: "session-1", structured: { conclusion: "mergeable" }, costUsd: 0.12, permissionDenials: 0 });
    }));

  it.effect("失敗（is_error）なら、種類を添えてエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeClaudeOutput(output({ is_error: true, subtype: "error_max_budget_usd" })));

      assert.include(error.message, "error_max_budget_usd");
    }));

  it.effect("構造化された回答がなければエラーにする（形の決まらない回答を結果として扱わない）", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeClaudeOutput(output({ structured_output: undefined })));

      assert.strictEqual(error._tag, "ClaudeCodeError");
    }));

  it.effect("構造化された回答がないときだけ、頼み直せるよう session id をエラーに残す", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(decodeClaudeOutput(output({ structured_output: undefined })));
      const failed = yield* Effect.flip(decodeClaudeOutput(output({ is_error: true, subtype: "error_during_execution" })));

      assert.strictEqual(missing.retrySessionId, "session-1");
      assert.isUndefined(failed.retrySessionId);
    }));

  it.effect("JSON でない出力はエラーにする", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeClaudeOutput("Error: not logged in"));

      assert.strictEqual(error._tag, "ClaudeCodeError");
    }));
});
