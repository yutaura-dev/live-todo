import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Config, Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { AgentWorkspace } from "../core/agent/agent-workspace.js";
import { ClaudeCode } from "../core/agent/claude-code.js";
import { proposePlan } from "../core/agent/next-action-runner.js";
import { isDependencyBot } from "../core/agent/dependency-review.js";
import { Database } from "../core/db/database.js";
import { sourceItems, taskLinks, tasks } from "../core/db/schema.js";
import { planIssues } from "../core/judge/mail-evaluation.js";
import type { NextActionPlan, Step } from "../core/task/next-actions.js";
import { TaskRepository } from "../core/task/task-repository.js";
import { GmailClient } from "../sources/gmail/gmail-client.js";
import { GmailClientLive, Gws } from "../sources/gmail/gmail-client-live.js";
import { MailClassifier } from "../core/judge/mail-classifier.js";
import { EnvSecretStore } from "../core/config/secret-store.js";
import { loadAppConfigFile } from "./config/app-config.js";
import { makeMailClassifier } from "./llm.js";

/** 採点に使う Decisions（判定の確率）。本番のメールの仕分けと同じ LLM Profile を使う */
const Grader = MailClassifier;

/**
 * 次にやることの評価。実際の Task（GitHub の PR・issue、Slack、メールのスレッド）の手順を、本番と同じ入力で考え直させ、
 * 決まりごと（mail-evaluation.ts の planIssues と、PR の Task に merge の手順があるか）で採点する。保存はしない。
 *   pnpm plan:eval <名前>   結果を plan-eval-results-<名前>.json に残す（実 API を呼ぶので課金される）
 */

const LIMIT = 16;
const MAX_TEXT = 4000;
const PULL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

const flatten = (steps: ReadonlyArray<Step>): Step[] =>
  steps.flatMap((step) => (step.kind === "decision" ? [step, ...step.options.flatMap((option) => flatten(option.steps))] : [step]));

// 言い回しで決める決まりごとは取り違えが多い（「直す場合の影響を調べる」を書き込みと読む）ので、この 3 つは Decisions で手順ごとに確かめる
const GRADED: ReadonlySet<string> = new Set(["web_step_without_link", "claude_cannot_write", "human_could_research"]);
const GRADE_PROBABILITY = 0.7;
const GRADE_QUESTIONS = {
  web: "この手順をやるには、Web ページ（サービスのサイト・管理画面・GitHub の画面など）を開く必要があるか？",
  write: "この手順は、外部への書き込み（送る・返信・投稿・push・merge・承認・申し込み・支払い・設定の変更）や、本人にしかできない操作（ログイン・本人確認・本人の判断）を含むか？",
  research: "この手順は、資料・メール・コード・Web を読んで調べ、結果を報告するだけで終わるか？",
} as const;

const gradeSteps = (plan: NextActionPlan) =>
  Effect.gen(function* () {
    const grader = yield* Grader;
    const issues = new Set<string>();
    for (const step of flatten(plan.steps)) {
      if (step.kind !== "manual" && step.kind !== "decision") continue;
      const ask = (question: string) =>
        grader.matchesCondition({ input: step.title, context: "", condition: question }).pipe(
          Effect.map((answer) => (answer.probability ?? 0) >= GRADE_PROBABILITY),
          Effect.orElseSucceed(() => false),
        );
      const hasLink = step.link !== undefined || (step.kind === "decision" && flatten(step.options.flatMap((option) => option.steps)).some((child) => child.link !== undefined));
      if (!hasLink && (yield* ask(GRADE_QUESTIONS.web))) issues.add("web_step_without_link");
      if (step.kind !== "manual") continue;
      const writes = yield* ask(GRADE_QUESTIONS.write);
      if (step.actor !== undefined && step.actor !== "human" && writes) issues.add("claude_cannot_write");
      if ((step.actor ?? "human") === "human" && !writes && (yield* ask(GRADE_QUESTIONS.research))) issues.add("human_could_research");
    }
    return [...issues];
  });

const run = (label: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const gmail = yield* GmailClient;
    const rows = yield* db
      .select({ taskId: tasks.id, title: tasks.title, source: sourceItems.source, url: sourceItems.url, state: sourceItems.state, author: sourceItems.author, externalId: sourceItems.externalId })
      .from(taskLinks)
      .innerJoin(tasks, eq(taskLinks.taskId, tasks.id))
      .innerJoin(sourceItems, eq(taskLinks.sourceItemId, sourceItems.id))
      .where(and(eq(taskLinks.role, "tracks"), inArray(tasks.status, ["todo", "in_progress", "done", "needs_review"]), inArray(sourceItems.source, ["github:personal", "slack:yutaura", "slack:yutaura:inbox", "gmail:mail:threads"])))
      .orderBy(desc(tasks.id))
      .pipe(Effect.orDie);
    // 依存更新の bot の PR は依存更新の調査で手順を作るので、除く（本番の手順づくりと同じ）
    const picked = new Map<number, (typeof rows)[number]>();
    for (const row of rows) if (!picked.has(row.taskId) && !(row.url.includes("/pull/") && isDependencyBot(row.author))) picked.set(row.taskId, row);
    // コードの Task も測れるよう、GitHub の Task を半分まで入れる
    const all = [...picked.values()];
    const github = all.filter((row) => row.source.startsWith("github:")).slice(0, LIMIT / 2);
    const cases = [...github, ...all.filter((row) => !row.source.startsWith("github:"))].slice(0, LIMIT);

    const results = yield* Effect.forEach(
      cases,
      (entry) =>
        Effect.gen(function* () {
          const extraContext = (taskId: number) =>
            entry.source !== "gmail:mail:threads" || taskId !== entry.taskId
              ? Effect.succeed({})
              : gmail.thread(entry.externalId).pipe(
                  Effect.map((messages) => ({
                    "mail.json": JSON.stringify(
                      messages.map((message) => ({ from: message.headers.from ?? "", at: new Date(message.receivedAt).toISOString(), subject: message.headers.subject ?? "", text: message.text.slice(0, MAX_TEXT) })),
                      null,
                      2,
                    ),
                  })),
                );
          const outcome = yield* proposePlan(
            entry.taskId,
            { history: undefined, request: undefined, remaining: undefined },
            { model: "sonnet", maxBudgetUsd: 2, extraContext, contextOwner: (taskId) => `plan-eval-${label}-${taskId}` },
          ).pipe(Effect.result);
          if (outcome._tag === "Failure") return { taskId: entry.taskId, title: entry.title, source: entry.source, error: String((outcome.failure as { message?: string }).message ?? outcome.failure) };
          const plan: NextActionPlan = outcome.success.plan;
          const issues: string[] = planIssues(plan).filter((issue) => !GRADED.has(issue));
          issues.push(...(yield* gradeSteps(plan)));
          // 開いている PR を追う Task なのに、アプリで merge する手順がない
          if (PULL.test(entry.url) && entry.state === "open" && !flatten(plan.steps).some((step) => step.kind === "merge_pull_request")) issues.push("pr_without_merge");
          return { taskId: entry.taskId, title: entry.title, source: entry.source, plan, planIssues: issues, costUsd: outcome.success.result.costUsd ?? 0 };
        }),
      { concurrency: 4 },
    );
    const planned = results.filter((result) => "plan" in result) as Array<{ planIssues: string[]; costUsd: number }>;
    const issueCounts: Record<string, number> = {};
    for (const result of planned) for (const issue of result.planIssues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    const steps = planned.flatMap((result) => flatten((result as unknown as { plan: NextActionPlan }).plan.steps));
    const manual = steps.filter((step) => step.kind === "manual");
    const summary = {
      label,
      count: results.length,
      failed: results.length - planned.length,
      clean: planned.filter((result) => result.planIssues.length === 0).length,
      issueCounts,
      actors: {
        manual: manual.length,
        human: manual.filter((step) => step.kind === "manual" && (step.actor ?? "human") === "human").length,
        claudeAuto: manual.filter((step) => step.kind === "manual" && step.actor === "claude_auto").length,
        claudeOnRequest: manual.filter((step) => step.kind === "manual" && step.actor === "claude_on_request").length,
      },
      costUsd: Math.round(planned.reduce((sum, result) => sum + result.costUsd, 0) * 100) / 100,
    };
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`./plan-eval-results-${label}.json`, `${JSON.stringify({ summary, results }, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  });

const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const filename = yield* Config.String("LIVE_TODO_DB").pipe(Config.withDefault("./live-todo.db"));
    return TaskRepository.layer.pipe(Layer.provideMerge(Database.layer), Layer.provideMerge(SqliteClient.layer({ filename, readonly: true })));
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

const program = Effect.gen(function* () {
  const config = yield* loadAppConfigFile(yield* Config.String("LIVE_TODO_CONFIG").pipe(Config.withDefault("./config.json")));
  const account = config.gmailAccounts[0];
  if (account === undefined) return yield* Effect.die("採点に使う Decisions の設定（Gmail のアカウント）がない");
  const grader = yield* makeMailClassifier(account.resolvedLlmProfile);
  return yield* run(process.argv[2] ?? "run").pipe(Effect.provideService(Grader, grader));
});
NodeRuntime.runMain(program.pipe(Effect.provide(AppLayer)));
