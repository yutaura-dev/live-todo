import { Context, type Effect, Schema } from "effect";
import type { NotionRecordMap } from "./notion-records.js";

export class NotionRequestError extends Schema.TaggedError<NotionRequestError>()("NotionRequestError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export class NotionRateLimitedError extends Schema.TaggedError<NotionRateLimitedError>()("NotionRateLimitedError", {
  resetAt: Schema.String,
}) {}

export type NotionClientError = NotionRequestError | NotionRateLimitedError;

export type NotionSpace = { id: string; name: string };

/** Notion の Web クライアントの API（ブラウザのセッションで使う。ADR-0015） */
export class NotionClient extends Context.Service<NotionClient, {
  /** セッションの持ち主（自分）と、入っているワークスペース */
  readonly me: Effect.Effect<{ userId: string; name: string; spaces: ReadonlyArray<NotionSpace> }, NotionClientError>;
  /** 受信トレイの通知（新しい順、既読も含む）。recordMap は入れ子を外したもの */
  notifications(spaceId: string, size: number): Effect.Effect<{ notificationIds: ReadonlyArray<string>; recordMap: NotionRecordMap }, NotionClientError>;
}>()("live-todo/sources/notion/NotionClient") {}
