import { Effect, Layer } from "effect";
import { StructuredClassifier } from "./todo-judge.js";

/**
 * 常に uncertain を返す StructuredClassifier。規則で決まらない項目は、すべて要確認に回る。
 *
 * LLM による判定を入れる前の暫定の実装。not_todo を返さないので、自分の todo を対象外として
 * 捨てることはない（取りこぼしを起こさない）。LLM の料金もかからない。
 */
export const ConservativeClassifier = Layer.succeed(
  StructuredClassifier,
  StructuredClassifier.of({ classifyTodo: () => Effect.succeed("uncertain") }),
);
