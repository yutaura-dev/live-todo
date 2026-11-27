import { assert, describe, it } from "@effect/vitest";
import { specOf } from "@yutaura/live-spec/testing";
import * as AgentRunSpec from "../../../specs/agent-run.spec.js";
import { Deferred, Effect, Fiber, Option } from "effect";
import { childEnv, type ClaudeRequest, type ClaudeResult, ClaudeCodeError, claudeArgs, decodeClaudeOutput, runStoppable } from "./claude-code.js";

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

  it("新しい会話の session id を決めて渡せる（途中で止めたあとに同じ会話を続けるため）", () => {
    const args = claudeArgs({ ...request, sessionId: "11111111-1111-4111-8111-111111111111" });

    assert.strictEqual(args[args.indexOf("--session-id") + 1], "11111111-1111-4111-8111-111111111111");
    assert.notInclude(claudeArgs(request), "--session-id");
  });

  it("続ける会話があるときは、session id を新しく決めない", () => {
    assert.notInclude(claudeArgs({ ...request, resumeSessionId: "abc", sessionId: "11111111-1111-4111-8111-111111111111" }), "--session-id");
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

describe("claudeArgs（sandbox）", () => {
  it("sandbox を有効にし、起動できなければ止め、外での再実行を禁止し、通信先と読ませない場所・書いてよい場所を決める", () => {
    const args = claudeArgs({ ...request, sandbox: { allowedDomains: ["registry.npmjs.org"], denyRead: ["/Users/me/.ssh"], allowRead: ["/work/task-1"], allowWrite: ["/work/cache"] } });
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);

    assert.deepStrictEqual(settings, {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyRead: ["/Users/me/.ssh"], allowRead: ["/work/task-1"], allowWrite: ["/work/cache"] },
        network: { allowedDomains: ["registry.npmjs.org"], strictAllowlist: true },
      },
    });
  });

  it("sandbox を指定しなければ --settings を付けない", () => {
    assert.notInclude(claudeArgs(request), "--settings");
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

describe("runStoppable", () => {
  const SESSION = "22222222-2222-4222-8222-222222222222";
  const answered = (structured: unknown, sessionId = SESSION): ClaudeResult => ({ sessionId, structured, costUsd: 0.1, permissionDenials: 0 });

  /** 1 回目の呼び出しは止められるまで終わらず、2 回目からは answers を順に返す run */
  const fakeRun = (answers: ReadonlyArray<ClaudeResult>, options: { firstRuns?: boolean } = {}) => {
    const requests: ClaudeRequest[] = [];
    const run = (next: ClaudeRequest) =>
      Effect.suspend(() => {
        requests.push(next);
        if (requests.length === 1 && options.firstRuns !== true) return Effect.never;
        return Effect.succeed(answers[requests.length - (options.firstRuns === true ? 1 : 2)]!);
      });
    return { requests, run };
  };

  const noticeOf = (deferred: Deferred.Deferred<string>) => ({ wait: Deferred.await(deferred), poll: Effect.map(Deferred.poll(deferred), Option.map(() => "")) });

  describe(specOf(AgentRunSpec.decideStop, "判断中のときだけ"), () => {
    describe(specOf(AgentRunSpec.decideContinue, "判断中のときだけ"), () => {
      it.effect("知らせが来なければ、決めた session id で動かし、回答をそのまま返す", () =>
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<string>();
          const { requests, run } = fakeRun([answered({ plan: 1 })], { firstRuns: true });

          const result = yield* runStoppable(run, request, noticeOf(deferred), Effect.succeed(SESSION));

          assert.deepStrictEqual(result.structured, { plan: 1 });
          assert.strictEqual(requests[0]?.sessionId, SESSION);
        }));
    });
  });

  it.effect("知らせが来たら動いている claude を止め、同じ session で、やめるか続けるかを判断させる", () =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<string>();
      const { requests, run } = fakeRun([answered({ decision: "stop", reason: "merge されたので直す意味がない" })]);

      const fiber = yield* Effect.forkChild(Effect.flip(runStoppable(run, request, noticeOf(deferred), Effect.succeed(SESSION))));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(deferred, "追っている PR が merge された");
      const error = yield* Fiber.join(fiber);

      assert.strictEqual(requests[1]?.resumeSessionId, SESSION);
      assert.include(requests[1]?.prompt, "追っている PR が merge された");
      assert.instanceOf(error, ClaudeCodeError);
      assert.strictEqual(error.stoppedReason, "merge されたので直す意味がない");
    }));

  describe(specOf(AgentRunSpec.finish, "実行中か続行中のときだけ"), () => {
    it.effect("続けると判断したら、元の形の回答（result）を回答として返す", () =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<string>();
        const { run } = fakeRun([answered({ decision: "continue", reason: "別の PR でも要る修正", result: { plan: 2 } })]);

        const fiber = yield* Effect.forkChild(runStoppable(run, request, noticeOf(deferred), Effect.succeed(SESSION)));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(deferred, "追っている PR が merge された");
        const result = yield* Fiber.join(fiber);

        assert.deepStrictEqual(result.structured, { plan: 2 });
      }));
  });

  describe(specOf(AgentRunSpec.fail, "動いているときだけ"), () => {
    it.effect("続けると答えたのに元の形の回答がなければ、やめたことにせず失敗にする", () =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<string>();
        const { run } = fakeRun([answered({ decision: "continue", reason: "続ける" })]);

        const fiber = yield* Effect.forkChild(Effect.flip(runStoppable(run, request, noticeOf(deferred), Effect.succeed(SESSION))));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(deferred, "追っている PR が merge された");
        const error = yield* Fiber.join(fiber);

        assert.instanceOf(error, ClaudeCodeError);
        assert.isUndefined(error.stoppedReason);
      }));
  });

  it.effect("始める前に知らせが来ていたら、止めずに最初から、作業と一緒に判断も頼む", () =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<string>();
      yield* Deferred.succeed(deferred, "追っている PR が merge された");
      const { requests, run } = fakeRun([answered({ decision: "stop", reason: "もう要らない" })], { firstRuns: true });

      const error = yield* Effect.flip(runStoppable(run, request, noticeOf(deferred), Effect.succeed(SESSION)));

      assert.strictEqual(requests.length, 1);
      assert.isUndefined(requests[0]?.resumeSessionId);
      assert.include(requests[0]?.prompt, "調べて");
      assert.include(requests[0]?.prompt, "追っている PR が merge された");
      assert.strictEqual(error.stoppedReason, "もう要らない");
    }));
});
