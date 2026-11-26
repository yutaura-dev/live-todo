import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { asc, eq, isNotNull } from "drizzle-orm";
import { Config, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { EnvSecretStore } from "../core/config/secret-store.js";
import { Database } from "../core/db/database.js";
import { sourceItems, taskChanges, taskLinks } from "../core/db/schema.js";
import { type DatasetEntry, type EvalCase, type EvalPrediction, evaluate, labelFromUserActions, mergeDataset } from "../core/judge/evaluation.js";
import { DecisionsProvider, makeTodoJudge, StructuredClassifier } from "../core/judge/todo-judge.js";
import { withOwnershipNote } from "../sources/github/github-binding.js";
import { loadAppConfigFile } from "./config/app-config.js";
import { judgeThresholdsFor, makeDecisionsProvider, makeStructuredClassifier } from "./llm.js";

const JudgeRequestSchema = Schema.Struct({ input: Schema.String, question: Schema.String, context: Schema.optionalKey(Schema.String) });
const StoredJudgment = Schema.Struct({ request: JudgeRequestSchema });
const DatasetSchema = Schema.Array(
  Schema.Struct({ id: Schema.String, title: Schema.String, request: JudgeRequestSchema, expected: Schema.NullOr(Schema.Literals(["todo", "not_todo"])) }),
);
const decodeStored = Schema.decodeUnknownOption(StoredJudgment);
const parseDataset = Schema.decodeUnknownEffect(Schema.fromJsonString(DatasetSchema));

const datasetPath = Config.String("LIVE_TODO_JUDGE_DATASET").pipe(Config.withDefault("./judge-dataset.json"));

const readDataset = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* datasetPath;
  if (!(yield* fs.exists(path))) return [] as DatasetEntry[];
  return [...(yield* parseDataset(yield* fs.readFileString(path)))];
});

/** 判定済みの Item（LLM / Decisions に渡した入力が残っているもの）を、正解を付けるためのファイルに書き出す */
const exportDataset = Effect.gen(function* () {
  const db = yield* Database;
  const rows = yield* db.select().from(sourceItems).where(isNotNull(sourceItems.judgment));
  const exported = [];
  for (const row of rows) {
    const stored = decodeStored(row.judgment);
    if (Option.isNone(stored)) continue;
    // 紐づいた Task へのユーザーの操作（dismissed にした・自分で状態を動かした）から正解を読み取る
    const changes = yield* db
      .select({ kind: taskChanges.kind, field: taskChanges.field, after: taskChanges.after, actor: taskChanges.actor })
      .from(taskLinks)
      .innerJoin(taskChanges, eq(taskChanges.taskId, taskLinks.taskId))
      .where(eq(taskLinks.sourceItemId, row.id))
      .orderBy(asc(taskChanges.id));
    exported.push({ id: `${row.source}|${row.externalId}`, title: row.title, request: stored.value.request, expected: labelFromUserActions(changes) });
  }
  const merged = mergeDataset(yield* readDataset, exported);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* datasetPath;
  yield* fs.writeFileString(path, `${JSON.stringify(merged, null, 2)}\n`);
  const labeled = merged.filter((entry) => entry.expected !== null).length;
  yield* Effect.log(`${path} に ${merged.length} 件を書き出した（正解あり ${labeled} 件）。各件の expected に "todo" か "not_todo" を書く`);
});

/** 正解の付いた件を、structured output と Decisions の両方で判定し直して比べる */
const runEvaluation = Effect.gen(function* () {
  const config = yield* loadAppConfigFile(yield* Config.String("LIVE_TODO_CONFIG").pipe(Config.withDefault("./config.json")));
  const accountId = yield* Config.option(Config.String("LIVE_TODO_EVAL_ACCOUNT"));
  const account = Option.match(accountId, {
    onNone: () => config.accounts[0],
    onSome: (id) => config.accounts.find((candidate) => candidate.id === id),
  });
  if (account === undefined) return yield* Effect.logError("評価に使うアカウントが見つからない");
  const profile = account.resolvedLlmProfile;

  const cases: EvalCase[] = (yield* readDataset).flatMap((entry) =>
    entry.expected === null ? [] : [{ id: entry.id, title: entry.title, request: entry.request, expected: entry.expected }],
  );
  if (cases.length === 0) return yield* Effect.logWarning("正解の付いた件がない。judge:export のあと expected を書く");

  const classifier = yield* makeStructuredClassifier(profile);
  const decisions = yield* makeDecisionsProvider(profile);
  const thresholds = judgeThresholdsFor(profile);

  const predict = Effect.fnUntraced(function* (evalCase: EvalCase, useDecisions: boolean) {
    const judge = yield* makeTodoJudge({
      rules: [],
      // 保存したときより後に足した信頼できる情報（自分の PR であること）も、本番と同じように足して判定する
      describe: () => Effect.succeed({ input: evalCase.request.input, ...(evalCase.request.context === undefined ? {} : { context: withOwnershipNote(evalCase.request.context) }) }),
      question: evalCase.request.question,
      thresholds,
    });
    const run = judge(evalCase).pipe(Effect.provideService(StructuredClassifier, classifier));
    const judgment = useDecisions && Option.isSome(decisions)
      ? yield* run.pipe(Effect.provideService(DecisionsProvider, decisions.value))
      : yield* run;
    return { verdict: judgment.verdict, ...(judgment.method === "decisions" && judgment.probability !== undefined ? { probability: judgment.probability } : {}) } satisfies EvalPrediction;
  });

  const methods = [{ name: `structured（${profile.provider} / ${profile.model}）`, useDecisions: false }];
  if (Option.isSome(decisions)) methods.push({ name: `decisions（${profile.decisions?.provider}）`, useDecisions: true });

  for (const method of methods) {
    const predictions: Record<string, EvalPrediction> = {};
    for (const evalCase of cases) {
      const prediction = yield* predict(evalCase, method.useDecisions).pipe(
        // 1 件の判定の失敗で評価全体を止めない。失敗した件は要確認として数える
        Effect.map(Option.some),
        Effect.catch((error) => Effect.logWarning("判定に失敗した").pipe(Effect.annotateLogs({ id: evalCase.id, error: String(error) }), Effect.as(Option.none<EvalPrediction>()))),
      );
      if (Option.isSome(prediction)) predictions[evalCase.id] = prediction.value;
    }
    const { cases: perCase, ...report } = evaluate(cases, predictions);
    const titleOf = (id: string) => cases.find((evalCase) => evalCase.id === id)?.title ?? id;
    const MARK = { correct: "✓", missed: "✗ 取りこぼし", false_todo: "✗ 余計な todo", review: "? 要確認" } as const;
    console.log(`\n## ${method.name}`);
    for (const result of perCase) {
      const probability = result.probability === undefined ? "" : ` p=${result.probability.toFixed(2)}`;
      console.log(`  ${MARK[result.outcome]}  正解=${result.expected} 判定=${result.verdict}${probability}  ${result.title}`);
    }
    console.log(JSON.stringify({ ...report, missedTodos: report.missedTodos.map(titleOf), falseTodos: report.falseTodos.map(titleOf) }, null, 2));
  }
});

const mode = process.argv[2];

const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const filename = yield* Config.String("LIVE_TODO_DB").pipe(Config.withDefault("./live-todo.db"));
    return Database.layer.pipe(Layer.provideMerge(SqliteClient.layer({ filename })));
  }),
);

const AppLayer = Layer.mergeAll(DatabaseLive, EnvSecretStore, FetchHttpClient.layer, NodeFileSystem.layer);

// 三項演算子で選ばない理由: エラーの型が違う 2 つの Effect の union になり、Effect.provide に渡せないため
if (mode === "run") {
  NodeRuntime.runMain(runEvaluation.pipe(Effect.provide(AppLayer)));
} else {
  NodeRuntime.runMain(exportDataset.pipe(Effect.provide(AppLayer)));
}
