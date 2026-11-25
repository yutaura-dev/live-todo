import { Effect, Schema } from "effect";
import type { TodoJudgment } from "../judge/todo-judge.js";
import type { SourceBinding } from "../sync/sync-source.js";
import {
  type Condition,
  type ConditionItem,
  makeWatcher,
  type WatchCursor,
  type WatchProvider,
  type WatchSchedule,
} from "./watcher.js";

const WatchCursorSchema = Schema.Struct({
  holding: Schema.Array(Schema.String),
  subjects: Schema.Record(
    Schema.String,
    Schema.Struct({
      nextCheckAt: Schema.String,
      intervalMs: Schema.Number,
      fingerprint: Schema.String,
      revision: Schema.optionalKey(Schema.String),
    }),
  ),
});

/** 変化のない対象ほど見張る間隔を倍々に延ばし、最大でも 1 日に 1 回は確認する */
export const DEFAULT_WATCH_SCHEDULE: WatchSchedule = { initial: "5 minutes", max: "1 day" };

// 判定を常に規則で todo にする理由: Condition は「成り立ったらやることがある状態」として定義するものなので、
// 成り立った時点で todo であることは決まっている。LLM に問い直すとコストがかかるうえ、取りこぼしの原因になる。
const CONDITION_JUDGMENT: TodoJudgment = { verdict: "todo", method: "rule" };

export function watchBinding<TSubject, E>(
  provider: WatchProvider<TSubject, E>,
  conditions: ReadonlyArray<Condition<TSubject>>,
  schedule: WatchSchedule = DEFAULT_WATCH_SCHEDULE,
): SourceBinding<ConditionItem, WatchCursor, E, never, never> {
  return {
    // 通常の取得と source 名を分ける理由: カーソルの形が違い（通知の since と、見張りの状態）、
    // 同じ source 名にすると互いのカーソルを上書きしてしまうため。
    source: `${provider.source}:watch`,
    adapter: makeWatcher(provider, conditions, schedule),
    cursorSchema: WatchCursorSchema,
    externalIdOf: (item) => item.externalId,
    toItemDraft: (item) => ({
      title: item.title,
      url: item.url,
      state: item.holds ? "open" : "resolved",
      fingerprint: item.holds ? "holds" : "clear",
    }),
    judge: () => Effect.succeed(CONDITION_JUDGMENT),
  };
}
