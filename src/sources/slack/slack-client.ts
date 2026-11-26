import { Context, type Effect, type Option, Schema } from "effect";

export class SlackRequestError extends Schema.TaggedError<SlackRequestError>()("SlackRequestError", {
  message: Schema.String,
  /** Slack が返した理由（invalid_auth など） */
  error: Schema.optional(Schema.String),
}) {}

export class SlackRateLimitedError extends Schema.TaggedError<SlackRateLimitedError>()("SlackRateLimitedError", {
  resetAt: Schema.String,
}) {}

export type SlackClientError = SlackRequestError | SlackRateLimitedError;

export type SavedListPage = { items: ReadonlyArray<unknown>; nextCursor: string; totalCount: number | undefined };

/** Slack の Web クライアントの API（ブラウザのセッションで使う。ADR-0010） */
export class SlackClient extends Context.Service<SlackClient, {
  /** To-do・Saved の 1 ページ。filter を省くと未完了、completed で完了済み */
  savedList(params: { filter?: "completed"; cursor?: string }): Effect.Effect<SavedListPage, SlackClientError>;
  /** メッセージ 1 件の本文。見られない・消えたなら none */
  message(channel: string, ts: string): Effect.Effect<Option.Option<{ text: string; user: string | undefined }>, SlackClientError>;
  /** ユーザーの表示名。分からなければ none */
  userName(userId: string): Effect.Effect<Option.Option<string>, SlackClientError>;
  /** チャンネルの名前と DM かどうか。見られないチャンネル（退出・アーカイブ・共有など）なら none */
  channel(channelId: string): Effect.Effect<Option.Option<{ name: string; isDirect: boolean }>, SlackClientError>;
  /** To-do を完了にする（外部への書き込み。ユーザーの承認を経てからだけ呼ぶ） */
  completeSaved(channel: string, ts: string): Effect.Effect<void, SlackClientError>;
  /** To-do・Saved から外す。メッセージは消えない（外部への書き込み。ユーザーの承認を経てからだけ呼ぶ） */
  removeSaved(channel: string, ts: string): Effect.Effect<void, SlackClientError>;
  /** セッションの持ち主（自分）とワークスペース */
  readonly authTest: Effect.Effect<{ userId: string; user: string; team: string }, SlackClientError>;
}>()("live-todo/sources/slack/SlackClient") {}
