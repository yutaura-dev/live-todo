import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { SpikeModels } from "../llm.js";
import { conditionProbabilityV1, conditionProbabilityV2, conditionProbabilityV3 } from "../rule-condition.js";
import { cases as tuningCases } from "./rule-condition.cases.js";
import { holdout } from "./rule-condition.holdout.js";
import { finalCases } from "./rule-condition.final.js";

const ruleConditionCases = process.argv[4] === "holdout" ? holdout : process.argv[4] === "final" ? finalCases : tuningCases;
import { decompose, decomposedProbability, type Decomposition, lastParts } from "../rule-decompose.js";

const THRESHOLD = 0.8;
const parts = new Map<string, number[]>();

const VARIANTS = { v1: conditionProbabilityV1, v2: conditionProbabilityV2, v3: conditionProbabilityV3 } as const;
const variant = process.argv[3] ?? "v3";

const decomposed = (combine: "product" | "min") =>
  Effect.gen(function* () {
    const cache = new Map<string, Decomposition>();
    for (const condition of new Set(ruleConditionCases.map((c) => c.condition))) {
      const d = yield* decompose(condition);
      cache.set(condition, d);
      console.log(`# ${condition}\n  ${d.combine}: ${d.clauses.map((c) => `${c.question} → ${c.expect ? "はい" : "いいえ"}`).join(" / ")}`);
    }
    return (condition: string, task: (typeof ruleConditionCases)[number]["task"]) =>
      decomposedProbability(cache.get(condition)!, task, combine).pipe(Effect.tap(() => Effect.sync(() => parts.set(task.id, [...lastParts]))));
  });

const ruleCondition = Effect.gen(function* () {
  const conditionProbability = variant === "d-product" ? yield* decomposed("product") : variant === "d-min" ? yield* decomposed("min") : VARIANTS[variant as keyof typeof VARIANTS];
  const rows = yield* Effect.forEach(
    ruleConditionCases,
    (c) =>
      conditionProbability(c.condition, c.task).pipe(
        Effect.map((p) => ({ ...c, p })),
        Effect.catch((error) => Effect.succeed({ ...c, p: undefined as number | undefined, error: String(error) })),
      ),
    { concurrency: variant.startsWith("d-") ? 1 : 4 },
  );
  let tp = 0, fp = 0, fn = 0, tn = 0, none = 0;
  for (const row of rows) {
    const applied = row.p !== undefined && row.p >= THRESHOLD;
    if (row.p === undefined) none++;
    if (applied && row.expected) tp++;
    else if (applied && !row.expected) fp++;
    else if (!applied && row.expected) fn++;
    else tn++;
    const mark = applied === row.expected ? "✓" : applied ? "✗ 誤って当てた" : "✗ 当て損ねた";
    console.log(`${mark.padEnd(10)} p=${row.p === undefined ? " -  " : row.p.toFixed(2)}  ${row.id}${row.note === undefined ? "" : `（${row.note}）`}${applied === row.expected || !parts.has(row.task.id) ? "" : `  [${parts.get(row.task.id)!.map((x) => x.toFixed(2)).join(", ")}]`}`);
  }
  console.log(JSON.stringify({ variant, threshold: THRESHOLD, n: rows.length, tp, fp, fn, tn, unanswered: none, precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn) }));
});

import { interpret, readingOf } from "../rule-interpret.js";
import { interpretCases } from "./rule-interpret.cases.js";

const ruleInterpret = Effect.gen(function* () {
  const split = process.argv[3] ?? "tuning";
  const targets = interpretCases.filter((c) => (c.split ?? "tuning") === split);
  const rows = yield* Effect.forEach(targets, (c) => interpret(c.then).pipe(Effect.map((i) => ({ c, i, r: readingOf(i) }))), { concurrency: 4 });
  let correct = 0;
  let unsafe = 0;
  for (const { c, i, r } of rows) {
    const same = JSON.stringify(r) === JSON.stringify(c.expected);
    if (same) correct++;
    // 保存させないはずのもの（条件入り・できない操作）を保存できてしまうのが、いちばん困る間違い
    if (!c.expected.ok && r.ok) unsafe++;
    const f = (p: number | undefined) => (p === undefined ? " - " : p.toFixed(2));
    console.log(`${same ? "✓" : !c.expected.ok && r.ok ? "✗ 保存できてしまう" : "✗"}  ${c.id.padEnd(12)} ${JSON.stringify(r)}  [task=${i.taskAction?.label}:${f(i.taskAction?.probability)} cond=${f(i.hasCondition)} read=${f(i.markRead)} arch=${f(i.archive)} label=${f(i.addLabel)} unsup=${f(i.unsupported)}]  ${c.then}`);
  }
  console.log(JSON.stringify({ split, n: rows.length, correct, unsafe }));
});

import { attribute } from "../attribute.js";
import { aiEligible, candidatesFor, linkByIdentifier } from "../candidates.js";
import { attributionCases as tuningAttribution, world as tuningWorld } from "./attribution.cases.js";
import { finalAttributionCases, finalWorld } from "./attribution.final.js";

const attributionCases = process.argv[3] === "final" ? finalAttributionCases : tuningAttribution;
const world = process.argv[3] === "final" ? finalWorld : tuningWorld;

// 既存の Task に紐づける（間違えると別の Task に混ざる）より、どの Task でもないと決める（間違えても新しい Task ができるだけ）ほうを緩くする
const ATTACH = 0.8;
const NONE = 0.6;

const attribution = Effect.gen(function* () {
  const rows = yield* Effect.forEach(
    attributionCases,
    (c) =>
      Effect.gen(function* () {
        const byId = linkByIdentifier(c.fact, world);
        if (byId !== undefined) return { c, decided: byId.id as string | null, how: "identifier", p: 1, candidates: [] as string[], role: undefined as string | undefined };
        const candidates = candidatesFor(c.fact, aiEligible(c.fact, world));
        const a = yield* attribute(c.fact, candidates);
        // 確かなものだけ紐づける / どの Task でもないと決める。迷うものは要確認（undefined）
        const decided = a.probability === undefined ? undefined : a.taskId === undefined ? (a.probability >= NONE ? null : undefined) : a.probability >= ATTACH ? a.taskId : undefined;
        return { c, decided, how: `ai:${a.top ?? "-"}`, p: a.probability, candidates: candidates.map((t) => t.id), role: a.role };
      }),
    { concurrency: 4 },
  );
  let right = 0, wrongAttach = 0, missed = 0, review = 0;
  for (const r of rows) {
    const ok = r.decided === r.c.expected;
    if (ok) right++;
    else if (r.decided === undefined) review++;
    else if (r.decided !== null) wrongAttach++;
    else missed++;
    const mark = ok ? "✓" : r.decided === undefined ? "? 要確認" : r.decided !== null ? "✗ 誤って紐づけ" : "✗ 取りこぼし";
    console.log(`${mark.padEnd(10)} ${r.c.id.padEnd(7)} 正解=${String(r.c.expected).padEnd(10)} 判定=${String(r.decided).padEnd(10)} ${r.how} p=${r.p?.toFixed(2)} role=${r.role ?? "-"} 候補=[${r.candidates.join(",")}] ${r.c.note ?? ""}`);
  }
  console.log(JSON.stringify({ n: rows.length, right, wrongAttach, missed, review }));
});

const target = process.argv[2];
const program = target === "rule-condition" ? ruleCondition : target === "rule-interpret" ? ruleInterpret : target === "attribution" ? attribution : Effect.die(`unknown bench: ${target}`);
NodeRuntime.runMain(program.pipe(Effect.provide(SpikeModels)));
