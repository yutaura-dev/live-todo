import { Context, Effect, Layer } from "effect";
import { type AiSettings, type AiUse, configure, reject } from "../../../domain/ai-settings/ai-settings.js";
import { AiSettingsStore } from "../../../store/ai-settings-store.js";
import type { AiSettingsView, Reply } from "../../shared/api.js";
import { AiServices } from "./ai-services.js";
import { AI_OPTIONS, optionFor, optionOf } from "./catalog.js";
import { AiConnector } from "./connector.js";

const USES: ReadonlyArray<AiUse> = ["decisions", "generation", "agent"];
const ROLE_OF = { Decisions: "decisions", Generation: "generation", Agent: "agent" } as const;

const useView = (settings: AiSettings, use: AiUse) => ({
  selected: optionFor(use, settings.uses[use])?.id ?? null,
  options: AI_OPTIONS[use].map(({ id, label, secret }) => ({ id, label, secret })),
});

const viewOf = (settings: AiSettings): AiSettingsView => ({
  status: settings.status,
  problem: settings.problem,
  uses: { decisions: useView(settings, "decisions"), generation: useView(settings, "generation"), agent: useView(settings, "agent") },
});

/** AI 設定を見せ、選んだ AI を確かめて保存し、使えるようになったら AI をつなぐ */
export class AiSettingsService extends Context.Service<
  AiSettingsService,
  { view(): Effect.Effect<AiSettingsView>; configure(use: AiUse, optionId: string): Effect.Effect<Reply<AiSettingsView>> }
>()("live-todo/desktop/AiSettingsService") {
  static readonly layer = Layer.effect(
    AiSettingsService,
    Effect.gen(function* () {
      const store = yield* AiSettingsStore;
      const connector = yield* AiConnector;
      const ai = yield* AiServices;

      // 起動したときは、保存した選択につなぐだけ（毎回確かめると、そのたびに API を呼ぶため）。認証が切れていれば、呼んだときに気づく
      const saved = yield* store.load();
      for (const use of USES) {
        const choice = saved.uses[use];
        if (choice === null) continue;
        const result = yield* connector.connect(use, choice, { verify: false });
        if (result.ok) yield* ai.install(use, result.connected);
      }
      yield* ai.setActive(saved.status === "使える");

      yield* ai.onAuthFailure((error) =>
        Effect.gen(function* () {
          const current = yield* store.load();
          const use = error.role;
          const next = yield* reject(current, { kind: "app" }, { use, reason: "API キーが切れた" }).pipe(Effect.orElseSucceed(() => current));
          yield* store.save(next);
          yield* ai.setActive(next.status === "使える");
          yield* Effect.logWarning("AI の認証が通らないので、AI 設定を使えないにした").pipe(Effect.annotateLogs({ use: ROLE_OF[use] }));
        }),
      );

      const configureUse = (use: AiUse, optionId: string) =>
        Effect.gen(function* () {
          const option = optionOf(use, optionId);
          if (option === undefined) return { ok: false, reason: "選べない AI です" } as const;
          const result = yield* connector.connect(use, option.choice, { verify: true });
          if (!result.ok) return { ok: false, reason: result.message } as const;
          const next = yield* configure(yield* store.load(), { kind: "user" }, use, option.choice, "通った").pipe(Effect.orDie);
          yield* store.save(next);
          yield* ai.install(use, result.connected);
          yield* ai.setActive(next.status === "使える");
          return { ok: true, value: viewOf(next) } as const;
        });

      return AiSettingsService.of({ view: () => Effect.map(store.load(), viewOf), configure: configureUse });
    }),
  );
}
