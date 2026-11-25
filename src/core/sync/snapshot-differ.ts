import { Effect, Schema } from "effect";
import type { SourceChange } from "./source-change.js";

export class DuplicateExternalIdError extends Schema.TaggedError<DuplicateExternalIdError>()("DuplicateExternalIdError", {
  externalId: Schema.String,
}) {}

export type ItemIdentity = { externalId: string; fingerprint: string };

export type SnapshotDiff<TItem> = {
  changes: SourceChange<TItem>[];
  nextFingerprints: Map<string, string>;
};

export const diffSnapshot = Effect.fnUntraced(function* <TItem>(
  previousFingerprints: ReadonlyMap<string, string>,
  currentItems: readonly TItem[],
  identify: (item: TItem) => ItemIdentity,
): Effect.fn.Return<SnapshotDiff<TItem>, DuplicateExternalIdError> {
  const changes: SourceChange<TItem>[] = [];
  const nextFingerprints = new Map<string, string>();

  for (const item of currentItems) {
    const { externalId, fingerprint } = identify(item);
    if (nextFingerprints.has(externalId)) {
      return yield* new DuplicateExternalIdError({ externalId });
    }
    nextFingerprints.set(externalId, fingerprint);

    if (previousFingerprints.get(externalId) !== fingerprint) {
      changes.push({ kind: "upserted", item });
    }
  }

  for (const externalId of previousFingerprints.keys()) {
    if (!nextFingerprints.has(externalId)) {
      changes.push({ kind: "removed", externalId });
    }
  }

  return { changes, nextFingerprints };
});
