import { Effect, Schema } from "effect";
import { AiCommand, Command, Query, type Reply } from "../shared/api.js";
import { AiSettingsService } from "./ai/ai-settings-service.js";
import { TaskService } from "./task-service.js";

const decodeCommand = Schema.decodeUnknownEffect(Command);
const decodeQuery = Schema.decodeUnknownEffect(Query);
const decodeAiCommand = Schema.decodeUnknownEffect(AiCommand);

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
