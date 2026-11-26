import { Context, type Effect, type Option, Schema } from "effect";

export class GmailRequestError extends Schema.TaggedError<GmailRequestError>()("GmailRequestError", {
  message: Schema.String,
  /** Gmail が返した HTTP のステータス（分かるときだけ） */
  status: Schema.optional(Schema.Number),
}) {}

/** 履歴の起点が古すぎて差分を取れない。全件を取り直す */
export class GmailHistoryExpiredError extends Schema.TaggedError<GmailHistoryExpiredError>()("GmailHistoryExpiredError", {}) {}

export type GmailClientError = GmailRequestError | GmailHistoryExpiredError;

/** 仕分けと集計に使うヘッダー（小文字の名前） */
export const MAIL_HEADERS = [
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "list-id",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "precedence",
  "auto-submitted",
] as const;
export type MailHeader = (typeof MAIL_HEADERS)[number];

export type GmailMessage = {
  id: string;
  threadId: string;
  /** 受け取った時刻（ミリ秒） */
  receivedAt: number;
  labelIds: ReadonlyArray<string>;
  headers: Partial<Record<MailHeader, string>>;
};

export type GmailThreadMessage = GmailMessage & { text: string };

export type GmailHistory = {
  historyId: string;
  /** 新しく届いた・ラベルが変わった・消えたメール */
  added: ReadonlyArray<string>;
  labelsChanged: ReadonlyArray<string>;
  deleted: ReadonlyArray<string>;
};

/** Gmail（gws CLI 経由。認証は gws に任せる） */
export class GmailClient extends Context.Service<GmailClient, {
  /** 今の履歴の位置 */
  readonly historyId: Effect.Effect<string, GmailClientError>;
  /** 検索に当たるメールの id（新しい順）。pageToken で続きを取る */
  listMessages(query: string, pageToken?: string): Effect.Effect<{ ids: ReadonlyArray<string>; nextPageToken: string | undefined }, GmailClientError>;
  /** メール 1 通のヘッダーとラベル（本文は取らない）。消えていれば none */
  message(id: string): Effect.Effect<Option.Option<GmailMessage>, GmailClientError>;
  /** startHistoryId からの変化。古すぎれば GmailHistoryExpiredError */
  history(startHistoryId: string): Effect.Effect<GmailHistory, GmailClientError>;
  /** 招待のメールに付いた予定のファイル（text/calendar）の中身。付いていなければ none */
  calendar(id: string): Effect.Effect<Option.Option<string>, GmailClientError>;
  /** スレッドのメール（古い順、本文つき） */
  thread(threadId: string): Effect.Effect<ReadonlyArray<GmailThreadMessage>, GmailClientError>;
  readonly labels: Effect.Effect<ReadonlyArray<{ id: string; name: string }>, GmailClientError>;
  /** ラベルを作る（外部への書き込み。利用者が決めたルールか、承認を経てからだけ呼ぶ） */
  createLabel(name: string): Effect.Effect<{ id: string }, GmailClientError>;
  /** ラベルを付け外しする（外部への書き込み。利用者が決めたルールか、承認を経てからだけ呼ぶ） */
  modifyLabels(id: string, change: { add: ReadonlyArray<string>; remove: ReadonlyArray<string> }): Effect.Effect<void, GmailClientError>;
  /** 確認済みにする: 受信トレイから外して（アーカイブ）既読にする（外部への書き込み。ユーザーの承認を経てからだけ呼ぶ） */
  archive(id: string): Effect.Effect<void, GmailClientError>;
  /** ゴミ箱に入れる（外部への書き込み。ユーザーの承認を経てからだけ呼ぶ） */
  trash(id: string): Effect.Effect<void, GmailClientError>;
}>()("live-todo/sources/gmail/GmailClient") {}
