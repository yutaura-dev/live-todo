import { Schema } from "effect";

export const AiRole = Schema.Literals(["Decisions", "Generation", "Agent"]);
export type AiRole = typeof AiRole.Type;

const Usage = Schema.Struct({ inputTokens: Schema.NullOr(Schema.Number), outputTokens: Schema.NullOr(Schema.Number) });

/** 1 つの問いへの答えの記録。確率と理由（なぜ答えなかったか）だけを持ち、入力の中身は持たない（本文を残さないため） */
export const AnswerRecord = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Answered"), probabilities: Schema.Record(Schema.String, Schema.Number) }),
  Schema.Struct({ _tag: Schema.Literal("Unanswered"), reason: Schema.Literals(["Refused", "Invalid", "Missing"]) }),
]);
export type AnswerRecord = typeof AnswerRecord.Type;

/**
 * AI を 1 回呼んだ記録（問いの版・確率）。Decisions は理由を返さないので、あとから判定を追えるように残す（routing・task-proposal の judgment）。
 * ベンチマークも同じ形で結果を残し、アプリの記録と比べられるようにする。
 */
export const CallRecord = Schema.Struct({
  role: AiRole,
  /** どの使い道か（問い・書き物の ID） */
  purpose: Schema.String,
  /** 問い・指示の版。文面を変えたら上げる */
  version: Schema.Number,
  modelId: Schema.NullOr(Schema.String),
  /** 問いごとの答え（Generation は 1 つの書き物なので "output" だけ） */
  answers: Schema.Record(Schema.String, AnswerRecord),
  usage: Usage,
});
export type CallRecord = typeof CallRecord.Type;
