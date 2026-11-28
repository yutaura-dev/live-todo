import { assert, describe, it } from "@effect/vitest";
import { AiError } from "effect/ai";
import { answered, fromAiError, unanswered } from "./answer.js";

const aiError = (reason: AiError.AiErrorReason) => new AiError.AiError({ module: "test", method: "test", reason });

describe("AI のエラーを、ユーザーに回すものと次の同期でやり直すものに分ける", () => {
  it("内容のせいで断られたら、答えなかった（Refused）としてユーザーに回す", () => {
    assert.deepStrictEqual(fromAiError(aiError(new AiError.ContentPolicyError({ description: "policy" }))), unanswered("Refused"));
  });

  it("決まった形で返らなかったら、答えなかった（Invalid）としてユーザーに回す", () => {
    assert.deepStrictEqual(fromAiError(aiError(new AiError.InvalidOutputError({ description: "bad json" }))), unanswered("Invalid"));
  });

  it("通信できなかったら、届かなかったとして次の同期でやり直す", () => {
    assert.deepStrictEqual(fromAiError(aiError(new AiError.NetworkError({ reason: "TransportError", method: "POST", url: "https://example.test" }))), {
      _tag: "Unreachable",
      reason: "Network",
    });
  });

  it("認証が通らなかったら、届かなかった（Authentication）として AI 設定の問題に出せるようにする", () => {
    assert.deepStrictEqual(fromAiError(aiError(new AiError.AuthenticationError({ kind: "InvalidKey" }))), { _tag: "Unreachable", reason: "Authentication" });
  });

  it("答えたときは値をそのまま持つ", () => {
    assert.deepStrictEqual(answered(1), { _tag: "Answered", value: 1 });
  });
});
