import { Effect, Result, Schema } from "effect";
import { Decision, DecisionModel, LanguageModel } from "effect/ai";
import { dossierInput, type TaskDossier } from "../task/dossier.js";

export class RuleConditionError extends Schema.TaggedError<RuleConditionError>()("RuleConditionError", { message: Schema.String }) {}

export const RuleConditionClause = Schema.Struct({
  question: Schema.String.annotate({ description: "Task についての、はい / いいえで答えられる単純な問い。否定を含めない肯定の形で書く" }),
  expect: Schema.Boolean.annotate({ description: "条件に当てはまるときの、この問いの答え" }),
  about: Schema.Literals(["metadata", "content"]).annotate({
    description:
      "metadata: アプリが記録している項目（Source の種類、PR か Issue か、リポジトリ、作成者・差出人、通知の理由、レビュー依頼の宛先、アサイン、発言者、状態（マージ・閉じた・conflict・CI の結果・見張りの条件）、Task の状態・作られ方、事実の数）だけで答えられる問い。本文に同じことが書かれていても metadata にする / content: タイトルや本文の内容（何についての話か、何を頼まれているか、質問か・催促か）を読まないと答えられない問い",
  }),
});

/** ルールの「どういう時」を分けた問い（ADR-0019）。保存するときに 1 回だけ作り、利用者に見せて確かめてもらう */
export const RuleCondition = Schema.Struct({
  combine: Schema.Literals(["all", "any"]).annotate({ description: "all: すべての問いが expect どおりのとき当てはまる / any: どれか 1 つでよい" }),
  clauses: Schema.Array(RuleConditionClause),
});
export type RuleCondition = typeof RuleCondition.Type;

const MAX_CLAUSES = 4;

// 分け方の決まりは spike（ADR-0019）で外れ方を見ながら決めた。どれも、外したときに起きたことを防ぐためのもの
const promptOf = (condition: string) => `あなたは、todo 管理アプリのルールの条件を、判定しやすい単純な問いに分解する。
ルールの条件は Task（自分がやること）について書かれている。Task には GitHub の PR・Issue、Slack のメッセージ、メールなどの事実が 0 件以上紐づく。
条件を、Task とその事実についての、はい / いいえで答えられる単純な問いに分解する。

- 1 つの問いには 1 つのことだけを聞く（「A かつ B か」と聞かない）
- 問いは否定を含めない肯定の形で書き、条件に当てはまるときの答えを expect に書く（「レビュー依頼が来ていない」なら、問いは「レビュー依頼が来ているか」、expect は false。「事実が紐づいていない」なら、問いは「事実が紐づいているか」、expect は false）。「〜ないか」「〜以外か」の形にしない
- 問いの主語は「紐づく事実」か「Task」にする（「GitHub の PR か」ではなく「紐づく事実に GitHub の PR があるか」）
- 「A または B」「A や B」は分けずに、1 つの問い「A または B か」にする（「YutaUra か YutaUra を含むチームにレビュー依頼が来ているか」「請求書や領収書に関するメールか」）
- 分けるのは「かつ」でつながる、別々のことだけ。分けなくても判定できるなら分けない
- 条件に書かれていないことを足さない。条件の言葉（人の名前・ラベル名など）はそのまま使う
- 条件が特定の種類の事実（PR・Issue・メール・Slack のメッセージなど）について言っているなら、最初の問いを必ず「紐づく事実に〜があるか」（expect: true）にし、残りの問いは「その PR の〜」「そのメールの〜」とその事実を指して聞く。否定の問い（expect: false）だけだと、その事実が紐づいていない Task でも当てはまってしまうため
- 問いは 1〜${MAX_CLAUSES} 個にする。combine はほとんどの場合 all にする
- 問いごとに、アプリが記録している項目だけで答えられるか（metadata）、タイトルや本文の内容を読む必要があるか（content）を about に書く
- 1 つの問いの中に、記録している項目（誰から・種類・状態など）と内容（何を頼まれているか・何の話か）の両方が要るなら、2 つの問いに分ける（「alice からの依頼」は「紐づく事実に、alice が作成者・発言者・差出人のものがあるか」（metadata）と「その事実は依頼か」（content））
- 括弧の中の言い換え・補足（「マージされた（閉じた）PR」）は、別の条件ではない。分けずに 1 つの問いにする

条件: ${condition}`;

/** 保存するときに 1 回だけ、条件を単純な問いに分ける */
export const decomposeCondition = Effect.fnUntraced(function* (condition: string) {
  const model = yield* LanguageModel.LanguageModel;
  const response = yield* model
    .generateObject({ objectName: "rule_condition", schema: RuleCondition, prompt: promptOf(condition) })
    .pipe(Effect.mapError((error) => new RuleConditionError({ message: `条件を読み取れなかった（${error.reason._tag}）` })));
  const decomposed = response.value;
  if (decomposed.clauses.length === 0 || decomposed.clauses.length > MAX_CLAUSES) {
    return yield* new RuleConditionError({ message: "条件を判定できる問いに分けられませんでした。何に当てるかを具体的に書いてください" });
  }
  return decomposed;
});

// 問いの主語が Task か事実かで迷わせない（「PR か」を「Task は PR か」と読んで、いいえ寄りに迷った）
const FRAME = "この Task と、Task に紐づく事実（facts）についての問い: ";

/**
 * 分けた問いを Decisions でまとめて聞き、条件に当てはまる確率にする。どれかの答えが返らなければ undefined（当てない）。
 * all は最小値にする。積だと、問いごとには十分高くても閾値を割った（0.84 × 0.97 × 0.96 = 0.78）
 */
export const conditionProbability = Effect.fnUntraced(function* (condition: RuleCondition, dossier: TaskDossier) {
  const model = yield* DecisionModel.DecisionModel;
  const keyed = condition.clauses.map((clause, index) => ({ key: `q${index}`, clause }));
  const ask = (about: "metadata" | "content") =>
    Effect.gen(function* () {
      const targets = keyed.filter(({ clause }) => clause.about === about);
      if (targets.length === 0) return {} as Record<string, Result.Result<{ probability: number }, unknown>>;
      const decisions = Object.fromEntries(
        targets.map(({ key, clause }) => [key, Decision.probability({ instructions: `${FRAME}${clause.question}`, criteria: { true: "はい", false: "いいえ" } })]),
      );
      const response = yield* model.decideSettled(Decision.make({ input: Schema.Unknown, decisions }), {
        input: dossierInput(dossier, { text: about === "content" }),
      });
      return response.outcomes as Record<string, Result.Result<{ probability: number }, unknown>>;
    });
  const outcomes = { ...(yield* ask("metadata")), ...(yield* ask("content")) };
  const matched: number[] = [];
  for (const { key, clause } of keyed) {
    const outcome = outcomes[key];
    if (outcome === undefined || !Result.isSuccess(outcome)) return undefined;
    matched.push(clause.expect ? outcome.success.probability : 1 - outcome.success.probability);
  }
  return condition.combine === "any" ? Math.max(...matched) : Math.min(...matched);
});
