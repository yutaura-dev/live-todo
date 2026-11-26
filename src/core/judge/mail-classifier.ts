import { Context, Effect, Layer, Result, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import { JudgeRequestError } from "./todo-judge.js";

export type MailKind = "personal" | "notification" | "newsletter";
export type MailClassification = { kind: MailKind; probability: number | undefined; method: "decisions" | "fallback" };

/** メールを、人からのメール・お知らせ・メルマガに仕分ける（Decisions API。確率つき） */
export class MailClassifier extends Context.Service<MailClassifier, {
  /** input: メールの中身（外から来た信頼できない文字列）。context: アプリが書いた情報（ヘッダー・Gmail のカテゴリなど） */
  classify(request: { input: string; context: string }): Effect.Effect<MailClassification, JudgeRequestError>;
}>()("live-todo/core/judge/MailClassifier") {}

const MailInput = Schema.Struct({ mail: Schema.String });

const CRITERIA = {
  personal: "特定の人が自分あてに書いたメール（仕事のやりとり・依頼・質問・連絡）",
  notification: "サービスや仕組みが送る個別のお知らせ（請求・予約・ログイン・発送・アカウントの通知など）",
  newsletter: "多くの人に同じ内容を送るメール（メルマガ・宣伝・ニュースレター・キャンペーン）",
};
const QUESTION = "このメールは次のどれか。";
// これより確率が低いときは、メルマガやお知らせと決めつけず、人からのメールとして扱う（見落とさないため）
const MIN_PROBABILITY = 0.6;
const FALLBACK: MailClassification = { kind: "personal", probability: undefined, method: "fallback" };

export const DecisionModelMailClassifier = Layer.effect(
  MailClassifier,
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel;

    const classify = Effect.fn("DecisionModelMailClassifier.classify")(function* (request: { input: string; context: string }) {
      // アプリが書いた情報を instructions に入れる理由: メールの中に「List-Unsubscribe: なし」のような行を書かれても、
      // こちらが書いた情報と区別されるようにするため
      const definition = Decision.make({
        input: MailInput,
        decisions: {
          kind: Decision.classify({
            instructions: `${QUESTION}\n\n次は live-todo が書いた信頼できる情報です（評価対象 mail ではありません）:\n${request.context}`,
            criteria: CRITERIA,
          }),
        },
      });
      const response = yield* model
        .decideSettled(definition, { input: { mail: request.input } })
        .pipe(Effect.mapError((error) => new JudgeRequestError({ message: `Decisions の呼び出しに失敗した（${error.reason._tag}）` })));
      const outcome = response.outcomes.kind;
      if (Result.isFailure(outcome)) return FALLBACK;
      const entries = Object.entries(outcome.success.probabilities) as Array<[MailKind, number]>;
      const [kind, probability] = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
      if (probability < MIN_PROBABILITY) return FALLBACK;
      return { kind, probability, method: "decisions" } satisfies MailClassification;
    });

    return MailClassifier.of({ classify });
  }),
);
