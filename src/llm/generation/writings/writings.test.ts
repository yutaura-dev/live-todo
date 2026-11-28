import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { answered, unanswered } from "../../shared/answer.js";
import { Generation } from "../generation.js";
import { generationTest } from "../test-double.js";
import { checkPointDetails, pointDetailsWriting } from "./decision-point.js";
import { allWritings } from "./index.js";
import { PlanDraft } from "./plan.js";
import { extractWorkWriting } from "./routing.js";

describe("書き物の一覧", () => {
  it("書き物の ID はすべて違う", () => {
    const purposes = allWritings.map((writing) => writing.purpose);
    assert.strictEqual(new Set(purposes).size, purposes.length);
  });

  it("どの書き物の出力も、Structured Output に渡す JSON Schema にできる（入れ子の計画も含む）", () => {
    for (const writing of allWritings) assert.doesNotThrow(() => Schema.toJsonSchemaDocument(writing.output), writing.purpose);
  });

  it("Structured Output の名前（objectName）もすべて違う", () => {
    const names = allWritings.map((writing) => writing.objectName);
    assert.strictEqual(new Set(names).size, names.length);
  });
});

describe("計画の下書き", () => {
  it("並び・分かれ道の枝の先の計画・完了したときにすることを、入れ子で書ける", () => {
    const draft = {
      type: "serial",
      items: [
        { type: "item", title: "PR を読む", due: null, completes: false, how: { type: "human", place: null } },
        {
          type: "item",
          title: "merge するか決める",
          due: null,
          completes: false,
          how: {
            type: "decision",
            kind: "選ぶ",
            question: "型エラーがあるが merge するか",
            howToCheck: null,
            options: [
              { label: "そのまま merge する", then: { type: "planned", plan: { type: "serial", items: [{ type: "item", title: "merge する", due: null, completes: true, how: { type: "write", subjectUri: "github://yutaura@github.com/acme/app/pull/42", operation: "github.merge", paramsJson: "{}", trigger: "on_request", placeUri: null } }] } } },
              { label: "ひとまず調査する", then: { type: "planLater", direction: "型エラーの原因を調べる" } },
            ],
          },
        },
        { type: "completionEffect", title: "レビュー依頼のメールをアーカイブする", subjectUri: "gmail://me@example.com/thread/1", operation: "gmail.archive", paramsJson: "{}" },
      ],
    };
    const decoded = Schema.decodeUnknownSync(PlanDraft)(draft);
    assert.strictEqual(decoded.items.length, 3);
  });

  it("手間は持たない（Action Item ごとに Decisions が判定する）", () => {
    const withEffort = { type: "serial", items: [{ type: "item", title: "読む", due: null, completes: true, effort: "easy", how: { type: "human", place: null } }] };
    assert.isFalse("effort" in (Schema.decodeUnknownSync(PlanDraft)(withEffort).items[0] as object));
  });
});

describe("得るもの・失うものの中身", () => {
  const input = {
    question: "merge するか",
    options: [{ label: "merge する", then: "merge する", gains: ["期日" as const], costs: ["確実さ" as const] }],
  };

  it("Decisions が決めた観点と同じ観点に、中身を書いていれば受け取る", () => {
    const output = { options: [{ label: "merge する", gains: [{ aspect: "期日" as const, detail: "今日リリースできる" }], costs: [{ aspect: "確実さ" as const, detail: "本番で壊れるかも" }] }] };
    assert.deepStrictEqual(checkPointDetails(input, answered(output)), answered(output));
  });

  it("観点を足したり落としたりしていたら、形に合わない（Decisions の判定を Generation に書き換えさせない）", () => {
    const output = { options: [{ label: "merge する", gains: [{ aspect: "手間" as const, detail: "楽" }], costs: [{ aspect: "確実さ" as const, detail: "本番で壊れるかも" }] }] };
    assert.deepStrictEqual(checkPointDetails(input, answered(output)), unanswered("Invalid"));
  });

  it("書き物の定義は、選択肢ごとの観点を入力に持つ", () => {
    assert.strictEqual(pointDetailsWriting.purpose, "decision-point.point-details");
  });
});

describe("テスト用の Generation", () => {
  it.effect("書き物の ID ごとに決めた答えを返し、何を頼まれたかを残す", () => {
    const fake = generationTest({ [extractWorkWriting.purpose]: () => answered({ works: [] }) });
    return Effect.gen(function* () {
      const fact = { id: "s1", url: null, source: "gmail", kind: "メール", title: "お知らせ", appLines: [], external: [] };
      const result = yield* (yield* Generation).write(extractWorkWriting, { fact, linkedTasks: [] });
      assert.deepStrictEqual(result.answer, answered({ works: [] }));
      assert.deepStrictEqual(fake.calls.map((call) => call.purpose), [extractWorkWriting.purpose]);
    }).pipe(Effect.provide(fake.layer));
  });
});
