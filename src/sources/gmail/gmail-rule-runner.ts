import { and, eq, gte } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { Database } from "../../core/db/database.js";
import { gmailMessages, gmailRuleRuns } from "../../core/db/schema.js";
import { GmailClient } from "./gmail-client.js";
import { type GmailRule, labelChangesOf, matchesRule } from "./gmail-rules.js";

/**
 * 利用者が決めたルールを、条件に合うメールに当てる（ADR-0014）。ルールを決めたことを、その範囲の書き込みの承認とみなす。
 * 当てるのはルールを作ったあとに届いたメールだけで、同じメールに同じルールは一度しか当てない（失敗してもやり直さない）
 */
export const applyGmailRules = Effect.fnUntraced(function* (accountId: string, rules: ReadonlyArray<GmailRule>) {
  const active = rules.filter((rule) => rule.enabled);
  if (active.length === 0) return 0;
  const db = yield* Database;
  const client = yield* GmailClient;
  const since = Math.min(...active.map((rule) => Date.parse(rule.createdAt)));
  const mails = yield* db
    .select()
    .from(gmailMessages)
    .where(and(eq(gmailMessages.accountId, accountId), eq(gmailMessages.trashed, false), gte(gmailMessages.receivedAt, since)))
    .pipe(Effect.orDie);
  const done = new Set(
    (yield* db.select({ messageId: gmailRuleRuns.messageId, ruleId: gmailRuleRuns.ruleId }).from(gmailRuleRuns).where(eq(gmailRuleRuns.accountId, accountId)).pipe(Effect.orDie)).map(
      (run) => `${run.messageId} ${run.ruleId}`,
    ),
  );

  const labelIds = new Map<string, string>();
  let labelsLoaded = false;
  const ensureLabels = Effect.fnUntraced(function* (names: ReadonlyArray<string>) {
    if (!labelsLoaded) {
      for (const label of yield* client.labels) labelIds.set(label.name, label.id);
      labelsLoaded = true;
    }
    for (const name of names) {
      if (!labelIds.has(name)) labelIds.set(name, (yield* client.createLabel(name)).id);
    }
  });

  let applied = 0;
  for (const rule of active) {
    for (const mail of mails) {
      if (done.has(`${mail.messageId} ${rule.id}`) || !matchesRule(mail, rule)) continue;
      const outcome = yield* Effect.gen(function* () {
        yield* ensureLabels(rule.then.labels ?? []);
        const change = labelChangesOf(rule.then, labelIds);
        yield* client.modifyLabels(mail.messageId, change);
        return change;
      }).pipe(Effect.result);
      const executedAt = DateTime.formatIso(yield* DateTime.now);
      const record = { accountId, messageId: mail.messageId, ruleId: rule.id, ruleName: rule.name, actions: rule.then, executedAt };
      if (outcome._tag === "Failure") {
        const message = outcome.failure._tag === "GmailRequestError" ? outcome.failure.message : "Gmail に書き込めなかった";
        yield* db.insert(gmailRuleRuns).values({ ...record, status: "failed", error: message }).onConflictDoNothing().pipe(Effect.orDie);
        yield* Effect.logWarning("Gmail のルールを当てられなかった").pipe(Effect.annotateLogs({ rule: rule.name, reason: message }));
        continue;
      }
      yield* db.insert(gmailRuleRuns).values({ ...record, status: "executed" }).onConflictDoNothing().pipe(Effect.orDie);
      yield* db
        .update(gmailMessages)
        .set({ ...(rule.then.markRead === true ? { unread: false } : {}), ...(rule.then.archive === true ? { inInbox: false } : {}), updatedAt: executedAt })
        .where(and(eq(gmailMessages.accountId, accountId), eq(gmailMessages.messageId, mail.messageId)))
        .pipe(Effect.orDie);
      done.add(`${mail.messageId} ${rule.id}`);
      applied++;
    }
  }
  return applied;
});
