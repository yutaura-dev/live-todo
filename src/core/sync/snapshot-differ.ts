import type { SourceChange } from "./source-change.js";

export type ItemIdentity = { externalId: string; fingerprint: string };

export type SnapshotDiff<TItem> = {
  changes: SourceChange<TItem>[];
  nextFingerprints: Map<string, string>;
};

export function diffSnapshot<TItem>(
  previousFingerprints: ReadonlyMap<string, string>,
  currentItems: readonly TItem[],
  identify: (item: TItem) => ItemIdentity,
): SnapshotDiff<TItem> {
  const changes: SourceChange<TItem>[] = [];
  const nextFingerprints = new Map<string, string>();

  for (const item of currentItems) {
    const { externalId, fingerprint } = identify(item);
    if (nextFingerprints.has(externalId)) {
      throw new Error(`externalId が重複しています: ${externalId}`);
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
}
