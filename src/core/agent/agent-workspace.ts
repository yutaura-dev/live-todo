import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { pullRequestCommands, truncateDiff } from "./pull-request-context.js";

export class AgentWorkspaceError extends Schema.TaggedError<AgentWorkspaceError>()("AgentWorkspaceError", {
  message: Schema.String,
}) {}

const RepositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** AI に調べさせる作業場所。リポジトリを Task ごとのフォルダに clone して渡す */
export class AgentWorkspace extends Context.Service<AgentWorkspace, {
  /**
   * リポジトリを用意し、PR の情報を集めて書き出す。cwd は clone したリポジトリ、contextDir は PR の情報を置いたフォルダ。
   * contextDir を clone の外に置く理由: clone の中に同じ名前のシンボリックリンクを置かれると、書き出しが
   * リンクをたどってリポジトリの外のファイルを上書きしうるため。
   */
  prepare(repository: string, taskId: number, pullUrl: string): Effect.Effect<{ cwd: string; contextDir: string }, AgentWorkspaceError>;
}>()("live-todo/core/agent/AgentWorkspace") {
  static readonly layer = (root: string) =>
    Layer.effect(
      AgentWorkspace,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fail = (message: string) => () => new AgentWorkspaceError({ message });

        const prepare = Effect.fn("AgentWorkspace.prepare")(function* (repository: string, taskId: number, pullUrl: string) {
          // パスに使うので、owner/repo の形以外（.. など）は受け付けない
          if (!RepositoryName.test(repository) || repository.split("/").includes("..")) {
            return yield* new AgentWorkspaceError({ message: `リポジトリ名が不正: ${repository}` });
          }
          // Claude Code の session は作業ディレクトリに結び付くので、Task ごとに同じ場所を使い続ける
          const taskRoot = `${root}/task-${taskId}`;
          const dir = `${taskRoot}/repo/${repository}`;
          const exists = yield* fs.exists(`${dir}/.git`).pipe(Effect.orElseSucceed(() => false));
          const command = exists
            ? ChildProcess.make("git", ["-C", dir, "pull", "--ff-only", "--depth", "1"])
            : ChildProcess.make("gh", ["repo", "clone", repository, dir, "--", "--depth", "1"]);
          if (!exists) yield* fs.makeDirectory(`${taskRoot}/repo`, { recursive: true }).pipe(Effect.mapError(fail("作業場所を作れない")));
          const exitCode = yield* spawner.exitCode(command).pipe(Effect.mapError(fail(`${repository} を取得できない`)));
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* new AgentWorkspaceError({ message: `${repository} を取得できない（終了コード ${exitCode}）` });
          }

          const commands = pullRequestCommands(pullUrl);
          const view = yield* spawner.string(ChildProcess.make("gh", commands.view)).pipe(Effect.mapError(fail("PR の情報を取れない")));
          const diff = yield* spawner.string(ChildProcess.make("gh", commands.diff)).pipe(Effect.mapError(fail("PR の差分を取れない")));
          const contextDir = `${taskRoot}/context`;
          yield* Effect.all([
            fs.makeDirectory(contextDir, { recursive: true }),
            fs.writeFileString(`${contextDir}/pr.json`, view),
            fs.writeFileString(`${contextDir}/pr.diff`, truncateDiff(diff)),
          ]).pipe(Effect.mapError(fail("PR の情報を書き出せない")));
          return { cwd: dir, contextDir };
        });

        return AgentWorkspace.of({ prepare });
      }),
    );
}
