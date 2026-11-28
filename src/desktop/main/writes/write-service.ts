import { Context, Effect, Layer, Option, Schema } from "effect";
import { completeByWrite, itemsOf, turnOf } from "../../../domain/plan/plan.js";
import { receive } from "../../../domain/task/task.js";
import { approve, cancel, fail, interrupt, requestWrite, settle, succeed, Write } from "../../../domain/write/write.js";
import { DocumentStore, documentsOf } from "../../../store/document-store.js";
import { type StoreCorrupted, TaskStore } from "../../../store/task-store.js";
import type { Reply, WriteView } from "../../shared/api.js";
import { Planner } from "../plan/planner.js";
import { TaskIds } from "../task-service.js";
import { WriteProvider } from "./write-provider.js";

export const writes = documentsOf("write", Write);
const user = { kind: "user" } as const;
const app = { kind: "app" } as const;
const OPEN_STAGES = new Set(["承認待ち", "書き込み中", "書けたか分からない"]);

/** 外への書き込み。承認がなければ書き込まない（charter）。書き込み先を呼ぶのは、承認した書き込みだけ */
export class WriteService extends Context.Service<
  WriteService,
  {
    requestFromItem(taskId: string, itemId: string): Effect.Effect<Reply<WriteView>, StoreCorrupted>;
    list(): Effect.Effect<ReadonlyArray<WriteView>, StoreCorrupted>;
    approve(writeId: string): Effect.Effect<Reply<WriteView>, StoreCorrupted>;
    cancel(writeId: string): Effect.Effect<Reply<WriteView>, StoreCorrupted>;
    /** 起動したとき、書き込み中のまま残っていた書き込みを、やり直さずに「書けたか分からない」から確かめる */
    recover(): Effect.Effect<void, StoreCorrupted>;
  }
>()("live-todo/desktop/WriteService") {
  static readonly layer = Layer.effect(
    WriteService,
    Effect.gen(function* () {
      const tasks = yield* TaskStore;
      const provider = yield* WriteProvider;
      const planner = yield* Planner;
      const ids = yield* TaskIds;
      const docs = yield* DocumentStore;

      const viewOf = (write: Write) =>
        Effect.gen(function* () {
          const task = yield* tasks.find(write.requestedBy.taskId);
          return {
            id: write.id,
            taskId: write.requestedBy.taskId,
            taskTitle: Option.isSome(task) ? task.value.title : "",
            summary: write.summary,
            stage: write.stage,
            failure: write.failure?.message || write.failure?.kind || null,
          } as WriteView;
        });

      const requestFromItem = (taskId: string, itemId: string) =>
        Effect.gen(function* () {
          const task = yield* tasks.find(taskId);
          if (Option.isNone(task) || task.value.plan === null) return { ok: false, reason: "Task が見つかりません" } as const;
          const plan = task.value.plan;
          const item = itemsOf(plan).find((entry) => entry.id === itemId);
          const how = item?.definition.how;
          if (item === undefined || how?.type !== "write") return { ok: false, reason: "書き込みで果たされる Action Item だけ" } as const;
          const open = (yield* writes.all()).some((w) => w.requestedBy.type === "actionItem" && w.requestedBy.actionItemId === itemId && OPEN_STAGES.has(w.stage));
          const params = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(how.paramsJson).pipe(Effect.orElseSucceed(() => ({})));
          const inspection = yield* provider.inspect(how.subjectUri, how.operation, params);
          if (inspection.ready === "書き込めない") return { ok: false, reason: inspection.reason ?? "書き込める状態のときだけ" } as const;
          const turn = turnOf(plan, itemId);
          const requested = yield* requestWrite(
            {
              id: yield* ids.next,
              subject: { uri: how.subjectUri },
              place: null,
              operation: how.operation,
              params,
              version: inspection.version,
              summary: inspection.summary,
              requestedBy: { type: "actionItem", taskId, actionItemId: itemId },
            },
            user,
            {
              way: "Action Item",
              item: item.status !== "まだ" ? "済んでいる" : turn === "番が来ている" ? "番が来ていて、まだ" : "番待ち",
              sameAsDefinition: true,
              openWrite: open,
              policy: "ユーザーが頼む・承認する",
              planVersion: "計画の版のまま",
              taskColumn: task.value.status === "完了待ち" ? "完了待ち" : "やること",
              trigger: how.trigger,
              autoTried: false,
            },
            inspection.ready,
          ).pipe(Effect.result);
          if (requested._tag === "Failure") return { ok: false, reason: requested.failure.reason } as const;
          yield* writes.save(requested.success);
          return { ok: true, value: yield* viewOf(requested.success) } as const;
        });

      const afterWrite = (write: Write) =>
        Effect.gen(function* () {
          if (write.requestedBy.type !== "actionItem") return;
          const task = yield* tasks.find(write.requestedBy.taskId);
          if (Option.isNone(task) || task.value.plan === null) return;
          if (write.stage === "書き込んだ") {
            const plan = yield* completeByWrite(task.value.plan, write.requestedBy.actionItemId, app).pipe(Effect.option);
            if (Option.isSome(plan)) yield* planner.progressed(task.value, plan.value, app, write.requestedBy.actionItemId);
            return;
          }
          if (write.stage === "失敗") {
            const brief = `書き込めなかった（${write.failure?.message || write.failure?.kind}）。直してから、もう一度頼む`;
            const next = yield* receive(task.value, app, "書き込めなかった", { brief }, `write:${write.id}`).pipe(Effect.option);
            if (Option.isSome(next)) yield* tasks.save(next.value);
          }
        });

      const approveOne = (writeId: string) =>
        Effect.gen(function* () {
          const found = yield* writes.find(writeId);
          if (Option.isNone(found)) return { ok: false, reason: "書き込みが見つかりません" } as const;
          const inspection = yield* provider.inspect(found.value.subject.uri, found.value.operation, found.value.params);
          const approved = yield* approve(found.value, user, inspection.version === found.value.version ? "見せた版のまま" : "変わった", inspection.ready).pipe(Effect.result);
          if (approved._tag === "Failure") return { ok: false, reason: approved.failure.reason } as const;
          // 書き込む前に「書き込み中」を保存する（書いている途中でアプリが止まっても、やり直さずに確かめられるように）
          yield* writes.save(approved.success);
          const outcome = yield* provider.execute(approved.success.subject.uri, approved.success.operation, approved.success.params, approved.success.version);
          const done = outcome.ok ? yield* Effect.orDie(succeed(approved.success, { kind: "target" })) : yield* Effect.orDie(fail(approved.success, { kind: "target" }, outcome.kind, outcome.message));
          yield* writes.save(done);
          yield* afterWrite(done);
          return { ok: true, value: yield* viewOf(done) } as const;
        });

      const cancelOne = (writeId: string) =>
        Effect.gen(function* () {
          const found = yield* writes.find(writeId);
          if (Option.isNone(found)) return { ok: false, reason: "書き込みが見つかりません" } as const;
          const cancelled = yield* cancel(found.value, user).pipe(Effect.result);
          if (cancelled._tag === "Failure") return { ok: false, reason: cancelled.failure.reason } as const;
          yield* writes.save(cancelled.success);
          return { ok: true, value: yield* viewOf(cancelled.success) } as const;
        });

      const recover = () =>
        Effect.gen(function* () {
          for (const write of (yield* writes.all()).filter((w) => w.stage === "書き込み中")) {
            const unknown = yield* Effect.orDie(interrupt(write, app));
            // 外を確かめる口がまだないので、確かめられないとして失敗にし、書き込み先で確かめるよう見せる（やり直さない。write.spec）
            const settled = yield* Effect.orDie(settle(unknown, { kind: "sync" }, "確かめられない"));
            yield* writes.save(settled);
            yield* afterWrite(settled);
          }
        });

      const list = () => Effect.gen(function* () {
        const all = (yield* writes.all()).filter((w) => w.stage === "承認待ち" || w.stage === "失敗");
        return yield* Effect.forEach(all, viewOf);
      });

      const withDocs = <A, E>(effect: Effect.Effect<A, E, DocumentStore>) => Effect.provideService(effect, DocumentStore, docs);
      return WriteService.of({
        requestFromItem: (taskId, itemId) => withDocs(requestFromItem(taskId, itemId)),
        list: () => withDocs(list()),
        approve: (id) => withDocs(approveOne(id)),
        cancel: (id) => withDocs(cancelOne(id)),
        recover: () => withDocs(recover()),
      });
    }),
  );
}
