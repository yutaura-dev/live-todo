import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Database } from "../db/database.js";
import { sourceItems, taskLinks } from "../db/schema.js";
import { ClaudeCode, ClaudeCodeError } from "./claude-code.js";
import { RunInterrupts } from "./run-interrupts.js";

export const STOPPED_REASON = "merge されたので、もう続ける意味がない";

/** 動かすと、知らせを受けて作業をやめたことにする Claude Code。onRun はその間に起きること（同期で PR が merge されるなど） */
export const stoppingClaude = (onRun: Effect.Effect<void> = Effect.void) =>
  ClaudeCode.of({
    run: () => Effect.flatMap(onRun, () => Effect.fail(new ClaudeCodeError({ message: `知らせを受けて作業をやめた: ${STOPPED_REASON}`, stoppedReason: STOPPED_REASON }))),
  });

export const recordingInterrupts = () => {
  const listened: number[] = [];
  const service = RunInterrupts.of({
    listen: (taskId, effect) =>
      Effect.suspend(() => {
        listened.push(taskId);
        return effect;
      }) as never,
    trackedClosed: () => Effect.succeed(false),
  });
  return { listened, service };
};

export const resolveTrackedItems = (taskId: number, state: "resolved" | "removed" = "resolved") =>
  Effect.gen(function* () {
    const db = yield* Database;
    const links = yield* db.select({ id: taskLinks.sourceItemId }).from(taskLinks).where(eq(taskLinks.taskId, taskId));
    yield* db.update(sourceItems).set({ state }).where(inArray(sourceItems.id, links.map((link) => link.id)));
  }).pipe(Effect.orDie);
