import { Context, Effect, Layer, Result, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import { JudgeRequestError } from "./todo-judge.js";

export type MailKind = "personal" | "notification" | "newsletter";
export type MailClassification = { kind: MailKind; probability: number | undefined; method: "decisions" | "fallback" };
/** probability が undefined（fallback）なら、判定できなかったので対応が要るものとして扱う */
export type ActionJudgment = { probability: number | undefined; method: "decisions" | "fallback" };

/** メールを、人からのメール・お知らせ・メルマガに仕分ける（Decisions API。確率つき） */
export class MailClassifier extends Context.Service<MailClassifier, {
  /** input: メールの中身（外から来た信頼できない文字列）。context: アプリが書いた情報（ヘッダー・Gmail のカテゴリなど） */
  classify(request: { input: string; context: string }): Effect.Effect<MailClassification, JudgeRequestError>;
  /** 受け取った本人に、返信・確認・手続き・支払いなどの対応を求めているか */
  needsAction(request: { input: string; context: string }): Effect.Effect<ActionJudgment, JudgeRequestError>;
}>()("live-todo/core/judge/MailClassifier") {}

const MailInput = Schema.Struct({ mail: Schema.String });

const CRITERIA = {
  personal: "特定の人が自分あてに書いたメール（仕事のやりとり・依頼・質問・連絡）",
  notification: "サービスや仕組みが送る個別のお知らせ（請求・予約・ログイン・発送・アカウントの通知など）",
  newsletter: "多くの人に同じ内容を送るメール（メルマガ・宣伝・ニュースレター・キャンペーン）",
};
const QUESTION = "このメールは次のどれか。";
const ACTION_QUESTION = "このメールは、受け取った本人に具体的な対応を求めているか。";
const ACTION_CRITERIA = {
  true: "返信・確認・回答・手続き・支払い・提出・予約など、受け取った本人がやることを求めている（例: 住所の確認のお願い、更新の手続き、アンケートの回答期限）",
  false: "知らせるだけ・宣伝・完了の通知で、本人がやることはない（例: 発送の通知、公開の完了、セールの案内）",
};
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

    const needsAction = Effect.fn("DecisionModelMailClassifier.needsAction")(function* (request: { input: string; context: string }) {
      const definition = Decision.make({
        input: MailInput,
        decisions: {
          action: Decision.probability({
            instructions: `${ACTION_QUESTION}\n\n次は live-todo が書いた信頼できる情報です（評価対象 mail ではありません）:\n${request.context}`,
            criteria: ACTION_CRITERIA,
          }),
        },
      });
      const response = yield* model
        .decideSettled(definition, { input: { mail: request.input } })
        .pipe(Effect.mapError((error) => new JudgeRequestError({ message: `Decisions の呼び出しに失敗した（${error.reason._tag}）` })));
      const outcome = response.outcomes.action;
      if (Result.isFailure(outcome)) return { probability: undefined, method: "fallback" } satisfies ActionJudgment;
      return { probability: outcome.success.probability, method: "decisions" } satisfies ActionJudgment;
    });

    return MailClassifier.of({ classify, needsAction });
  }),
);
