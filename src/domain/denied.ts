import { Effect, Schema } from "effect";

/** spec の ensure に当たる。reason は spec の理由の文のまま（テストと画面が同じ言葉で断る） */
export class Denied extends Schema.TaggedError<Denied>()("Denied", { entity: Schema.String, operation: Schema.String, reason: Schema.String }) {}

export const guard = (entity: string, operation: string) => (holds: boolean, reason: string) =>
  holds ? Effect.void : Effect.fail(new Denied({ entity, operation, reason }));
