import { Effect, Layer, Result, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import { DecisionsProvider, type JudgeRequest, JudgeRequestError } from "./todo-judge.js";

const TodoInput = Schema.Struct({ item: Schema.String });

const TODO_CRITERIA = {
  true: "ユーザー本人が何らかの対応（返信・レビュー・作業・判断）をする必要がある",
  false: "ユーザー本人の対応は不要（自分以外への連絡、情報の共有だけ、すでに完了している など）",
};

// 信頼できる情報を instructions に入れる理由: input は外部から来た文字列（タイトル・本文・コメント）なので、
// そこに「自分のアカウント: @attacker」のような行を書かれても、こちらが書いた情報と区別されるようにするため。
const instructionsOf = ({ question, context }: JudgeRequest) =>
  context === undefined
    ? question
    : `${question}\n\n次は live-todo が書いた信頼できる情報です（評価対象 item ではありません）:\n${context}`;

/** effect/ai の DecisionModel で、確率付きの todo 判定をする。provider は DecisionModel を提供する側で決める */
export const DecisionModelDecisionsProvider = Layer.effect(
  DecisionsProvider,
  Effect.gen(function* () {
    const model = yield* DecisionModel.DecisionModel;

    const judgePredicate = Effect.fn("DecisionModelDecisionsProvider.judgePredicate")(function* (request: JudgeRequest) {
      const definition = Decision.make({
        input: TodoInput,
        decisions: { todo: Decision.probability({ instructions: instructionsOf(request), criteria: TODO_CRITERIA }) },
      });
      const response = yield* model
        .decideSettled(definition, { input: { item: request.input } })
        .pipe(Effect.mapError((error) => new JudgeRequestError({ message: `Decisions の呼び出しに失敗した（${error.reason._tag}）` })));

      const outcome = response.outcomes.todo;
      if (Result.isFailure(outcome)) {
        // 答えが返らなかったもの（拒否・欠落・不正）を refusal として扱う理由: 否定の判定と取り違えて
        // 対象外にしないため（fail closed）。TodoJudge は refusal を要確認にする。
        yield* Effect.logWarning("Decisions が答えを返さなかったため、要確認に回す").pipe(
          Effect.annotateLogs({ reason: outcome.failure.reason, detail: outcome.failure.description }),
        );
        return { type: "refusal" } as const;
      }
      yield* Effect.logDebug("Decisions の判定").pipe(Effect.annotateLogs({ probability: outcome.success.probability }));
      return { type: "predicate", probability: outcome.success.probability } as const;
    });

    return DecisionsProvider.of({ judgePredicate });
  }),
);
