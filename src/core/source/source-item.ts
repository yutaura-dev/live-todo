export const ITEM_STATES = ["open", "resolved", "removed"] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export const ACTIVITY_KINDS = ["appeared", "changed", "resolved", "reopened", "removed"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ITEM_TRIAGES = ["pending", "linked", "ignored"] as const;
export type ItemTriage = (typeof ITEM_TRIAGES)[number];

export type ItemSnapshot = { state: ItemState; fingerprint: string };
