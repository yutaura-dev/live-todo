import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { AiSettings, initialSettings } from "../domain/ai-settings/ai-settings.js";
import { StoreDatabase } from "./database.js";
import { aiSettings } from "./schema.js";

const ROW_ID = 1;
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(AiSettings));

export class AiSettingsStore extends Context.Service<AiSettingsStore, { load(): Effect.Effect<AiSettings>; save(settings: AiSettings): Effect.Effect<void> }>()(
  "live-todo/store/AiSettingsStore",
) {
  static readonly layer = Layer.effect(
    AiSettingsStore,
    Effect.gen(function* () {
      const db = yield* StoreDatabase;
      // 読めない設定は、初めからやり直してもらう（キーは持たないので、選び直すだけで済む）
      const load = () =>
        db
          .select()
          .from(aiSettings)
          .where(eq(aiSettings.id, ROW_ID))
          .pipe(
            Effect.orDie,
            Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(initialSettings) : decode(row.settings).pipe(Effect.orElseSucceed(() => initialSettings)))),
          );
      const save = (settings: AiSettings) => {
        const row = { id: ROW_ID, settings: JSON.stringify(settings) };
        return db.insert(aiSettings).values(row).onConflictDoUpdate({ target: aiSettings.id, set: row }).pipe(Effect.asVoid, Effect.orDie);
      };
      return AiSettingsStore.of({ load, save });
    }),
  );
}
