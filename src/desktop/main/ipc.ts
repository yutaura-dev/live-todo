import { Effect, Schema } from "effect";
import { Command, Query, type Reply } from "../shared/api.js";
import { TaskService } from "./task-service.js";

const decodeCommand = Schema.decodeUnknownEffect(Command);
const decodeQuery = Schema.decodeUnknownEffect(Query);

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
    return yield* decodeQuery(raw).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed({ ok: false, reason: "読み出しの形が正しくありません" } as const),
        onSuccess: (query): Effect.Effect<Reply<unknown>> => (query._tag === "Board" ? service.board() : service.task(query.id)),
      }),
    );
  });
