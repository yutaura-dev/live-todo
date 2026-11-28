import { Schema } from "effect";
import { AiRole } from "./record.js";

/**
 * AI に届かなかった（認証・上限・通信・provider の不調）。答えの中身とは関係がないので、Task も振り分けも変えず、次の同期でやり直す。
 * 答えなかった（断られた・形に合わない）はエラーにせず、Answer の値で返す（呼ぶ側に、ユーザーに回す扱いを必ず書かせるため）。
 */
export class AiUnreachableError extends Schema.TaggedError<AiUnreachableError>()("AiUnreachableError", {
  role: AiRole,
  purpose: Schema.String,
  reason: Schema.Literals(["Authentication", "RateLimit", "Quota", "Network", "Provider", "Request", "Unknown"]),
}) {}
