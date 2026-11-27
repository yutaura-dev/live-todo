import { and, eq, gte, inArray } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import type { DecisionModel } from "effect/ai";
import { Database } from "../core/db/database.js";
import { activities, taskChanges, taskLinks, taskRuleRuns, tasks } from "../core/db/schema.js";
import { conditionProbability } from "../core/rules/rule-condition.js";
import { type Rule, RULE_MATCH_PROBABILITY } from "../core/rules/rule.js";
import { loadDossier } from "../core/task/dossier.js";
import type { TaskStatus } from "../core/task/task.js";
import { TaskRepository } from "../core/task/task-repository.js";

// 片付いた Task・AI が調べている Task には当てない（利用者や AI が決めた状態を、ルールで上書きしないため）
const OPEN_STATUSES: ReadonlyArray<TaskStatus> = ["todo", "in_progress", "needs_review"];
const TRIGGER_CHANGES = ["created", "link_added"] as const;

type TaskRule = Rule & { condition: NonNullable<Rule["condition"]>; actions: { task: NonNullable<Rule["actions"]["task"]> } };

/** 分けた問いと操作を、読み取ったときの文のまま持っているルールだけを当てる（書き換えたあとに読み取り直していないものは当てない） */
const isApplicable = (rule: Rule): rule is TaskRule =>
  rule.enabled && rule.actions.task !== undefined && rule.condition !== undefined && rule.conditionFrom === rule.when && rule.interpretedFrom === rule.then;

/** ルールの中身。これが変わったルールは、前に判定した Task も判定し直す */
const fingerprintOf = (rule: TaskRule) => JSON.stringify([rule.condition, rule.actions.task]);

export type TaskRuleSummary = { applied: number; notMatched: number; alreadyJudged: number };

/**
 * 利用者が決めたルールを Task に当てる（ADR-0019）。きっかけは Task ができた・事実が紐づいた・紐づく事実に出来事があったこと。
 * Task ごとに一番新しいきっかけで、ルールを作ったあとのものだけを判定する。同じきっかけで判定するのは一度だけ
 */
export const applyTaskRules = Effect.fnUntraced(function* (
  rules: ReadonlyArray<Rule>,
): Effect.fn.Return<TaskRuleSummary, never, Database | TaskRepository | DecisionModel.DecisionModel> {
  const summary: TaskRuleSummary = { applied: 0, notMatched: 0, alreadyJudged: 0 };
  const active = rules.filter(isApplicable);
  if (active.length === 0) return summary;
  const db = yield* Database;
  const repository = yield* TaskRepository;
  const since = DateTime.formatIso(DateTime.makeUnsafe(Math.min(...active.map((rule) => Date.parse(rule.createdAt)))));

  const open = yield* db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.status, [...OPEN_STATUSES])).pipe(Effect.orDie);
  if (open.length === 0) return summary;
  const openIds = open.map((task) => task.id);
  const changes = yield* db
    .select({ taskId: taskChanges.taskId, id: taskChanges.id, at: taskChanges.occurredAt })
    .from(taskChanges)
    .where(and(inArray(taskChanges.taskId, openIds), inArray(taskChanges.kind, [...TRIGGER_CHANGES]), gte(taskChanges.occurredAt, since)))
    .pipe(Effect.orDie);
  const events = yield* db
    .select({ taskId: taskLinks.taskId, id: activities.id, at: activities.occurredAt })
    .from(activities)
    .innerJoin(taskLinks, eq(taskLinks.sourceItemId, activities.sourceItemId))
    .where(and(inArray(taskLinks.taskId, openIds), gte(activities.occurredAt, since)))
    .pipe(Effect.orDie);
  const latest = new Map<number, { key: string; at: number }>();
  for (const trigger of [...changes.map((row) => ({ ...row, key: `change:${row.id}` })), ...events.map((row) => ({ ...row, key: `activity:${row.id}` }))]) {
    const at = Date.parse(trigger.at);
    const current = latest.get(trigger.taskId);
    if (current === undefined || at > current.at) latest.set(trigger.taskId, { key: trigger.key, at });
  }

  const judged = new Set(
    (yield* db
      .select({ taskId: taskRuleRuns.taskId, ruleId: taskRuleRuns.ruleId, fingerprint: taskRuleRuns.ruleFingerprint, key: taskRuleRuns.triggerKey })
      .from(taskRuleRuns)
      .where(inArray(taskRuleRuns.taskId, [...latest.keys()]))
      .pipe(Effect.orDie)).map((run) => `${run.taskId} ${run.ruleId} ${run.fingerprint} ${run.key}`),
  );

  for (const rule of active) {
    const fingerprint = fingerprintOf(rule);
    const createdAt = Date.parse(rule.createdAt);
    for (const [taskId, trigger] of latest) {
      if (trigger.at < createdAt) continue;
      if (judged.has(`${taskId} ${rule.id} ${fingerprint} ${trigger.key}`)) {
        summary.alreadyJudged++;
        continue;
      }
      // 前のルールで片付いた Task には、続けて当てない
      const current = yield* repository.findTask(taskId);
      if (current._tag === "None" || !OPEN_STATUSES.includes(current.value.status)) continue;
      const dossier = yield* loadDossier(taskId);
      if (dossier === undefined) continue;
      const result = yield* conditionProbability(rule.condition, dossier).pipe(Effect.result);
      // Decisions を呼べなかったときは記録せず、次の回に判定し直す（呼べなかったのを「当てはまらない」と残さない）
      if (result._tag === "Failure") {
        yield* Effect.logWarning("ルールの条件を判定できなかったため、次の回に判定し直す").pipe(Effect.annotateLogs({ rule: rule.name, reason: result.failure.reason._tag }));
        continue;
      }
      const probability = result.success;
      const matched = probability !== undefined && probability >= RULE_MATCH_PROBABILITY;
      const executedAt = DateTime.formatIso(yield* DateTime.now);
      if (matched && current.value.status !== rule.actions.task) {
        yield* repository.updateTask(taskId, { status: rule.actions.task }, "rule");
        yield* repository.recordChange(taskId, { kind: "field_changed", field: "status", before: current.value.status, after: rule.actions.task, unread: true, actor: "rule" });
      }
      yield* db
        .insert(taskRuleRuns)
        .values({ taskId, ruleId: rule.id, ruleName: rule.name, ruleFingerprint: fingerprint, triggerKey: trigger.key, status: matched ? "applied" : "skipped", probability: probability ?? null, action: rule.actions.task, executedAt })
        .onConflictDoNothing()
        .pipe(Effect.orDie);
      if (matched) summary.applied++;
      else summary.notMatched++;
    }
  }
  return summary;
});
