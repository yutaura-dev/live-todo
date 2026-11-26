import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { and, eq, gte, lt, or } from "drizzle-orm";
import { Config, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode } from "../core/agent/claude-code.js";
import { decodeMailThreadDecision, MAIL_THREAD_TRIAGE_JSON_SCHEMA, mailThreadTriagePrompt } from "../core/agent/conversation-triage.js";
import { decodeProposedPlan, NEXT_ACTION_PLAN_JSON_SCHEMA, nextActionPrompt, planFromProposal } from "../core/agent/next-action-planning.js";
import { EnvSecretStore } from "../core/config/secret-store.js";
import { Database } from "../core/db/database.js";
import { gmailMessages } from "../core/db/schema.js";
import type { NextActionPlan } from "../core/task/next-actions.js";
import { planIssues, scoreTriage, type TriageExpectation, type TriagePrediction } from "../core/judge/mail-evaluation.js";
import { GmailClient } from "../sources/gmail/gmail-client.js";
import { GmailClientLive, Gws } from "../sources/gmail/gmail-client-live.js";
import { classificationRequest } from "../sources/gmail/gmail-ingest.js";
import { loadAppConfigFile } from "./config/app-config.js";
import { makeMailClassifier } from "./llm.js";

/**
 * メールの判定の評価。実際のメールのスレッドで「対応が要るか（Decisions）→ Task にするか（Claude Code）→ 手順（Claude Code）」を
 * 本番と同じ指示で流し、正解と比べる。判定の指示を変える前と後で run して、結果のファイルを比べる。
 *   pnpm mail:eval export        正解を付けるファイル（mail-eval-dataset.json）に、スレッドを書き出す（付けた正解は残す）
 *   pnpm mail:eval run <名前>     正解の付いた件を判定し、mail-eval-results-<名前>.json に残す（実 API を呼ぶので課金される）
 * データセットと結果にはメールの本文が入るので、リポジトリに入れない（.gitignore）
 */

const MAX_TEXT = 4000;
const ACTION_PROBABILITY = 0.5;
const CONCURRENCY = 4;
const MODEL = "sonnet";
const BUDGET_USD = 2;

const MessageSchema = Schema.Struct({
  messageId: Schema.String,
  kind: Schema.String,
  senderName: Schema.String,
  senderKey: Schema.String,
  subject: Schema.String,
  listUnsubscribe: Schema.Boolean,
  who: Schema.String,
  isMe: Schema.Boolean,
  at: Schema.String,
  text: Schema.String,
  /** 人・お知らせ・メルマガの仕分けに渡す入力（本番と同じ形） */
  classify: Schema.optionalKey(Schema.Struct({ input: Schema.String, context: Schema.String })),
});
const CaseSchema = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  sender: Schema.String,
  messages: Schema.Array(MessageSchema),
  expected: Schema.NullOr(Schema.Literals(["task", "none", "either"])),
  note: Schema.String,
});
type EvalCase = typeof CaseSchema.Type;
const parseDataset = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(CaseSchema)));

const datasetPath = Config.String("LIVE_TODO_MAIL_EVAL_DATASET").pipe(Config.withDefault("./mail-eval-dataset.json"));
const configPath = Config.String("LIVE_TODO_CONFIG").pipe(Config.withDefault("./config.json"));

const readDataset = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* datasetPath;
  if (!(yield* fs.exists(path))) return [] as EvalCase[];
  return [...(yield* parseDataset(yield* fs.readFileString(path)))];
});

const accountOf = Effect.gen(function* () {
  const config = yield* loadAppConfigFile(yield* configPath);
  const account = config.gmailAccounts[0];
  if (account === undefined) return yield* Effect.die("設定に Gmail のアカウントがない");
  return account;
});

/** 対応が要りそうなメール（確率 0.3 以上）・人からのメールのスレッドと、比べるための確率の低いスレッドを書き出す */
const exportDataset = Effect.gen(function* () {
  const db = yield* Database;
  const account = yield* accountOf;
  const client = yield* GmailClient;
  const likely = yield* db
    .select({ threadId: gmailMessages.threadId })
    .from(gmailMessages)
    .where(and(eq(gmailMessages.accountId, account.id), or(gte(gmailMessages.actionProbability, 0.3), eq(gmailMessages.kind, "personal"))))
    .pipe(Effect.orDie);
  const unlikely = yield* db
    .select({ threadId: gmailMessages.threadId })
    .from(gmailMessages)
    .where(and(eq(gmailMessages.accountId, account.id), lt(gmailMessages.actionProbability, 0.3)))
    .limit(12)
    .pipe(Effect.orDie);
  const threadIds = [...new Set([...likely, ...unlikely].map((row) => row.threadId))];
  const existing = new Map((yield* readDataset).map((entry) => [entry.id, entry]));
  const cases: EvalCase[] = [];
  for (const threadId of threadIds) {
    const stored = yield* db.select().from(gmailMessages).where(and(eq(gmailMessages.accountId, account.id), eq(gmailMessages.threadId, threadId))).pipe(Effect.orDie);
    const fetched = yield* client.thread(threadId).pipe(Effect.option);
    if (Option.isNone(fetched)) continue;
    const byId = new Map(stored.map((row) => [row.messageId, row]));
    const messages = fetched.value
      .filter((message) => !message.labelIds.includes("DRAFT"))
      .map((message) => {
        const row = byId.get(message.id);
        const isMe = message.labelIds.includes("SENT");
        return {
          messageId: message.id,
          kind: row?.kind ?? (isMe ? "mine" : "personal"),
          senderName: row?.senderName ?? "",
          senderKey: row?.senderKey ?? "",
          subject: message.headers.subject ?? "",
          listUnsubscribe: row?.listUnsubscribe !== null && row?.listUnsubscribe !== undefined,
          who: isMe ? "me" : (message.headers.from ?? "unknown"),
          isMe,
          at: new Date(message.receivedAt).toISOString(),
          text: message.text.slice(0, MAX_TEXT),
          classify: classificationRequest(message),
        };
      });
    const first = messages.find((message) => !message.isMe) ?? messages[0];
    if (first === undefined) continue;
    const before = existing.get(threadId);
    cases.push({ id: threadId, subject: first.subject, sender: first.senderName, messages, expected: before?.expected ?? null, note: before?.note ?? "" });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* datasetPath;
  yield* fs.writeFileString(path, `${JSON.stringify(cases, null, 2)}\n`);
  yield* Effect.log(`${path} に ${cases.length} 件を書き出した。各件の expected に "task" / "none" / "either" を書く`);
});

const runEvaluation = (label: string) =>
  Effect.gen(function* () {
    const account = yield* accountOf;
    const classifier = yield* makeMailClassifier(account.resolvedLlmProfile);
    const claude = yield* ClaudeCode;
    const workspace = yield* AgentWorkspace;
    const cases = (yield* readDataset).filter((entry) => entry.expected !== null);
    if (cases.length === 0) return yield* Effect.logWarning("正解の付いた件がない。export のあと expected を書く");

    const results = yield* Effect.forEach(
      cases,
      (entry) =>
        Effect.gen(function* () {
          // 1. 人・お知らせ・メルマガに仕分け、人からのメールでないものは、対応が要るかを差出人と件名で判定する（本番と同じ）
          const probabilities: Array<number | null> = [];
          const kinds: string[] = [];
          for (const message of entry.messages) {
            if (message.isMe) continue;
            // 仕分けの入力がない古い書き出しは、保存してある仕分けを使う
            const kind =
              message.classify === undefined
                ? message.kind
                : Option.match(yield* classifier.classify(message.classify).pipe(Effect.option), { onNone: () => "personal", onSome: (value) => value.kind });
            kinds.push(kind);
            if (kind === "personal") continue;
            const answer = yield* classifier
              .needsAction({
                input: [`差出人: ${message.senderName} <${message.senderKey}>`, `件名: ${message.subject}`].join("\n"),
                context: `List-Unsubscribe: ${message.listUnsubscribe ? "あり" : "なし"}`,
              })
              .pipe(Effect.option);
            probabilities.push(Option.match(answer, { onNone: () => null, onSome: (value) => value.probability ?? null }));
          }
          const personal = kinds.includes("personal");
          const gated = personal || probabilities.some((probability) => probability !== null && probability >= ACTION_PROBABILITY);
          if (!gated) return { id: entry.id, subject: entry.subject, expected: entry.expected, predicted: "none" as TriagePrediction, stage: "gate", kinds, probabilities };

          // 2. Task にするか
          const conversation = { messages: entry.messages.map(({ who, isMe, at, subject, text }) => ({ who, isMe, at, subject, text })), existingTask: null };
          const contextDir = yield* workspace.writeContext(`eval-${label}-${entry.id}`, {
            "conversation.json": JSON.stringify(conversation, null, 2),
            "open-tasks.json": "[]",
            "inbox.json": "[]",
          });
          const triage = yield* claude
            .run({ prompt: mailThreadTriagePrompt({ contextDir }), cwd: contextDir, jsonSchema: MAIL_THREAD_TRIAGE_JSON_SCHEMA, allowedTools: ["Read"], model: MODEL, maxBudgetUsd: BUDGET_USD })
            .pipe(Effect.flatMap((result) => decodeMailThreadDecision(result.structured).pipe(Effect.map((decision) => ({ decision, costUsd: result.costUsd ?? 0 })))), Effect.result);
          if (triage._tag === "Failure") return { id: entry.id, subject: entry.subject, expected: entry.expected, predicted: "failed" as TriagePrediction, stage: "triage", kinds, probabilities, error: String(triage.failure) };
          const { decision, costUsd } = triage.success;
          const predicted: TriagePrediction = decision.decision === "none" ? "none" : "task";
          const base = { id: entry.id, subject: entry.subject, expected: entry.expected, predicted, stage: "triage", kinds, probabilities, reason: decision.reason, title: decision.title, brief: decision.brief, costUsd };
          if (predicted !== "task" || entry.expected !== "task") return base;

          // 3. 手順（Task にすべきものを Task にしたときだけ）
          const planDir = yield* workspace.writeContext(`eval-${label}-${entry.id}-plan`, {
            "task.json": JSON.stringify(
              {
                title: decision.title,
                brief: decision.brief,
                items: [{ role: "tracks", source: `gmail:${account.id}:threads`, title: entry.subject, url: `https://mail.google.com/mail/u/0/#all/${entry.id}`, state: "open" }],
              },
              null,
              2,
            ),
            // 本番の質問・手順と同じく、元のメールのスレッドを渡す
            "mail.json": JSON.stringify(entry.messages.map(({ who, at, subject, text }) => ({ from: who, at, subject, text })), null, 2),
          });
          const planned = yield* claude
            .run({ prompt: nextActionPrompt({ title: decision.title, contextDir: planDir }), cwd: planDir, jsonSchema: NEXT_ACTION_PLAN_JSON_SCHEMA, allowedTools: ["Read", "Grep", "Glob", "WebSearch"], model: MODEL, maxBudgetUsd: BUDGET_USD })
            .pipe(Effect.flatMap((result) => decodeProposedPlan(result.structured).pipe(Effect.map((proposal) => ({ plan: planFromProposal(proposal), costUsd: result.costUsd ?? 0 })))), Effect.result);
          if (planned._tag === "Failure") return { ...base, planError: String(planned.failure) };
          return { ...base, plan: planned.success.plan, planIssues: planIssues(planned.success.plan), costUsd: costUsd + planned.success.costUsd };
        }),
      { concurrency: CONCURRENCY },
    );

    const triage = scoreTriage(results.map((result) => ({ id: result.id, expected: result.expected as TriageExpectation, predicted: result.predicted })));
    const planned = results.filter((result) => "plan" in result);
    const issueCounts: Record<string, number> = {};
    for (const result of planned) for (const issue of (result as { planIssues: string[] }).planIssues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    const summary = {
      label,
      gate: {
        passed: results.filter((result) => result.stage !== "gate").length,
        classifiedPersonal: results.filter((result) => result.kinds.includes("personal")).length,
        expectedTaskBlocked: results.filter((result) => result.expected === "task" && result.stage === "gate").map((result) => result.subject),
      },
      triage: { ...triage, missed: triage.missed.map((id) => subjectOf(results, id)), falseTasks: triage.falseTasks.map((id) => subjectOf(results, id)) },
      plans: { count: planned.length, clean: planned.filter((result) => (result as { planIssues: string[] }).planIssues.length === 0).length, issueCounts },
      costUsd: Math.round(results.reduce((sum, result) => sum + ("costUsd" in result ? (result.costUsd as number) : 0), 0) * 100) / 100,
    };
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`./mail-eval-results-${label}.json`, `${JSON.stringify({ summary, results }, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  });

const subjectOf = (results: ReadonlyArray<{ id: string; subject: string }>, id: string) => results.find((result) => result.id === id)?.subject ?? id;

const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const filename = yield* Config.String("LIVE_TODO_DB").pipe(Config.withDefault("./live-todo.db"));
    return Database.layer.pipe(Layer.provideMerge(SqliteClient.layer({ filename, readonly: true })));
  }),
);
const workRoot = Config.String("LIVE_TODO_MAIL_EVAL_WORK").pipe(Config.withDefault("./.mail-eval-work"));
const AppLayer = Layer.mergeAll(
  DatabaseLive,
  EnvSecretStore,
  GmailClientLive.pipe(Layer.provide(Gws.layer)),
  ClaudeCode.layer,
  Layer.unwrap(
    Effect.gen(function* () {
      return AgentWorkspace.layer(yield* workRoot);
    }),
  ),
).pipe(Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)));

/** 残した結果の手順を、今の決まりごとで採点し直す（API は呼ばない） */
const rescore = (label: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `./mail-eval-results-${label}.json`;
    const saved = JSON.parse(yield* fs.readFileString(path)) as { summary: { plans: unknown }; results: Array<{ plan?: NextActionPlan; planIssues?: string[] }> };
    const planned = saved.results.filter((result) => result.plan !== undefined);
    const issueCounts: Record<string, number> = {};
    for (const result of planned) {
      result.planIssues = planIssues(result.plan!);
      for (const issue of result.planIssues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    }
    saved.summary.plans = { count: planned.length, clean: planned.filter((result) => result.planIssues!.length === 0).length, issueCounts };
    yield* fs.writeFileString(path, `${JSON.stringify(saved, null, 2)}\n`);
    console.log(JSON.stringify({ label, plans: saved.summary.plans }));
  });

const mode = process.argv[2];
// 三項演算子で選ばない理由: エラーの型が違う 2 つの Effect の union になり、Effect.provide に渡せないため
if (mode === "rescore") {
  NodeRuntime.runMain(rescore(process.argv[3] ?? "run").pipe(Effect.provide(NodeServices.layer)));
} else if (mode === "run") {
  NodeRuntime.runMain(runEvaluation(process.argv[3] ?? "run").pipe(Effect.provide(AppLayer)));
} else {
  NodeRuntime.runMain(exportDataset.pipe(Effect.provide(AppLayer)));
}
