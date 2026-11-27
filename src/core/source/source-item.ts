export const ITEM_STATES = ["open", "resolved", "removed"] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export const ACTIVITY_KINDS = ["appeared", "changed", "resolved", "reopened", "removed"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ITEM_TRIAGES = ["pending", "linked", "ignored"] as const;
export type ItemTriage = (typeof ITEM_TRIAGES)[number];

export type ItemSnapshot = { state: ItemState; fingerprint: string };

/**
 * Source Item が表す事実（ADR-0019）。trusted はアプリが API の値から書いた行、body は外の人が書いた文字列。
 * ルールの判定や振り分けで、本文に書かれた偽の行をアプリの情報と取り違えないよう、2 つを分けて持つ
 */
export type ItemFact = { trusted: ReadonlyArray<string>; body: string };
