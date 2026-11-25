export type SourceChange<TItem> =
  | { kind: "upserted"; item: TItem }
  | { kind: "removed"; externalId: string };
