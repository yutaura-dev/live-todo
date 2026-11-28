import { Context, DateTime, Effect, Layer, Option } from "effect";
import { Decisions } from "../../llm/decision/decisions.js";
import { blockingNowQuestion, interpretBlockingNow, interpretPriorityLevel, priorityLevelQuestion } from "../../llm/decision/questions/index.js";
import type { TaskMaterial } from "../../llm/shared/materials.js";
import type { PriorityLevel } from "../../llm/shared/vocabulary.js";
import {
  basisChanged,
  clearByUser,
  decideByRule,
  judge,
  type Prioritization,
  resume,
  setByUser,
  start,
  stop,
} from "../../domain/priority/prioritization.js";
import { daysUntil, ruleLevel, type RuleResult } from "../../domain/priority/rule.js";
import { notePriority, type Task } from "../../domain/task/task.js";
import { PrioritizationStore } from "../../store/prioritization-store.js";
import type { StoreCorrupted } from "../../store/task-store.js";

/** 今日の日付と地域。期日までの日数を数えるのに使う（テストでは固定する） */
export class Calendar extends Context.Service<Calendar, { readonly today: Effect.Effect<string>; readonly timeZone: string }>()("live-todo/desktop/Calendar") {
  static readonly fixed = (input: { today: string; timeZone: string }) => Layer.succeed(Calendar, Calendar.of({ today: Effect.succeed(input.today), timeZone: input.timeZone }));
  static readonly system = Layer.sync(Calendar, () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    return Calendar.of({ today: Effect.map(DateTime.now, (now) => format.format(DateTime.toDateUtc(now))), timeZone });
  });
}

const sync = { kind: "sync" } as const;
const decisionsActor = { kind: "decisions" } as const;

const canDecide = (p: Prioritization) => p.status === "未判定" || p.status === "ラベル未定";
const shown = (p: Prioritization | null): string | null => (p === null ? null : p.status === "ラベル未定" ? "ラベル未定" : (p.priority?.level ?? null));
const isLevel = (rule: RuleResult): rule is PriorityLevel => rule !== "規則では決めない" && rule !== "今日中以上（今すぐかは判定）";

const materialOf = (task: Task): TaskMaterial => ({
  id: task.id,
  title: task.title,
  brief: task.brief ?? "",
  status: task.status,
  completion: task.completion,
  due: task.due,
  blocksOthers: task.blocksOthers,
  plan: [],
  facts: [],
});

/**
 * Task の優先度を決める。規則で決まればそれで決め、決まらなければ Decisions に聞く（prioritization.spec）。
 * Decisions がない（AI 設定がまだ）・届かなかったときは、未判定のまま置く（次の機会にやり直す）。
 * 計画（Action Item の期日・手間・待つ見込み）はまだないので、Task の期日と止めているかだけで決める。
 */
export class Prioritizer extends Context.Service<
  Prioritizer,
  {
    refresh(task: Task): Effect.Effect<Task, StoreCorrupted>;
    setByUser(task: Task, level: PriorityLevel): Effect.Effect<Task, StoreCorrupted | { readonly _tag: "PrioritizationDenied"; readonly reason: string }>;
    clearByUser(task: Task): Effect.Effect<Task, StoreCorrupted | { readonly _tag: "PrioritizationDenied"; readonly reason: string }>;
  }
>()("live-todo/desktop/Prioritizer") {
  static readonly layer = Layer.effect(
    Prioritizer,
    Effect.gen(function* () {
      const store = yield* PrioritizationStore;
      const calendar = yield* Calendar;
      // 呼ばれたときではなく作るときに取る（呼ぶ側の環境には Decisions がないため）。なければ AI 設定がまだ
      const decisionsService = yield* Effect.serviceOption(Decisions);

      const basisOf = (task: Task, today: string) => JSON.stringify({ due: task.due?.earliest ?? null, blocksOthers: task.blocksOthers, today });

      const askDecisions = (p: Prioritization, rule: RuleResult, task: Task, today: string) =>
        Effect.gen(function* () {
          const found = decisionsService;
          if (Option.isNone(found)) return p;
          const material = { task: materialOf(task), facts: [], today };
          if (rule === "今日中以上（今すぐかは判定）") {
            const result = yield* found.value.ask(blockingNowQuestion, material);
            return yield* judge(p, decisionsActor, rule, interpretBlockingNow(result.answers.now), p.basisFingerprint);
          }
          const result = yield* found.value.ask(priorityLevelQuestion, material);
          const level = interpretPriorityLevel(result.answers.level);
          return yield* judge(p, decisionsActor, rule, level === "ラベル未定" ? "閾値の間・断られた・形に合わない" : level, p.basisFingerprint);
        }).pipe(Effect.catchTag("AiUnreachableError", () => Effect.succeed(p)));

      const decide = (p: Prioritization, task: Task, today: string) =>
        Effect.gen(function* () {
          if (!canDecide(p)) return p;
          const days = task.due === null ? null : daysUntil(today, task.due.earliest, calendar.timeZone);
          const rule = ruleLevel({ 期日まで: days ?? "期日なし", 手間: 0, 待ち: 0, 他の人を止めている: task.blocksOthers });
          if (isLevel(rule)) return yield* decideByRule(p, sync, rule, days !== null && days < 0 ? "期日を過ぎている" : `期日まで ${days} 日`);
          return yield* askDecisions(p, rule, task, today);
        });

      const recorded = (task: Task, before: Prioritization | null, after: Prioritization) =>
        Effect.gen(function* () {
          yield* store.save(after);
          const was = shown(before);
          const now = shown(after);
          if (task.status !== "やること" || was === now) return task;
          return yield* Effect.orDie(notePriority(task, { kind: after.status === "ユーザーが決めた" ? "user" : "app" }, was, now));
        });

      // ensure に当たらないよう操作の前に状態を見ているので、ここで断られるのは実装の誤り
      const orDie = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

      const refresh = (task: Task) =>
        Effect.gen(function* () {
          const today = yield* calendar.today;
          const basis = basisOf(task, today);
          const current = Option.getOrNull(yield* store.find(task.id));
          if (task.status !== "やること") {
            if (current === null || current.status === "決めるのをやめた" || current.status === "ユーザーが決めた") return task;
            return yield* recorded(task, current, yield* orDie(stop(current, sync)));
          }
          let p = current ?? (yield* orDie(start({ taskId: task.id, basis }, sync)));
          if (p.status === "決めるのをやめた") p = yield* orDie(resume(p, sync, basis));
          else if (p.status !== "ユーザーが決めた" && p.basisFingerprint !== basis) p = yield* orDie(basisChanged(p, sync, basis));
          return yield* recorded(task, current, yield* orDie(decide(p, task, today)));
        });

      const userChange = (task: Task, change: (p: Prioritization) => Effect.Effect<Prioritization, { readonly _tag: "PrioritizationDenied"; readonly reason: string }>) =>
        Effect.gen(function* () {
          const today = yield* calendar.today;
          const current = Option.getOrNull(yield* store.find(task.id)) ?? (yield* orDie(start({ taskId: task.id, basis: basisOf(task, today) }, sync)));
          const changed = yield* change(current);
          const decided = changed.status === "未判定" ? yield* orDie(decide({ ...changed, basisFingerprint: basisOf(task, today) }, task, today)) : changed;
          return yield* recorded(task, current, decided);
        });

      return Prioritizer.of({
        refresh,
        setByUser: (task, level) => userChange(task, (p) => setByUser(p, { kind: "user" }, level)),
        clearByUser: (task) => userChange(task, (p) => clearByUser(p, { kind: "user" })),
      });
    }),
  );
}
