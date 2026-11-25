import type { Effect } from "effect";
import type { SourceChange } from "./source-change.js";

export type FetchChangesResult<TItem, TCursor> = {
  changes: SourceChange<TItem>[];
  nextCursor: TCursor;
};

export interface SourceAdapter<TItem, TCursor, E> {
  fetchChanges(cursor: TCursor | null): Effect.Effect<FetchChangesResult<TItem, TCursor>, E>;
}
