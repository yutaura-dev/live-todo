import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { factBelongsToTaskQuestion } from "../../../llm/decision/questions/index.js";
import { decisionsTest, probability } from "../../../llm/decision/test-double.js";
import { Decisions } from "../../../llm/decision/decisions.js";
import { AiUnreachableError } from "../../../llm/shared/errors.js";
import { StoreDatabase } from "../../../store/database.js";
import { AiSettingsStore } from "../../../store/ai-settings-store.js";
import { AiSettingsService } from "./ai-settings-service.js";
import { AiConnector, type Connected } from "./connector.js";
import { AiServices } from "./ai-services.js";

const fakeDecisions = decisionsTest({ [factBelongsToTaskQuestion.purpose]: () => ({ belongs: probability(0.9) }) });

/** つなぐ口の差し替え。checks に書いた使い道だけ通る */
const fakeConnector = (failing: ReadonlySet<string> = new Set()) =>
  Layer.effect(
    AiConnector,
    Effect.gen(function* () {
      const decisions = yield* Decisions;
      return AiConnector.of({
        connect: (use) =>
          failing.has(use)
            ? Effect.succeed({ ok: false, message: "LIVE_TODO_SECRET_LLM_OPENAI_API_KEY を .env.local に書いてください" } as const)
            : Effect.succeed({ ok: true, connected: (use === "decisions" ? { decisions } : {}) as Connected } as const),
      });
    }),
  ).pipe(Layer.provide(fakeDecisions.layer));

const layerWith = (failing?: ReadonlySet<string>) =>
  AiSettingsService.layer.pipe(
    Layer.provideMerge(AiServices.live),
    Layer.provide(fakeConnector(failing)),
    Layer.provide(AiSettingsStore.layer.pipe(Layer.provide(StoreDatabase.layer({ filename: ":memory:" })))),
  );

const configureAll = Effect.gen(function* () {
  const service = yield* AiSettingsService;
  yield* service.configure("decisions", "openai-decisions");
  yield* service.configure("generation", "claude-sonnet");
  return yield* service.configure("agent", "claude-code");
});

describe("AiSettingsService（AI 設定を確かめて保存し、使える AI をつなぐ）", () => {
  it.effect("初めは初期設定中で、使い道ごとに選べる AI の一覧を返す", () =>
    Effect.gen(function* () {
      const view = yield* (yield* AiSettingsService).view();
      assert.strictEqual(view.status, "初期設定中");
      assert.deepStrictEqual(view.uses.decisions.options.map((option) => option.id), ["openai-decisions"]);
      assert.strictEqual(view.uses.decisions.selected, null);
    }).pipe(Effect.provide(layerWith())));

  it.effect("3 つとも確かめて通ったら使えるにし、Decisions をつなぐ", () =>
    Effect.gen(function* () {
      const reply = yield* configureAll;
      assert.deepStrictEqual(reply.ok ? reply.value.status : reply, "使える");
      assert.isTrue(Option.isSome(yield* (yield* AiServices).decisions));
    }).pipe(Effect.provide(layerWith())));

  it.effect("確かめて通らなければ設定せず、何をすればよいかを返す", () =>
    Effect.gen(function* () {
      const reply = yield* (yield* AiSettingsService).configure("decisions", "openai-decisions");
      assert.deepStrictEqual(reply, { ok: false, reason: "LIVE_TODO_SECRET_LLM_OPENAI_API_KEY を .env.local に書いてください" });
      assert.strictEqual((yield* (yield* AiSettingsService).view()).uses.decisions.selected, null);
    }).pipe(Effect.provide(layerWith(new Set(["decisions"])))));

  it.effect("一覧にない AI は選べない", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* (yield* AiSettingsService).configure("decisions", "unknown"), { ok: false, reason: "選べない AI です" });
    }).pipe(Effect.provide(layerWith())));

  it.effect("使えるようになるまでは、AI を呼ばない（3 つとも揃うまで Decisions を渡さない）", () =>
    Effect.gen(function* () {
      yield* (yield* AiSettingsService).configure("decisions", "openai-decisions");
      assert.isTrue(Option.isNone(yield* (yield* AiServices).decisions));
    }).pipe(Effect.provide(layerWith())));

  it.effect("呼んだときに認証が通らなかったら、使えないにして AI を外す（直すまでアプリを止める）", () =>
    Effect.gen(function* () {
      yield* configureAll;
      yield* (yield* AiServices).reportUnreachable(new AiUnreachableError({ role: "Decisions", purpose: "x", reason: "Authentication" }));
      const view = yield* (yield* AiSettingsService).view();
      assert.deepStrictEqual({ status: view.status, problem: view.problem }, { status: "使えない", problem: { use: "Decisions", reason: "API キーが切れた" } });
      assert.isTrue(Option.isNone(yield* (yield* AiServices).decisions));
    }).pipe(Effect.provide(layerWith())));

  it.effect("通信できなかっただけなら、使えないにはしない（次にやり直す）", () =>
    Effect.gen(function* () {
      yield* configureAll;
      yield* (yield* AiServices).reportUnreachable(new AiUnreachableError({ role: "Decisions", purpose: "x", reason: "Network" }));
      assert.strictEqual((yield* (yield* AiSettingsService).view()).status, "使える");
    }).pipe(Effect.provide(layerWith())));
});
