import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class ClaudeCodeError extends Schema.TaggedError<ClaudeCodeError>()("ClaudeCodeError", {
  message: Schema.String,
  /** 決まった形の回答だけが欠けていたとき、その session を続けて頼み直すための id */
  retrySessionId: Schema.optional(Schema.String),
}) {}

export type ClaudeRequest = {
  prompt: string;
  /** Claude Code の session は作業ディレクトリに結び付く。続けるときは同じ場所を渡す */
  cwd: string;
  resumeSessionId?: string | undefined;
  /** 作業ディレクトリのほかに読ませるフォルダ（アプリが書き出した PR の情報など） */
  addDirs?: ReadonlyArray<string> | undefined;
  jsonSchema: object;
  allowedTools: ReadonlyArray<string>;
  /** 許したツールの中でも禁止するもの（Bash を許すときの git push・gh など） */
  disallowedTools?: ReadonlyArray<string> | undefined;
  /** コマンドを任せるときに、git・gh の認証を渡さない（外部への書き込みを承認なしにさせないため）。空のフォルダを gh の設定に使う */
  withoutCredentials?: { ghConfigDir: string } | undefined;
  /** Bash を OS の sandbox に閉じ込める（書き込みは作業ディレクトリと allowWrite、通信は allowedDomains だけ。ADR-0012） */
  sandbox?:
    | {
        allowedDomains: ReadonlyArray<string>;
        denyRead: ReadonlyArray<string>;
        allowRead?: ReadonlyArray<string>;
        allowWrite: ReadonlyArray<string>;
        /** macOS の証明書の確認（trustd）を許す。gh のような Go のコマンドは、これがないと TLS の確認で失敗する */
        weakerNetworkIsolation?: boolean;
      }
    | undefined;
  /** 追加で渡す環境変数（パッケージのキャッシュの場所など） */
  env?: Readonly<Record<string, string>> | undefined;
  model?: string | undefined;
  maxBudgetUsd?: number | undefined;
};

export type ClaudeResult = { sessionId: string; structured: unknown; costUsd: number | undefined; permissionDenials: number };

/** "Bash(gh pr view:*)" のような許可の書き方から、ツールの名前（Bash）だけを取り出す */
const toolNamesOf = (allowedTools: ReadonlyArray<string>) => [...new Set(allowedTools.map((tool) => tool.replace(/\(.*$/, "")))];

/**
 * claude -p に渡す引数。外部への書き込みを承認なしにさせない（charter）ため、
 * 許可したツール以外は確認を出さずに拒否させ、権限の確認を飛ばすオプションは決して付けない。
 */
export function claudeArgs(request: ClaudeRequest): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(request.jsonSchema),
    "--permission-prompts",
    "none",
    // 作業ディレクトリは clone したリポジトリなので、その中の設定（.claude の hooks や .mcp.json）を読ませない。
    // --restricted は設定ファイルを読まず、ファイルの読み取りを作業ディレクトリに閉じ、--tools に挙げないツールを外す
    "--restricted",
    "--strict-mcp-config",
    "--tools",
    ...toolNamesOf(request.allowedTools),
    ...(request.resumeSessionId === undefined ? [] : ["--resume", request.resumeSessionId]),
    ...(request.addDirs ?? []).flatMap((dir) => ["--add-dir", dir]),
    ...(request.model === undefined ? [] : ["--model", request.model]),
    ...(request.maxBudgetUsd === undefined ? [] : ["--max-budget-usd", String(request.maxBudgetUsd)]),
    ...(request.disallowedTools === undefined || request.disallowedTools.length === 0 ? [] : ["--disallowedTools", ...request.disallowedTools]),
    ...(request.sandbox === undefined
      ? []
      : [
          "--settings",
          JSON.stringify({
            sandbox: {
              enabled: true,
              // sandbox を起動できないときに、閉じ込めずに動かすことをさせない
              failIfUnavailable: true,
              allowUnsandboxedCommands: false,
              ...(request.sandbox.weakerNetworkIsolation === true ? { enableWeakerNetworkIsolation: true } : {}),
              filesystem: {
                denyRead: request.sandbox.denyRead,
                ...(request.sandbox.allowRead === undefined ? {} : { allowRead: request.sandbox.allowRead }),
                allowWrite: request.sandbox.allowWrite,
              },
              network: { allowedDomains: request.sandbox.allowedDomains, strictAllowlist: true },
            },
          }),
        ]),
    // 可変長の引数なので最後に置く。プロンプトは標準入力で渡す
    "--allowedTools",
    ...request.allowedTools,
  ];
}

/** claude に渡す環境変数。アプリの秘密情報（トークンや API キー）は調査に要らないので渡さない */
const CREDENTIAL_KEYS = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"]);

export function childEnv(env: Record<string, string | undefined>, options: { withoutCredentials?: { ghConfigDir: string } | undefined } = {}): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("LIVE_TODO_SECRET_") && (options.withoutCredentials === undefined || !CREDENTIAL_KEYS.has(entry[0])),
    ),
  );
  if (options.withoutCredentials === undefined) return base;
  return {
    ...base,
    // git の全体の設定（gh の認証を使う credential.helper など）とシステムの設定を読ませない
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "false",
    // 空のフォルダを gh の設定にして、ログインしていない状態にする
    GH_CONFIG_DIR: options.withoutCredentials.ghConfigDir,
  };
}

const ClaudeOutput = Schema.Struct({
  is_error: Schema.Boolean,
  subtype: Schema.String,
  session_id: Schema.String,
  total_cost_usd: Schema.optional(Schema.Number),
  permission_denials: Schema.optional(Schema.Array(Schema.Unknown)),
  structured_output: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  terminal_reason: Schema.optional(Schema.String),
});
const decodeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeOutput));

export const decodeClaudeOutput = Effect.fnUntraced(function* (stdout: string) {
  const output = yield* decodeOutput(stdout).pipe(
    Effect.mapError(() => new ClaudeCodeError({ message: `claude の出力を読めない: ${stdout.slice(0, 300)}` })),
  );
  if (output.is_error) return yield* new ClaudeCodeError({ message: `claude が失敗した（${output.subtype}）` });
  if (output.structured_output === undefined || output.structured_output === null) {
    return yield* new ClaudeCodeError({
      retrySessionId: output.session_id,
      message: `claude が決まった形の回答を返さなかった（${output.terminal_reason ?? output.subtype}）: ${String(output.result ?? "").slice(0, 200)}`,
    });
  }
  return {
    sessionId: output.session_id,
    structured: output.structured_output,
    costUsd: output.total_cost_usd,
    permissionDenials: output.permission_denials?.length ?? 0,
  } satisfies ClaudeResult;
});

// 1 回の調査にかけてよい時間。止まったままのプロセスでレーンが詰まらないようにする
const RUN_TIMEOUT = "20 minutes";

export class ClaudeCode extends Context.Service<ClaudeCode, {
  run(request: ClaudeRequest): Effect.Effect<ClaudeResult, ClaudeCodeError>;
}>()("live-todo/core/agent/ClaudeCode") {
  static readonly layer = Layer.effect(
    ClaudeCode,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const failed = (message: string) => () => new ClaudeCodeError({ message });

      const run = Effect.fn("ClaudeCode.run")(function* (request: ClaudeRequest) {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make("claude", claudeArgs(request), {
              cwd: request.cwd,
              env: { ...childEnv(process.env, { withoutCredentials: request.withoutCredentials }), ...request.env },
              extendEnv: false,
              stdin: Stream.make(new TextEncoder().encode(request.prompt)),
            }),
          )
          .pipe(Effect.mapError(failed("claude を起動できない（Claude Code が入っているか確かめてください）")));
        const [stdout, stderr] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.stderr.pipe(Stream.decodeText(), Stream.mkString)],
          { concurrency: 2 },
        ).pipe(Effect.mapError(failed("claude の出力を読めない")));
        const exitCode = yield* handle.exitCode.pipe(Effect.mapError(failed("claude の終了を待てない")));
        // 失敗でも JSON を出すことがあるので、終了コードより先に出力を読む
        if (stdout.trim().startsWith("{")) return yield* decodeClaudeOutput(stdout);
        return yield* new ClaudeCodeError({ message: `claude が終了コード ${exitCode} で終わった: ${stderr.slice(0, 300)}` });
      }, Effect.scoped, Effect.timeoutOrElse({ duration: RUN_TIMEOUT, orElse: () => Effect.fail(new ClaudeCodeError({ message: `${RUN_TIMEOUT} を過ぎても終わらなかった` })) }));

      // 決まった形の回答が欠けることがたまにある（調べ終えたのに回答を出さずに終わる）。
      // 調べ直すと費用がかかるので、同じ session を続けて回答だけを 1 回頼み直す
      const runWithRetry = (request: ClaudeRequest) =>
        run(request).pipe(
          Effect.catch((error) =>
            error.retrySessionId === undefined
              ? Effect.fail(error)
              : run({ ...request, resumeSessionId: error.retrySessionId, prompt: "調べた内容をもとに、指定した JSON Schema の形で回答だけを返してください。" }),
          ),
        );

      return ClaudeCode.of({ run: runWithRetry });
    }),
  );
}
