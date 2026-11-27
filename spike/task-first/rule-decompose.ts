import { Effect, Result, Schema } from "effect";
import { Decision, DecisionModel, LanguageModel } from "effect/ai";
import type { TaskDossier } from "./model.js";
import { structuredInputOf } from "./rule-condition.js";

export const Clause = Schema.Struct({
  question: Schema.String.annotate({ description: "Task についての、はい / いいえで答えられる単純な問い。否定を含めない肯定の形で書く" }),
  expect: Schema.Boolean.annotate({ description: "条件に当てはまるときの、この問いの答え" }),
  about: Schema.Literals(["metadata", "content"]).annotate({
    description:
      "metadata: アプリが記録している項目（Source の種類、PR か Issue か、リポジトリ、作成者・差出人、通知の理由、レビュー依頼の宛先、アサイン、発言者、状態（マージ・閉じた・conflict・CI の結果・見張りの条件）、Task の状態・作られ方、事実の数）だけで答えられる問い。本文に同じことが書かれていても metadata にする / content: タイトルや本文の内容（何についての話か、何を頼まれているか、質問か・催促か）を読まないと答えられない問い",
  }),
});
export const Decomposition = Schema.Struct({
  combine: Schema.Literals(["all", "any"]).annotate({ description: "all: すべての問いが expect どおりのとき当てはまる / any: どれか 1 つでよい" }),
  clauses: Schema.Array(Clause),
});
export type Decomposition = typeof Decomposition.Type;

const prompt = (condition: string) => `あなたは、todo 管理アプリのルールの条件を、判定しやすい単純な問いに分解する。
ルールの条件は Task（自分がやること）について書かれている。Task には GitHub の PR・Issue、Slack のメッセージ、メールなどの事実が 0 件以上紐づく。
条件を、Task とその事実についての、はい / いいえで答えられる単純な問いに分解する。

- 1 つの問いには 1 つのことだけを聞く（「A かつ B か」と聞かない）
- 問いは否定を含めない肯定の形で書き、条件に当てはまるときの答えを expect に書く（「レビュー依頼が来ていない」なら、問いは「レビュー依頼が来ているか」、expect は false。「事実が紐づいていない」なら、問いは「事実が紐づいているか」、expect は false）。「〜ないか」「〜以外か」の形にしない
- 問いの主語は「紐づく事実」か「Task」にする（「GitHub の PR か」ではなく「紐づく事実に GitHub の PR があるか」）
- 「A または B」「A や B」は分けずに、1 つの問い「A または B か」にする（「YutaUra か YutaUra を含むチームにレビュー依頼が来ているか」「請求書や領収書に関するメールか」）
- 分けるのは「かつ」でつながる、別々のことだけ。分けなくても判定できるなら分けない
- 条件に書かれていないことを足さない。条件の言葉（人の名前・ラベル名など）はそのまま使う
- 条件が特定の種類の事実（PR・Issue・メール・Slack のメッセージなど）について言っているなら、最初の問いを必ず「紐づく事実に〜があるか」（expect: true）にし、残りの問いは「その PR の〜」「そのメールの〜」とその事実を指して聞く。否定の問い（expect: false）だけだと、その事実が紐づいていない Task でも当てはまってしまうため
- 問いは 1〜4 個にする。combine はほとんどの場合 all にする
- 問いごとに、アプリが記録している項目だけで答えられるか（metadata）、タイトルや本文の内容を読む必要があるか（content）を about に書く
- 1 つの問いの中に、記録している項目（誰から・種類・状態など）と内容（何を頼まれているか・何の話か）の両方が要るなら、2 つの問いに分ける（「alice からの依頼」は「紐づく事実に、alice が作成者・発言者・差出人のものがあるか」（metadata）と「その事実は依頼か」（content））
- 括弧の中の言い換え・補足（「マージされた（閉じた）PR」）は、別の条件ではない。分けずに 1 つの問いにする
- 事実の性質（種類・作成者・状態・依頼の宛先など）を聞く問いの主語は、Task ではなく「紐づく事実」にする（「Task は自分がアサインされたものか」ではなく「紐づく事実に、自分がアサインされた Issue があるか」）

条件: ${condition}`;

/** 保存するときに 1 回だけ、条件を単純な問いに分解する */
export const decompose = Effect.fnUntraced(function* (condition: string) {
  const model = yield* LanguageModel.LanguageModel;
  const response = yield* model.generateObject({ objectName: "rule_condition", schema: Decomposition, prompt: prompt(condition) });
  return response.value;
});

export type Combine = "product" | "min";
// 問いの主語が Task か事実かで迷わせない（「PR か」を「Task は PR か」と読んで、いいえ寄りに迷った）
const FRAME = "この Task と、Task に紐づく事実（facts）についての問い: ";
/** ベンチマークで、問いごとの確率を見るため */
export let lastParts: number[] = [];

/** 分解した問いを Decisions でまとめて聞き、条件に当てはまる確率にする。どれかの答えがなければ undefined */
export const decomposedProbability = Effect.fnUntraced(function* (decomposition: Decomposition, task: TaskDossier, combine: Combine = "product") {
  const model = yield* DecisionModel.DecisionModel;
  // metadata の問いは、本文とタイトルを渡さずに聞く。外の人が書いた文の中の偽の主張（「作成者: dependabot」など）を届かせないため。
  // 注意書きで「本文を信じるな」と書くと、内容についての問いまで弱くなった（spike の note-variants）
  const ask = (about: "metadata" | "content") =>
    Effect.gen(function* () {
      const targets = decomposition.clauses.flatMap((clause, index) => (clause.about === about ? [[`q${index}`, clause] as const] : []));
      if (targets.length === 0) return {} as Record<string, unknown>;
      const decisions = Object.fromEntries(targets.map(([key, clause]) => [key, Decision.probability({ instructions: `${FRAME}${clause.question}`, criteria: { true: "はい", false: "いいえ" } })]));
      const definition = Decision.make({ input: Schema.Unknown, decisions });
      const response = yield* model.decideSettled(definition, { input: about === "metadata" ? metadataInputOf(task) : structuredInputOf(task) });
      return response.outcomes as Record<string, unknown>;
    });
  const outcomes = { ...(yield* ask("metadata")), ...(yield* ask("content")) };
  const ps: number[] = [];
  for (const [index, clause] of decomposition.clauses.entries()) {
    const outcome = outcomes[`q${index}`] as Result.Result<{ probability: number }, unknown> | undefined;
    if (outcome === undefined || !Result.isSuccess(outcome)) return undefined;
    ps.push(clause.expect ? outcome.success.probability : 1 - outcome.success.probability);
  }
  const p = decomposition.combine === "any" ? Math.max(...ps) : combine === "min" ? Math.min(...ps) : ps.reduce((a, b) => a * b, 1);
  lastParts = ps;
  return p;
});

/** アプリが書いた行だけ。title・brief・body を含めない */
export const metadataInputOf = (task: TaskDossier) => {
  const full = structuredInputOf(task);
  return { task: { trusted: full.task.trusted }, facts: full.facts.map(({ body: _body, ...rest }) => rest) };
};
