import { Option } from "effect";
import type { ActivityKind, ItemSnapshot } from "./source-item.js";

export function detectActivities(previous: Option.Option<ItemSnapshot>, next: ItemSnapshot): ActivityKind[] {
  if (Option.isNone(previous)) return ["appeared"];
  const before = previous.value;
  const activities: ActivityKind[] = [];

  if (next.state !== "removed" && before.fingerprint !== next.fingerprint) {
    activities.push("changed");
  }
  if (before.state !== next.state) {
    activities.push(next.state === "open" ? "reopened" : next.state);
  }
  return activities;
}
