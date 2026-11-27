import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { AiError, type Decision, DecisionModel } from "effect/ai";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";

const MODULE = "MicrosoftDecisionModel";
const SYSTEMONE_PATH = "/providers/microsoft/v1/systemone";

const NoulAnswer = Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Finite });
const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: Schema.optional(Schema.Finite),
  probabilities: Schema.Record(Schema.String, Schema.Finite),
});
const decodeAnswer = Schema.decodeUnknownOption(Schema.Union([NoulAnswer, ChoiceAnswer]));

const decodeResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    model: Schema.optional(Schema.String),
    // 答えは 1 つずつ読む。1 つが読めない形でも、ほかの答えまで捨てないため
    answers: Schema.Record(Schema.String, Schema.Unknown),
    usage: Schema.optional(Schema.Struct({ input_tokens: Schema.optional(Schema.Finite), output_tokens: Schema.optional(Schema.Finite) })),
  }),
);

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ code: Schema.optional(Schema.String), message: Schema.optional(Schema.String) }) }),
);

const aiError = (reason: AiError.AiErrorReason) => AiError.make({ module: MODULE, method: "decide", reason });

const describe = (description: Decision.Description | null, fallback: string) =>
  description === null ? fallback : typeof description === "string" ? description : JSON.stringify(description);

const encodeQuestion = Effect.fnUntraced(function* (name: string, decision: Exclude<Decision.Any, Decision.Locate>) {
  const instructions = describe(decision.instructions, name);
  switch (decision._tag) {
    case "Probability":
      return {
        type: "noul",
        instructions,
        ...(decision.criteria === undefined
          ? {}
          : { criteria: { true: describe(decision.criteria.true, "true"), false: describe(decision.criteria.false, "false") } }),
      };
    case "Classify":
      return {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(Object.entries(decision.criteria).map(([label, description]) => [label, describe(description, label)])),
      };
    case "Rate":
      // score の答えは段階ごとの確率でなく加重平均だけと書かれていて、effect/ai の Rate（段階ごとの確率が要る）に直せないため。
      // 今のアプリは Rate を使っていない
      return yield* Effect.fail(aiError(new AiError.InvalidUserInputError({ description: "Microsoft-Decision では score（Rate）にまだ対応していない" })));
  }
});

// 知らない形の答え（拒否など）は入れずに省く理由: effect/ai が「答えなし」として扱い、呼び出し側が要確認に回せるようにするため（fail closed）
const toProviderAnswer = (raw: unknown): DecisionModel.ProviderAnswer | undefined =>
  Option.match(decodeAnswer(raw), {
    onNone: () => undefined,
    onSome: (answer) =>
      answer.type === "noul"
        ? { _tag: "Probability", probability: answer.noul }
        : { _tag: "Classify", label: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence },
  });

/** Microsoft Foundry の Microsoft-Decision（systemone）を DecisionModel として使う */
export const make = Effect.fnUntraced(function* (options: { endpoint: string; deployment: string; apiKey: Redacted.Redacted<string> }) {
  const client = yield* HttpClient.HttpClient;
  const url = `${options.endpoint}${SYSTEMONE_PATH}`;

  return yield* DecisionModel.make({
    decide: Effect.fnUntraced(function* ({ state, decisions }) {
      const questions: Record<string, unknown> = {};
      for (const [name, decision] of Object.entries(decisions)) questions[name] = yield* encodeQuestion(name, decision);

      const request = HttpClientRequest.post(url).pipe(
        // api-key ヘッダにする理由: Authorization: Bearer は Entra ID のトークン用で、API キーは api-key で送ると決まっているため
        HttpClientRequest.setHeader("api-key", Redacted.value(options.apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.setBody(HttpBody.jsonUnsafe({ model: options.deployment, state, questions })),
      );
      // 失敗をリクエストごと持ち越さない理由: api-key ヘッダは既定の伏せ字の対象外で、ログに API キーが出るため
      const response = yield* client
        .execute(request)
        .pipe(
          Effect.mapError(() =>
            aiError(new AiError.NetworkError({ reason: "TransportError", method: "POST", url, description: "Microsoft-Decision に接続できなかった" })),
          ),
        );
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));

      if (response.status < 200 || response.status >= 300) {
        const detail = Option.match(decodeErrorBody(body), {
          onNone: () => undefined,
          onSome: ({ error }) => [error.code, error.message].filter((part) => part !== undefined).join(": "),
        });
        return yield* Effect.fail(aiError(AiError.reasonFromHttpStatus({ status: response.status, description: detail || `HTTP ${response.status}` })));
      }

      const decoded = decodeResponse(body);
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(aiError(new AiError.InvalidResponseError({ description: "Microsoft-Decision の応答が読めない形だった" })));
      }

      const answers: Record<string, DecisionModel.ProviderAnswer> = {};
      for (const [name, raw] of Object.entries(decoded.value.answers)) {
        const answer = toProviderAnswer(raw);
        if (answer !== undefined) answers[name] = answer;
      }
      return {
        answers,
        usage: { inputTokens: decoded.value.usage?.input_tokens, outputTokens: decoded.value.usage?.output_tokens },
        modelId: decoded.value.model,
      };
    }),
  });
});

export const MicrosoftDecisionModel = {
  layer: (options: { endpoint: string; deployment: string; apiKey: Redacted.Redacted<string> }) =>
    Layer.effect(DecisionModel.DecisionModel, make(options)),
};
