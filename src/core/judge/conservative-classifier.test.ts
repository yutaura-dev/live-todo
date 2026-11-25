import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { ConservativeClassifier } from "./conservative-classifier.js";
import { StructuredClassifier } from "./todo-judge.js";

describe("ConservativeClassifier", () => {
  it.effect("どの入力にも uncertain を返し、規則で決まらないものをすべて要確認に回す", () =>
    Effect.gen(function* () {
      const classifier = yield* StructuredClassifier;

      assert.strictEqual(yield* classifier.classifyTodo({ input: "雑談", question: "対応すべきか？" }), "uncertain");
    }).pipe(Effect.provide(ConservativeClassifier)));
});
