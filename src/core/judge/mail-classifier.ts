import { Context, Effect, Layer, Result, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import { JudgeRequestError } from "./todo-judge.js";

export type MailKind = "personal" | "notification" | "newsletter";
export type MailClassification = { kind: MailKind; probability: number | undefined; method: "decisions" | "fallback" };
/** メルマガ・お知らせの用件。送り主ごとにまとめるときの、もう一段の単位 */
export const MAIL_TOPICS = ["billing", "account", "product", "contract", "shipping", "promotion", "news", "other"] as const;
export type MailTopic = (typeof MAIL_TOPICS)[number];
export const MAIL_TOPIC_LABELS: Record<MailTopic, string> = {
  billing: "請求・支払い",
  account: "アカウント・セキュリティ",
  product: "製品・サービスの変更",
  contract: "契約・更新・予約",
  shipping: "注文・配送",
  promotion: "宣伝・キャンペーン",
  news: "ニュース・読み物",
  other: "その他",
};

/** probability が undefined（fallback）なら、判定できなかったので対応が要るものとして扱う */
export type ActionJudgment = { probability: number | undefined; method: "decisions" | "fallback"; topic: MailTopic };

/** メールを、人からのメール・お知らせ・メルマガに仕分ける（Decisions API。確率つき） */
export class MailClassifier extends Context.Service<MailClassifier, {
  /** input: メールの中身（外から来た信頼できない文字列）。context: アプリが書いた情報（ヘッダー・Gmail のカテゴリなど） */
  classify(request: { input: string; context: string }): Effect.Effect<MailClassification, JudgeRequestError>;
  /** 受け取った本人に、返信・確認・手続き・支払いなどの対応を求めているかと、メールの用件（同じ呼び出しで聞く） */
  needsAction(request: { input: string; context: string }): Effect.Effect<ActionJudgment, JudgeRequestError>;
  /** 利用者が言葉で書いたルールの条件（「請求書に関するメール」など）に当てはまるか。答えが返らなければ probability なし */
  matchesCondition(request: { input: string; context: string; condition: string }): Effect.Effect<{ probability: number | undefined }, JudgeRequestError>;
}>()("live-todo/core/judge/MailClassifier") {}

const MailInput = Schema.Struct({ mail: Schema.String });

const CRITERIA = {
  personal: "特定の人が自分あてに書いたメール（仕事のやりとり・依頼・質問・連絡）",
  notification: "サービスや仕組みが送る個別のお知らせ（請求・予約・ログイン・発送・アカウントの通知など）",
  newsletter: "多くの人に同じ内容を送るメール（メルマガ・宣伝・ニュースレター・キャンペーン）",
};
const QUESTION = "このメールは次のどれか。";
const TOPIC_QUESTION = "このメールの用件は次のどれか。";
const TOPIC_CRITERIA: Record<MailTopic, string> = {
  billing: "請求書・領収書・支払い・引き落とし・入金",
  account: "ログイン・パスワード・認証・セキュリティの通知",
  product: "製品・サービスの仕様や料金・規約の変更、新機能",
  contract: "契約・会員・ドメインなどの更新、予約、申し込み",
  shipping: "注文の受付・発送・配達",
  promotion: "セール・キャンペーン・クーポンなどの宣伝",
  news: "ニュースレター・記事・読み物",
  other: "上のどれでもない",
};
// これより確率が低い用件は「その他」にする（迷うものを無理に分けない）
const MIN_TOPIC_PROBABILITY = 0.5;
const ACTION_QUESTION = "このメールは、受け取った本人に具体的な対応を求めているか。";
const ACTION_CRITERIA = {
  true: "返信・確認・回答・手続き・支払い・提出・予約など、受け取った本人がやることを求めている（例: 住所の確認のお願い、更新の手続き、アンケートの回答期限）",
  false: "知らせるだけ・宣伝・完了の通知で、本人がやることはない（例: 発送の通知、公開の完了、セールの案内）",
};
// これより確率が低いときは、メルマガやお知らせと決めつけず、人からのメールとして扱う（見落とさないため）
const MIN_PROBABILITY = 0.6;
const FALLBACK: MailClassification = { kind: "personal", probability: undefined, method: "fallback" };
const MAX_PERSONAL_FOR_BULK = 0.25;

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
      // お知らせかメルマガかで確率が割れると、どちらも 0.6 に届かずに人からのメールに倒れていた（mail:eval で、人からと仕分けた
      // 9 件がすべてこれ）。人からのメールの確率が十分低ければ、人からではないとして高いほうに仕分ける
      const personal = outcome.success.probabilities.personal ?? 1;
      if (probability < MIN_PROBABILITY && personal <= MAX_PERSONAL_FOR_BULK) {
        const [bulkKind, bulkProbability] = entries.filter(([label]) => label !== "personal").reduce((best, entry) => (entry[1] > best[1] ? entry : best));
        return { kind: bulkKind, probability: bulkProbability, method: "decisions" } satisfies MailClassification;
      }
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
          topic: Decision.classify({ instructions: TOPIC_QUESTION, criteria: TOPIC_CRITERIA }),
        },
      });
      const response = yield* model
        .decideSettled(definition, { input: { mail: request.input } })
        .pipe(Effect.mapError((error) => new JudgeRequestError({ message: `Decisions の呼び出しに失敗した（${error.reason._tag}）` })));
      const topicOutcome = response.outcomes.topic;
      const topic: MailTopic = Result.isFailure(topicOutcome)
        ? "other"
        : (() => {
            const [label, probability] = (Object.entries(topicOutcome.success.probabilities) as Array<[MailTopic, number]>).reduce((best, entry) => (entry[1] > best[1] ? entry : best));
            return probability >= MIN_TOPIC_PROBABILITY ? label : "other";
          })();
      const outcome = response.outcomes.action;
      if (Result.isFailure(outcome)) return { probability: undefined, method: "fallback", topic } satisfies ActionJudgment;
      return { probability: outcome.success.probability, method: "decisions", topic } satisfies ActionJudgment;
    });

    const matchesCondition = Effect.fn("DecisionModelMailClassifier.matchesCondition")(function* (request: { input: string; context: string; condition: string }) {
      // 条件を instructions に入れる理由: メールの中に書かれた文を、利用者の決めた条件と取り違えないようにするため
      const definition = Decision.make({
        input: MailInput,
        decisions: {
          condition: Decision.probability({
            instructions: `このメールは、次の条件に当てはまるか。\n条件: ${request.condition}\n\n次は live-todo が書いた信頼できる情報です（評価対象 mail ではありません）:\n${request.context}`,
            criteria: { true: "条件に当てはまる", false: "条件に当てはまらない" },
          }),
        },
      });
      const response = yield* model
        .decideSettled(definition, { input: { mail: request.input } })
        .pipe(Effect.mapError((error) => new JudgeRequestError({ message: `Decisions の呼び出しに失敗した（${error.reason._tag}）` })));
      const outcome = response.outcomes.condition;
      return { probability: Result.isFailure(outcome) ? undefined : outcome.success.probability };
    });

    return MailClassifier.of({ classify, needsAction, matchesCondition });
  }),
);
