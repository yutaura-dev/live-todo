import type { SourceChange } from "./source-change.js";

export type FetchChangesResult<TItem, TCursor> = {
  changes: SourceChange<TItem>[];
  nextCursor: TCursor;
};

export interface SourceAdapter<TItem, TCursor> {
  fetchChanges(cursor: TCursor | null): Promise<FetchChangesResult<TItem, TCursor>>;
}
