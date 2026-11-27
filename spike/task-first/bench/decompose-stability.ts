import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { SpikeModels } from "../llm.js";
import { decompose } from "../rule-decompose.js";
import { cases } from "./rule-condition.cases.js";

const program = Effect.gen(function* () {
  for (const condition of new Set(cases.map((c) => c.condition))) {
    console.log(`# ${condition}`);
    for (let i = 0; i < 3; i++) {
      const d = yield* decompose(condition);
      console.log(`  ${d.combine}: ${d.clauses.map((c) => `${c.question} → ${c.expect ? "はい" : "いいえ"}`).join(" / ")}`);
    }
  }
});
NodeRuntime.runMain(program.pipe(Effect.provide(SpikeModels)));
