import { Effect, Schema } from "effect";
import { AiCommand, Command, InboxCommand, type InboxView, Query, type Reply } from "../shared/api.js";
import { ProposalService } from "./proposals/proposal-service.js";
import { AccountService } from "./sources/account-service.js";
import { SyncRunner } from "./sources/sync-runner.js";
import { WriteService } from "./writes/write-service.js";
import { AiSettingsService } from "./ai/ai-settings-service.js";
import { TaskService } from "./task-service.js";

const decodeCommand = Schema.decodeUnknownEffect(Command);
const decodeQuery = Schema.decodeUnknownEffect(Query);
const decodeAiCommand = Schema.decodeUnknownEffect(AiCommand);
const decodeInboxCommand = Schema.decodeUnknownEffect(InboxCommand);

export const handleCommand = (raw: unknown) =>
  Effect.gen(function* () {
    const service = yield* TaskService;
    return yield* decodeCommand(raw).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed({ ok: false, reason: "操作の形が正しくありません" } as const),
        onSuccess: (command) => service.command(command),
      }),
    );
  });

export const handleQuery = (raw: unknown) =>
  Effect.gen(function* () {
    const service = yield* TaskService;
    const settings = yield* AiSettingsService;
    return yield* decodeQuery(raw).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed({ ok: false, reason: "読み出しの形が正しくありません" } as const),
        onSuccess: (query): Effect.Effect<Reply<unknown>> =>
          query._tag === "Board" ? service.board() : query._tag === "Task" ? service.task(query.id) : Effect.map(settings.view(), (value) => ({ ok: true, value }) as const),
      }),
    );
  });

export const handleAiCommand = (raw: unknown) =>
  Effect.gen(function* () {
    const settings = yield* AiSettingsService;
    const tasks = yield* TaskService;
    return yield* decodeAiCommand(raw).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed({ ok: false, reason: "操作の形が正しくありません" } as const),
        onSuccess: (command) =>
          settings.configure(command.use, command.option).pipe(
            // 使えるようになったら、AI 設定がないあいだ未判定のまま置いた優先度を決め直す（返事は待たせない）
            Effect.tap((reply) => (reply.ok && reply.value.status === "使える" ? Effect.forkDetach(tasks.refreshAll()) : Effect.void)),
          ),
      }),
    );
  });

const inboxView = Effect.gen(function* () {
  const proposals = yield* ProposalService;
  const accounts = yield* AccountService;
  const writes = yield* WriteService;
  return { proposals: yield* proposals.list(), undecided: yield* proposals.undecided(), accounts: yield* accounts.list(), writes: yield* writes.list() } as InboxView;
});

/** 取り込みを 1 回回し、変わった Task を画面に知らせる（起動したとき・決まった間隔で・ユーザーが頼んだとき） */
export const syncOnce = Effect.gen(function* () {
  const runner = yield* SyncRunner;
  const tasks = yield* TaskService;
  const outcomes = yield* runner.runOnce();
  for (const id of new Set(outcomes.flatMap((outcome) => outcome.changedTaskIds))) yield* tasks.notify(id);
  return outcomes;
});

/** 提案・事実・アカウントの画面。null が届いたら今の姿を返し、操作が届いたら当ててから今の姿を返す */
export const handleInbox = (raw: unknown) =>
  Effect.gen(function* () {
    const proposals = yield* ProposalService;
    const accounts = yield* AccountService;
    const tasks = yield* TaskService;
    const writes = yield* WriteService;
    if (raw !== null) {
      const decoded = yield* decodeInboxCommand(raw).pipe(Effect.option);
      if (decoded._tag === "None") return { ok: false, reason: "操作の形が正しくありません" } as Reply<InboxView>;
      const command = decoded.value;
      const result: Reply<unknown> =
        command._tag === "AcceptProposal"
          ? yield* proposals.accept(command.id)
          : command._tag === "DeclineProposal"
            ? yield* proposals.decline(command.id)
            : command._tag === "RouteFact"
              ? yield* proposals.routeFact(command.id, command.to)
              : command._tag === "AddGitHubAccount"
                ? yield* accounts.addGitHub({ key: command.key, label: command.label })
                : command._tag === "RemoveAccount"
                  ? yield* accounts.remove(command.id)
                  : command._tag === "RequestWrite"
                    ? yield* writes.requestFromItem(command.taskId, command.itemId)
                    : command._tag === "ApproveWrite"
                      ? yield* writes.approve(command.id)
                      : command._tag === "CancelWrite"
                        ? yield* writes.cancel(command.id)
                        : { ok: true, value: yield* syncOnce };
      if (!result.ok) return result as Reply<InboxView>;
      const value = result.value as { taskId?: string | null } | null;
      if (value !== null && typeof value === "object" && "taskId" in value && typeof value.taskId === "string") yield* tasks.notify(value.taskId);
    }
    return { ok: true, value: yield* inboxView } as Reply<InboxView>;
  }).pipe(Effect.catchTag("StoreCorrupted", () => Effect.succeed({ ok: false, reason: "保存したものを読めませんでした" } as Reply<InboxView>)));
