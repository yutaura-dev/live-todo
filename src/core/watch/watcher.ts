import { DateTime, Duration, Effect, Option } from "effect";
import type { SourceAdapter } from "../sync/source-adapter.js";
import type { SourceChange } from "../sync/source-change.js";

export type ConditionVerdict = "holds" | "clear" | "unknown";

/** 見張る対象の一覧の 1 件。一覧は安く取れる情報だけで作る */
export type SubjectRef = {
  id: string;
  url: string;
  /** 対象の更新を表す値（GitHub なら PR の updated_at）。変わったら予定の時刻より前でも確認する */
  revision?: string;
};

export interface WatchProvider<TSubject, E> {
  readonly source: string;
  /** 自分が関わる、今開いているもの（見張る対象）の一覧 */
  readonly listSubjects: Effect.Effect<ReadonlyArray<SubjectRef>, E>;
  /** 1 件の詳細。対象が見つからなければ none */
  loadSubject(ref: SubjectRef): Effect.Effect<Option.Option<TSubject>, E>;
  /** 判定に効く値だけを並べたもの。変わらなければ見張る間隔を延ばす */
  fingerprint(subject: TSubject): string;
}

export interface Condition<TSubject> {
  readonly id: string;
  /** 条件が成り立ったときにやること。Task の title の元になる */
  readonly title: (subject: TSubject) => string;
  readonly evaluate: (subject: TSubject, now: DateTime.Utc) => ConditionVerdict;
  /** 時間の条件が成り立つかもしれない時刻。次の確認をこの時刻より遅らせない */
  readonly revisitAt?: (subject: TSubject, now: DateTime.Utc) => Option.Option<DateTime.Utc>;
}

export type WatchSchedule = { initial: Duration.Input; max: Duration.Input };

export type ConditionItem = {
  externalId: string;
  subjectId: string;
  conditionId: string;
  title: string;
  url: string;
  holds: boolean;
};

export type SubjectSchedule = { nextCheckAt: string; intervalMs: number; fingerprint: string; revision?: string };

export type WatchCursor = {
  /** 前回の同期で成り立っていた条件（ConditionItem の externalId）の一覧 */
  holding: ReadonlyArray<string>;
  /** 見張る対象ごとの、次に確認する時刻と間隔 */
  subjects: Readonly<Record<string, SubjectSchedule>>;
};

export function makeWatcher<TSubject, E>(
  provider: WatchProvider<TSubject, E>,
  conditions: ReadonlyArray<Condition<TSubject>>,
  schedule: WatchSchedule,
): SourceAdapter<ConditionItem, WatchCursor, E> {
  const initialMs = Duration.toMillis(schedule.initial);
  const maxMs = Duration.toMillis(schedule.max);

  return {
    fetchChanges: (cursor) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);
        const refs = yield* provider.listSubjects;
        const previouslyHolding = new Set(cursor?.holding ?? []);
        const previousSchedules = cursor?.subjects ?? {};

        const holding: string[] = [];
        const evaluated = new Set<string>();
        const subjects: Record<string, SubjectSchedule> = {};
        const changes: SourceChange<ConditionItem>[] = [];
        const keyOf = (ref: SubjectRef, condition: Condition<TSubject>) => `${ref.id}#${condition.id}`;

        for (const ref of refs) {
          const previous = previousSchedules[ref.id];
          const revisionChanged = previous !== undefined && ref.revision !== undefined && previous.revision !== ref.revision;
          const due =
            previous === undefined ||
            revisionChanged ||
            Option.match(DateTime.make(previous.nextCheckAt), { onNone: () => true, onSome: (at) => nowMs >= DateTime.toEpochMillis(at) });

          if (!due) {
            // 確認しない対象は、成り立っている条件をそのまま引き継ぐ（詳細を取りに行かない）
            for (const condition of conditions) {
              const key = keyOf(ref, condition);
              evaluated.add(key);
              if (previouslyHolding.has(key)) holding.push(key);
            }
            subjects[ref.id] = previous;
            continue;
          }

          const loaded = yield* provider.loadSubject(ref);
          if (Option.isNone(loaded)) continue;
          const subject = loaded.value;

          let anyUnknown = false;
          for (const condition of conditions) {
            const key = keyOf(ref, condition);
            evaluated.add(key);
            const wasHolding = previouslyHolding.has(key);
            const verdict = condition.evaluate(subject, now);
            if (verdict === "unknown") anyUnknown = true;
            // unknown のとき前回を引き継ぐ理由: 計算待ち（GitHub の mergeable が null など）や一時的に
            // 取れなかっただけで「成り立っていない」と扱うと、そのたびに Task が開いたり閉じたりするため。
            const holds = verdict === "unknown" ? wasHolding : verdict === "holds";
            if (holds) holding.push(key);
            if (holds === wasHolding) continue;
            changes.push({
              kind: "upserted",
              item: { externalId: key, subjectId: ref.id, conditionId: condition.id, title: condition.title(subject), url: ref.url, holds },
            });
          }

          const fingerprint = provider.fingerprint(subject);
          // unknown が残るうちは延ばさない理由: GitHub が計算を終えたら、すぐ判定できるようにするため。
          const settled = previous !== undefined && !revisionChanged && !anyUnknown && previous.fingerprint === fingerprint;
          const intervalMs = settled ? Math.min(previous.intervalMs * 2, maxMs) : initialMs;
          const revisits = conditions.flatMap((condition) =>
            Option.toArray(condition.revisitAt?.(subject, now) ?? Option.none()).map(DateTime.toEpochMillis).filter((at) => at > nowMs),
          );
          const nextCheckMs = Math.min(nowMs + intervalMs, ...revisits);

          subjects[ref.id] = {
            nextCheckAt: DateTime.formatIso(DateTime.makeUnsafe(nextCheckMs)),
            intervalMs,
            fingerprint,
            ...(ref.revision === undefined ? {} : { revision: ref.revision }),
          };
        }

        for (const key of previouslyHolding) {
          if (!evaluated.has(key)) changes.push({ kind: "removed", externalId: key });
        }

        return { changes, nextCursor: { holding, subjects } };
      }),
  };
}
