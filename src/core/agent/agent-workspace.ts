import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { headShaOf, pullRequestCommands, truncateDiff } from "./pull-request-context.js";

export class AgentWorkspaceError extends Schema.TaggedError<AgentWorkspaceError>()("AgentWorkspaceError", {
  message: Schema.String,
}) {}

/** 作業場所を用意するコマンド。2 回目からは pull ではなく、最新の commit だけを取り直して合わせる（浅い clone の pull は失敗しやすい） */
export function workspaceCommands(options: { exists: boolean; repository: string; dir: string }): Array<[string, string[]]> {
  if (!options.exists) return [["gh", ["repo", "clone", options.repository, options.dir, "--", "--depth", "1"]]];
  return [
    ["git", ["-C", options.dir, "fetch", "--depth", "1", "origin", "HEAD"]],
    // 作業場所は AI が読むためだけのもので誰も書き換えないので、取り直した状態で上書きしてよい
    ["git", ["-C", options.dir, "reset", "--hard", "FETCH_HEAD"]],
  ];
}

const RepositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** AI に調べさせる作業場所。リポジトリを Task ごとのフォルダに clone して渡す */
export class AgentWorkspace extends Context.Service<AgentWorkspace, {
  /**
   * リポジトリを用意し、PR の情報を集めて書き出す。cwd は clone したリポジトリ、contextDir は PR の情報を置いたフォルダ。
   * contextDir を clone の外に置く理由: clone の中に同じ名前のシンボリックリンクを置かれると、書き出しが
   * リンクをたどってリポジトリの外のファイルを上書きしうるため。
   */
  prepare(
    repository: string,
    taskId: number,
    pullUrl: string,
  ): Effect.Effect<{ cwd: string; contextDir: string; headSha: string | undefined }, AgentWorkspaceError>;
  /** Task の情報をファイルに書き出す（リポジトリの要らない調査のため）。書き出したフォルダのパスを返す */
  writeContext(taskId: number, files: Readonly<Record<string, string>>): Effect.Effect<string, AgentWorkspaceError>;
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
          if (!exists) yield* fs.makeDirectory(`${taskRoot}/repo`, { recursive: true }).pipe(Effect.mapError(fail("作業場所を作れない")));
          for (const [command, args] of workspaceCommands({ exists, repository, dir })) {
            const exitCode = yield* spawner.exitCode(ChildProcess.make(command, args)).pipe(Effect.mapError(fail(`${repository} を取得できない`)));
            if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
              return yield* new AgentWorkspaceError({ message: `${repository} を取得できない（${command} ${args[args.indexOf(dir) + 1] ?? args[0]} が終了コード ${exitCode}）` });
            }
          }
          const commands = pullRequestCommands(pullUrl);
          const view = yield* spawner.string(ChildProcess.make("gh", commands.view)).pipe(Effect.mapError(fail("PR の情報を取れない")));
          const diff = yield* spawner.string(ChildProcess.make("gh", commands.diff)).pipe(Effect.mapError(fail("PR の差分を取れない")));
          // 情報と差分を取る間に commit が足されると、AI が読む差分と merge のときに指定する commit がずれる。
          // ずれたら今回は調べず、PR の更新として次の回に調べ直す
          const headAfter = yield* spawner.string(ChildProcess.make("gh", commands.head)).pipe(Effect.mapError(fail("PR の head を確かめられない")));
          if (headShaOf(view) === undefined || headShaOf(view) !== headShaOf(headAfter)) {
            return yield* new AgentWorkspaceError({ message: "PR の情報を集めている間に PR が更新された" });
          }
          const contextDir = `${taskRoot}/context`;
          yield* Effect.all([
            fs.makeDirectory(contextDir, { recursive: true }),
            fs.writeFileString(`${contextDir}/pr.json`, view),
            fs.writeFileString(`${contextDir}/pr.diff`, truncateDiff(diff)),
          ]).pipe(Effect.mapError(fail("PR の情報を書き出せない")));
          return { cwd: dir, contextDir, headSha: headShaOf(view) };
        });

        const writeContext = Effect.fn("AgentWorkspace.writeContext")(function* (taskId: number, files: Readonly<Record<string, string>>) {
          const contextDir = `${root}/task-${taskId}/context`;
          yield* fs.makeDirectory(contextDir, { recursive: true }).pipe(Effect.mapError(fail("作業場所を作れない")));
          for (const [name, content] of Object.entries(files)) {
            // パスに使うので、決まった形のファイル名だけを受け付ける
            if (!/^[a-z][a-z.-]*$/.test(name)) return yield* new AgentWorkspaceError({ message: `ファイル名が不正: ${name}` });
            yield* fs.writeFileString(`${contextDir}/${name}`, content).pipe(Effect.mapError(fail("Task の情報を書き出せない")));
          }
          return contextDir;
        });

        return AgentWorkspace.of({ prepare, writeContext });
      }),
    );
}
