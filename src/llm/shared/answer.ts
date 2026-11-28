import type { AiError } from "effect/ai";

/** AI が答えなかった理由。どれも否定の答えとしては扱わず、ユーザーに回す（fail closed） */
export type UnansweredReason = "Refused" | "Invalid" | "Missing";

export type Unanswered = { readonly _tag: "Unanswered"; readonly reason: UnansweredReason };
export type Answered<A> = { readonly _tag: "Answered"; readonly value: A };

/** 1 つの問い・1 つの書き物への答え。答えなかったことを値で返し、呼ぶ側に扱いを書かせる */
export type Answer<A> = Answered<A> | Unanswered;

export const answered = <A>(value: A): Answered<A> => ({ _tag: "Answered", value });
export const unanswered = (reason: UnansweredReason): Unanswered => ({ _tag: "Unanswered", reason });

/** AI に届かなかった理由。答えの中身とは関係がないので、次の同期でやり直す */
export type UnreachableReason = "Authentication" | "RateLimit" | "Quota" | "Network" | "Provider" | "Request" | "Unknown";
export type Unreachable = { readonly _tag: "Unreachable"; readonly reason: UnreachableReason };

/**
 * effect/ai のエラーを、答えなかった（ユーザーに回す）と届かなかった（やり直す）に分ける。
 * InvalidResponseError を届かなかった側にする理由: provider の応答が壊れているだけで、同じ入力でもやり直せば返ることが多いため。
 */
export function fromAiError(error: AiError.AiError): Unanswered | Unreachable {
  const reason = error.reason;
  switch (reason._tag) {
    case "ContentPolicyError":
      return unanswered("Refused");
    case "InvalidOutputError":
    case "StructuredOutputError":
      return unanswered("Invalid");
    case "AuthenticationError":
      return { _tag: "Unreachable", reason: "Authentication" };
    case "RateLimitError":
      return { _tag: "Unreachable", reason: "RateLimit" };
    case "QuotaExhaustedError":
      return { _tag: "Unreachable", reason: "Quota" };
    case "NetworkError":
      return { _tag: "Unreachable", reason: "Network" };
    case "InternalProviderError":
    case "InvalidResponseError":
      return { _tag: "Unreachable", reason: "Provider" };
    case "InvalidRequestError":
    case "UnsupportedSchemaError":
      return { _tag: "Unreachable", reason: "Request" };
    default:
      return { _tag: "Unreachable", reason: "Unknown" };
  }
}
