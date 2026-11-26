import { and, eq, gte } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { Database } from "../../core/db/database.js";
import { gmailMessages, gmailRuleRuns } from "../../core/db/schema.js";
import { MAIL_TOPIC_LABELS, MailClassifier } from "../../core/judge/mail-classifier.js";
import { gmailLabelChangesOf, isRuleCandidate, type Rule, RULE_MATCH_PROBABILITY } from "../../core/rules/rule.js";
import { GmailClient } from "./gmail-client.js";

const KIND_LABELS: Record<string, string> = { newsletter: "メルマガ", notification: "お知らせ", personal: "人からのメール" };

/**
 * 利用者が決めたルールを、条件に当てはまるメールに当てる（ADR-0014）。ルールを決めたことを、その範囲の書き込みの承認とみなす。
 * 条件は言葉で書かれているので、当てはまるかを Decisions で判定し、確率が高いときだけ当てる。判定するのはルールを作ったあとに
 * 届いたメールだけで、同じメールを同じルールで判定するのは一度だけ（当てはまらなくても、失敗してもやり直さない）
 */
export const applyGmailRules = Effect.fnUntraced(function* (accountId: string, rules: ReadonlyArray<Rule>) {
  const active = rules.filter((rule) => rule.enabled && rule.then.gmail !== undefined);
  if (active.length === 0) return 0;
  const db = yield* Database;
  const client = yield* GmailClient;
  const classifier = yield* MailClassifier;
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
      if (done.has(`${mail.messageId} ${rule.id}`) || !isRuleCandidate(mail, rule)) continue;
      const actions = rule.then.gmail!;
      const judged = yield* classifier.matchesCondition({
        input: [`差出人: ${mail.senderName} <${mail.senderKey}>`, `件名: ${mail.subject}`].join("\n"),
        context: [`種類: ${KIND_LABELS[mail.kind] ?? mail.kind}`, ...(mail.topic === null ? [] : [`用件: ${MAIL_TOPIC_LABELS[mail.topic]}`])].join("\n"),
        condition: rule.when,
      });
      const record = { accountId, messageId: mail.messageId, ruleId: rule.id, ruleName: rule.name, actions, probability: judged.probability ?? null };
      done.add(`${mail.messageId} ${rule.id}`);
      if (judged.probability === undefined || judged.probability < RULE_MATCH_PROBABILITY) {
        yield* db.insert(gmailRuleRuns).values({ ...record, status: "skipped", executedAt: DateTime.formatIso(yield* DateTime.now) }).onConflictDoNothing().pipe(Effect.orDie);
        continue;
      }
      const outcome = yield* Effect.gen(function* () {
        yield* ensureLabels(actions.labels ?? []);
        const change = gmailLabelChangesOf(actions, labelIds);
        yield* client.modifyLabels(mail.messageId, change);
        return change;
      }).pipe(Effect.result);
      const executedAt = DateTime.formatIso(yield* DateTime.now);
      if (outcome._tag === "Failure") {
        const message = outcome.failure._tag === "GmailRequestError" ? outcome.failure.message : "Gmail に書き込めなかった";
        yield* db.insert(gmailRuleRuns).values({ ...record, status: "failed", error: message, executedAt }).onConflictDoNothing().pipe(Effect.orDie);
        yield* Effect.logWarning("Gmail のルールを当てられなかった").pipe(Effect.annotateLogs({ rule: rule.name, reason: message }));
        continue;
      }
      yield* db.insert(gmailRuleRuns).values({ ...record, status: "executed", executedAt }).onConflictDoNothing().pipe(Effect.orDie);
      yield* db
        .update(gmailMessages)
        .set({ ...(actions.markRead === true ? { unread: false } : {}), ...(actions.archive === true ? { inInbox: false } : {}), updatedAt: executedAt })
        .where(and(eq(gmailMessages.accountId, accountId), eq(gmailMessages.messageId, mail.messageId)))
        .pipe(Effect.orDie);
      applied++;
    }
  }
  return applied;
});
