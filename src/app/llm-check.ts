import { Effect, Option, Predicate, Schema } from "effect";
import type { LlmProfile } from "./config/app-config.js";
import { makeDecisionsProvider, makeMailClassifier, makeStructuredClassifier } from "./llm.js";

export type CheckResult = { name: string; ok: boolean; detail: string };

// 実データでなく決まった文面で確かめる理由: 確かめるだけのために、Source から取った本文を LLM に送らないため
const SAMPLE_TODO = {
  input: "Pull Request #12「README の誤字を直す」: レビュアーにあなたが指定されました。レビューをお願いします。",
  question: "この通知は、ユーザー本人が何らかの対応をする必要があるものか",
};
const SAMPLE_MAIL = { input: "差出人: 佐藤 花子 <sato@example.com>\n件名: 来週の打ち合わせ\n\n来週の打ち合わせの候補日を教えてください。", context: "" };

class DecisionsRefusedError extends Schema.TaggedError<DecisionsRefusedError>()("DecisionsRefusedError", {}) {}

const secretEnvNameOf = (key: string) => `LIVE_TODO_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

const describeError = (error: unknown): string => {
  if (!Predicate.hasProperty(error, "_tag")) return String(error);
  switch (error._tag) {
    case "MissingSecretError":
      return Predicate.hasProperty(error, "key") && Predicate.isString(error.key)
        ? `API キーがない（.env.local に ${secretEnvNameOf(error.key)} を書く）`
        : "API キーがない";
    case "MissingAzureEndpointError":
      return "LLM Profile に azure.endpoint がない";
    case "DecisionsRefusedError":
      return "API には届いたが、答えが返らなかった（refusal）";
    case "UnsupportedLlmProviderError":
      return `まだ対応していない provider: ${Predicate.hasProperty(error, "provider") ? String(error.provider) : "?"}`;
    default:
      return Predicate.hasProperty(error, "message") ? `${String(error._tag)}: ${String(error.message)}` : String(error._tag);
  }
};

const check = <R>(name: string, effect: Effect.Effect<string, unknown, R>) =>
  effect.pipe(
    Effect.match({
      onSuccess: (detail): CheckResult => ({ name, ok: true, detail }),
      onFailure: (error): CheckResult => ({ name, ok: false, detail: describeError(error) }),
    }),
  );

/** LLM Profile で、判定に使う経路を 1 回ずつ呼んで確かめる。失敗しても止めず、項目ごとの結果を返す */
export const checkLlmProfile = Effect.fnUntraced(function* (profile: LlmProfile) {
  const results: CheckResult[] = [];

  results.push(
    yield* check(
      "判定（structured output）",
      Effect.gen(function* () {
        const classifier = yield* makeStructuredClassifier(profile);
        const answer = yield* classifier.classifyTodo(SAMPLE_TODO);
        // 読めない答えも要確認の値として成功するので、中身を見せて読めたかを分かるようにする
        return `返答: ${JSON.stringify(answer)}`;
      }),
    ),
  );
  if (profile.decisions === undefined) return results;

  results.push(
    yield* check(
      "todo の確率（Decisions）",
      Effect.gen(function* () {
        const provider = yield* makeDecisionsProvider(profile);
        if (Option.isNone(provider)) return "decisions がないので呼ばなかった";
        const answer = yield* provider.value.judgePredicate(SAMPLE_TODO);
        if (answer.type === "refusal") return yield* new DecisionsRefusedError();
        return `確率 ${answer.probability.toFixed(2)}`;
      }),
    ),
  );
  results.push(
    yield* check(
      "メールの仕分け（Decisions）",
      Effect.gen(function* () {
        const classifier = yield* makeMailClassifier(profile);
        const answer = yield* classifier.classify(SAMPLE_MAIL);
        return `${answer.kind}（${answer.method}${answer.probability === undefined ? "" : ` / 確率 ${answer.probability.toFixed(2)}`}）`;
      }),
    ),
  );
  return results;
});
