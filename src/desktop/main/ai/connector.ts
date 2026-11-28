import { Context, Effect, Layer } from "effect";
import type { AiUse, Choice } from "../../../domain/ai-settings/ai-settings.js";
import type { Decisions } from "../../../llm/decision/decisions.js";
import type { Generation } from "../../../llm/generation/generation.js";

/** つないだ AI（使い道ごとに、そのサービス。Agent はまだ呼ぶ口がないので持たない） */
export type Connected = { readonly decisions?: Decisions["Service"]; readonly generation?: Generation["Service"] };

export type ConnectResult = { readonly ok: true; readonly connected: Connected } | { readonly ok: false; readonly message: string };

/**
 * AI につなぐ口。verify なら、実際に小さく呼んで認証を確かめる（設定を保存するときは確かめ、起動したときはつなぐだけ）。
 * 実装は connector-live.ts（実 API を呼ぶので、テストでは差し替える）。
 */
export class AiConnector extends Context.Service<AiConnector, { connect(use: AiUse, choice: Choice, options?: { verify: boolean }): Effect.Effect<ConnectResult> }>()(
  "live-todo/desktop/AiConnector",
) {
  /** テスト用。どの AI にもつながない（テストから実 API を呼ばないため） */
  static readonly unavailable = Layer.succeed(AiConnector, AiConnector.of({ connect: () => Effect.succeed({ ok: false, message: "テストでは AI につながない" } as const) }));
}
