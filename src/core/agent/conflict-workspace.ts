import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  conflictWorkspaceCommands,
  gitPushEnv,
  hasConflictMarkers,
  isSafeRef,
  trustedGitArgs,
  unexpectedChanges,
} from "./conflict-resolution.js";
import { truncateDiff } from "./pull-request-context.js";

export class ConflictWorkspaceError extends Schema.TaggedError<ConflictWorkspaceError>()("ConflictWorkspaceError", {
  message: Schema.String,
}) {}

export type PreparedMerge = {
  cwd: string;
  repository: string;
  headRef: string;
  baseRef: string;
  /** 直し始めたときの PR の head。push の前に、これから動いていないことを確かめる */
  headSha: string;
  conflicted: ReadonlyArray<string>;
};

const PullInfo = Schema.Struct({
  headRefName: Schema.String,
  baseRefName: Schema.String,
  headRefOid: Schema.String,
  isCrossRepository: Schema.Boolean,
});

/** コンフリクトを直す作業場所。clone・merge・commit・push はアプリが行い、AI にはファイルの編集だけをさせる */
export class ConflictWorkspace extends Context.Service<ConflictWorkspace, {
  prepare(taskId: number, pullUrl: string): Effect.Effect<PreparedMerge, ConflictWorkspaceError>;
  /** 印が残っていないこと・ほかのファイルを変えていないことを確かめて、手元で commit する。差分は PR のブランチから見た変化 */
  commit(cwd: string, conflicted: ReadonlyArray<string>): Effect.Effect<{ commitSha: string; diff: string }, ConflictWorkspaceError>;
  /** ユーザーが承認したあとだけ呼ぶ。PR のブランチが直し始めたときから動いていたら push しない（force はしない） */
  /** commitSha: 承認画面で見せた commit。その commit を名指しで push する */
  push(cwd: string, repository: string, headRef: string, expectedHeadSha: string, commitSha: string, token: string): Effect.Effect<void, ConflictWorkspaceError>;
}>()("live-todo/core/agent/ConflictWorkspace") {
  static readonly layer = (root: string) =>
    Layer.effect(
      ConflictWorkspace,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        const fail = (message: string) => () => new ConflictWorkspaceError({ message });
        const text = (command: string, args: ReadonlyArray<string>, message: string, env?: Record<string, string>) =>
          spawner.string(ChildProcess.make(command, [...args], env === undefined ? {} : { env, extendEnv: true })).pipe(Effect.mapError(fail(message)));
        const exitCode = (command: string, args: ReadonlyArray<string>, message: string) =>
          spawner.exitCode(ChildProcess.make(command, [...args])).pipe(Effect.mapError(fail(message)));

        // git のデータは作業ディレクトリの外に置く（AI は作業ディレクトリの中しか触れない）
        const gitDirOf = (cwd: string) => `${cwd}.git`;
        const safeGitEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
        const git = (cwd: string, args: ReadonlyArray<string>, message: string, env: Record<string, string> = safeGitEnv) =>
          text("git", trustedGitArgs(gitDirOf(cwd), cwd, args), message, env);

        const prepare = Effect.fn("ConflictWorkspace.prepare")(function* (taskId: number, pullUrl: string) {
          const repository = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+$/.exec(pullUrl)?.[1];
          if (repository === undefined) return yield* new ConflictWorkspaceError({ message: `GitHub の PR の URL ではない: ${pullUrl}` });
          const info = yield* text("gh", ["pr", "view", pullUrl, "--json", "headRefName,baseRefName,headRefOid,isCrossRepository"], "PR の情報を取れない").pipe(
            Effect.flatMap((raw) => Schema.decodeUnknownEffect(Schema.fromJsonString(PullInfo))(raw).pipe(Effect.mapError(fail("PR の情報を読めない")))),
          );
          // fork からの PR は、元のリポジトリに push しても PR のブランチは変わらない
          if (info.isCrossRepository) return yield* new ConflictWorkspaceError({ message: "fork からの PR は、アプリでは直せない" });
          if (!isSafeRef(info.headRefName) || !isSafeRef(info.baseRefName)) {
            return yield* new ConflictWorkspaceError({ message: "ブランチ名に使えない文字がある" });
          }

          const dir = `${root}/task-${taskId}/conflict`;
          yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
          yield* fs.remove(gitDirOf(dir), { recursive: true }).pipe(Effect.ignore);
          const commands = conflictWorkspaceCommands({ repository, dir, gitDir: gitDirOf(dir), headRef: info.headRefName, baseRef: info.baseRefName });
          for (const [command, args] of [commands.clone, commands.checkout]) {
            const code = yield* exitCode(command, args, `${repository} を用意できない`);
            if (code !== 0) return yield* new ConflictWorkspaceError({ message: `${repository} を用意できない（終了コード ${code}）` });
          }
          const head = (yield* git(dir, ["rev-parse", "HEAD"], "PR のブランチの commit を読めない")).trim();
          if (head !== info.headRefOid) return yield* new ConflictWorkspaceError({ message: "PR のブランチが取得の途中で進んだ。もう一度直してください" });

          // コンフリクトがあると終了コードは 1 になる。それ以外の失敗は、コンフリクトしたファイルの一覧で見分ける
          yield* exitCode(commands.merge[0], commands.merge[1], `${info.baseRefName} を merge できない`);
          const conflicted = (yield* git(dir, ["diff", "--name-only", "--diff-filter=U"], "コンフリクトしたファイルを読めない"))
            .split("\n")
            .filter((line) => line !== "");
          return { cwd: dir, repository, headRef: info.headRefName, baseRef: info.baseRefName, headSha: head, conflicted } satisfies PreparedMerge;
        });

        const commit = Effect.fn("ConflictWorkspace.commit")(function* (cwd: string, conflicted: ReadonlyArray<string>) {
          for (const path of conflicted) {
            const content = yield* fs.readFileString(`${cwd}/${path}`).pipe(Effect.orElseSucceed(() => ""));
            if (hasConflictMarkers(content)) return yield* new ConflictWorkspaceError({ message: `コンフリクトの印が残っている: ${path}` });
          }
          const unexpected = unexpectedChanges(yield* git(cwd, ["status", "--porcelain"], "変更を読めない"), conflicted);
          if (unexpected.length > 0) {
            return yield* new ConflictWorkspaceError({ message: `コンフリクトしていないファイルが変わっている: ${unexpected.join(", ")}` });
          }
          if (conflicted.length > 0) yield* git(cwd, ["add", "--", ...conflicted], "直したファイルを登録できない");
          yield* git(cwd, ["commit", "--no-verify", "--no-edit"], "commit できない");
          const commitSha = (yield* git(cwd, ["rev-parse", "HEAD"], "commit を読めない")).trim();
          const diff = yield* git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "HEAD^1", "HEAD", "--", ...conflicted], "差分を読めない");
          return { commitSha, diff: truncateDiff(diff) };
        });

        const push = Effect.fn("ConflictWorkspace.push")(function* (cwd: string, repository: string, headRef: string, expectedHeadSha: string, commitSha: string, token: string) {
          // 承認した commit が、直し始めたときの PR の head にベースを取り込んだものかを確かめる
          const parent = (yield* git(cwd, ["rev-parse", `${commitSha}^1`], "承認した commit が見つからない。もう一度直してください")).trim();
          if (parent !== expectedHeadSha) return yield* new ConflictWorkspaceError({ message: "承認した commit が、直し始めたときの PR のブランチから作られていない" });
          // origin ではなく URL を指す（設定の書き換えで、トークンを別の宛先に送らせない）
          const url = `https://github.com/${repository}.git`;
          const env = gitPushEnv(token);
          const remote = (yield* git(cwd, ["ls-remote", url, `refs/heads/${headRef}`], "PR のブランチを確かめられない", env)).split(/\s/)[0];
          if (remote !== expectedHeadSha) {
            return yield* new ConflictWorkspaceError({ message: "直し始めたあとに PR のブランチへ commit が足された。もう一度直してください" });
          }
          const code = yield* spawner
            .exitCode(ChildProcess.make("git", trustedGitArgs(gitDirOf(cwd), cwd, ["push", "--no-verify", url, `${commitSha}:refs/heads/${headRef}`]), { env, extendEnv: true }))
            .pipe(Effect.mapError(fail("push できない")));
          if (code !== 0) return yield* new ConflictWorkspaceError({ message: `push できない（終了コード ${code}）。トークンに PR のブランチへ書き込む権限があるか確かめてください` });
        });

        return ConflictWorkspace.of({ prepare, commit, push });
      }),
    );
}
