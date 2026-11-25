import { DateTime, Effect } from "effect";
import type { SourceAdapter } from "../sync/source-adapter.js";
import type { SourceChange } from "../sync/source-change.js";

export type ConditionVerdict = "holds" | "clear" | "unknown";

export interface WatchProvider<TSubject, E> {
  readonly source: string;
  /** 自分が関わる、今開いているもの（見張る対象）の一覧 */
  readonly subjects: Effect.Effect<ReadonlyArray<TSubject>, E>;
  readonly subjectId: (subject: TSubject) => string;
  readonly subjectUrl: (subject: TSubject) => string;
}

export interface Condition<TSubject> {
  readonly id: string;
  /** 条件が成り立ったときにやること。Task の title の元になる */
  readonly title: (subject: TSubject) => string;
  readonly evaluate: (subject: TSubject, now: DateTime.Utc) => ConditionVerdict;
}

export type ConditionItem = {
  externalId: string;
  subjectId: string;
  conditionId: string;
  title: string;
  url: string;
  holds: boolean;
};

/** 前回の同期で成り立っていた条件（ConditionItem の externalId）の一覧 */
export type WatchCursor = { holding: ReadonlyArray<string> };

export function makeWatcher<TSubject, E>(
  provider: WatchProvider<TSubject, E>,
  conditions: ReadonlyArray<Condition<TSubject>>,
): SourceAdapter<ConditionItem, WatchCursor, E> {
  return {
    fetchChanges: (cursor) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const subjects = yield* provider.subjects;
        const previouslyHolding = new Set(cursor?.holding ?? []);
        const holding: string[] = [];
        const evaluated = new Set<string>();
        const changes: SourceChange<ConditionItem>[] = [];

        for (const subject of subjects) {
          const subjectId = provider.subjectId(subject);
          for (const condition of conditions) {
            const externalId = `${subjectId}#${condition.id}`;
            evaluated.add(externalId);
            const wasHolding = previouslyHolding.has(externalId);
            const verdict = condition.evaluate(subject, now);
            // unknown のとき前回を引き継ぐ理由: 計算待ち（GitHub の mergeable が null など）や一時的に
            // 取れなかっただけで「成り立っていない」と扱うと、そのたびに Task が開いたり閉じたりするため。
            const holds = verdict === "unknown" ? wasHolding : verdict === "holds";
            if (holds) holding.push(externalId);
            if (holds === wasHolding) continue;

            changes.push({
              kind: "upserted",
              item: {
                externalId,
                subjectId,
                conditionId: condition.id,
                title: condition.title(subject),
                url: provider.subjectUrl(subject),
                holds,
              },
            });
          }
        }

        for (const externalId of previouslyHolding) {
          if (!evaluated.has(externalId)) changes.push({ kind: "removed", externalId });
        }

        return { changes, nextCursor: { holding } };
      }),
  };
}
