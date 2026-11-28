import { Context, Effect, Layer, Option, Ref } from "effect";
import type { AiUse } from "../../../domain/ai-settings/ai-settings.js";
import { Decisions } from "../../../llm/decision/decisions.js";
import { Generation } from "../../../llm/generation/generation.js";
import type { AiUnreachableError } from "../../../llm/shared/errors.js";
import type { Connected } from "./connector.js";

type State = { connected: Partial<Record<AiUse, Connected>>; active: boolean; onAuthFailure: (error: AiUnreachableError) => Effect.Effect<void> };

/**
 * 今つながっている AI。呼ぶ側は呼ぶたびにここから取る（設定を選び直したら、すぐ次の呼び出しから変わるように）。
 * AI 設定が使えるときだけ渡し、それまでは none（3 つとも揃うまで AI を呼ばない。ai-settings.spec）。
 */
export class AiServices extends Context.Service<
  AiServices,
  {
    readonly decisions: Effect.Effect<Option.Option<Decisions["Service"]>>;
    readonly generation: Effect.Effect<Option.Option<Generation["Service"]>>;
    install(use: AiUse, connected: Connected): Effect.Effect<void>;
    setActive(active: boolean): Effect.Effect<void>;
    onAuthFailure(handler: (error: AiUnreachableError) => Effect.Effect<void>): Effect.Effect<void>;
    /** AI に届かなかったことを知らせる。認証が通らなかったときだけ、AI 設定を使えないにする */
    reportUnreachable(error: AiUnreachableError): Effect.Effect<void>;
  }
>()("live-todo/desktop/AiServices") {
  static readonly live = Layer.effect(
    AiServices,
    Effect.gen(function* () {
      const state = yield* Ref.make<State>({ connected: {}, active: false, onAuthFailure: () => Effect.void });
      const reportUnreachable = (error: AiUnreachableError) =>
        error.reason === "Authentication" ? Effect.flatMap(Ref.get(state), (s) => s.onAuthFailure(error)) : Effect.void;
      const decisions = Effect.map(Ref.get(state), (s) => {
        const inner = s.active ? s.connected.decisions?.decisions : undefined;
        if (inner === undefined) return Option.none();
        // 呼んだら認証が通らなかったことに気づけるよう、失敗を見てから返す
        return Option.some(Decisions.of({ ask: (question, input) => inner.ask(question, input).pipe(Effect.tapError(reportUnreachable)) }));
      });
      const generation = Effect.map(Ref.get(state), (s) => {
        const inner = s.active ? s.connected.generation?.generation : undefined;
        if (inner === undefined) return Option.none();
        return Option.some(Generation.of({ write: (writing, input) => inner.write(writing, input).pipe(Effect.tapError(reportUnreachable)) }));
      });
      return AiServices.of({
        decisions,
        generation,
        install: (use, connected) => Ref.update(state, (s) => ({ ...s, connected: { ...s.connected, [use]: connected } })),
        setActive: (active) => Ref.update(state, (s) => ({ ...s, active })),
        onAuthFailure: (handler) => Ref.update(state, (s) => ({ ...s, onAuthFailure: handler })),
        reportUnreachable,
      });
    }),
  );

  /** テスト用。環境にある Decisions・Generation（なければ none）を、いつも使えるものとして渡す */
  static readonly fromContext = Layer.effect(
    AiServices,
    Effect.gen(function* () {
      const decisions = yield* Effect.serviceOption(Decisions);
      const generation = yield* Effect.serviceOption(Generation);
      return AiServices.of({
        decisions: Effect.succeed(decisions),
        generation: Effect.succeed(generation),
        install: () => Effect.void,
        setActive: () => Effect.void,
        onAuthFailure: () => Effect.void,
        reportUnreachable: () => Effect.void,
      });
    }),
  );
}
