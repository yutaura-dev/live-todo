import { DateTime, Effect, Schema } from "effect";
import { guard } from "../denied.js";

// specs/task-proposal.spec.ts の TaskProposal（計画の案は、計画の縦の一本で足す）

export const ProposalKind = Schema.Literals(["新しい Task", "既存の Task に足す", "切り出す"]);
export type ProposalKind = typeof ProposalKind.Type;

export const TaskProposal = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["提案中", "受け入れた", "見送った", "取り下げた"]),
  kind: ProposalKind,
  title: Schema.String,
  brief: Schema.String,
  targetTaskId: Schema.NullOr(Schema.String),
  sourceItemIds: Schema.Array(Schema.String),
  judgment: Schema.String,
  createdAt: Schema.String,
});
export type TaskProposal = typeof TaskProposal.Type;

export type ProposalActor = { readonly kind: "agent" } | { readonly kind: "user" };

export const propose = Effect.fn("TaskProposal.propose")(function* (
  input: { id: string; kind: ProposalKind; title: string; brief: string; targetTaskId: string | null; sourceItemId: string; judgment: string },
  actor: ProposalActor,
) {
  yield* guard("task-proposal", "initial")(actor.kind === "agent", "AI だけ");
  const proposal: TaskProposal = {
    id: input.id,
    status: "提案中",
    kind: input.kind,
    title: input.title,
    brief: input.brief,
    targetTaskId: input.targetTaskId,
    sourceItemIds: [input.sourceItemId],
    judgment: input.judgment,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  };
  return proposal;
});

export const addFact = Effect.fn("TaskProposal.addFact")(function* (proposal: TaskProposal, actor: ProposalActor, sourceItemId: string, judgment: string) {
  const ensure = guard("task-proposal", "addFact");
  yield* ensure(actor.kind === "agent", "AI だけ");
  yield* ensure(proposal.status === "提案中", "提案中のときだけ");
  const ids = proposal.sourceItemIds.includes(sourceItemId) ? proposal.sourceItemIds : [...proposal.sourceItemIds, sourceItemId];
  return { ...proposal, sourceItemIds: ids, judgment };
});

export const autoAccept = Effect.fn("TaskProposal.autoAccept")(function* (proposal: TaskProposal, actor: ProposalActor, confidence: "閾値を超えた" | "閾値に届かない") {
  const ensure = guard("task-proposal", "autoAccept");
  yield* ensure(actor.kind === "agent", "AI だけ");
  yield* ensure(proposal.status === "提案中", "提案中のときだけ");
  yield* ensure(proposal.kind !== "切り出す", "切り出すかは、ユーザーが決める");
  yield* ensure(confidence === "閾値を超えた", "判定し直した確率が、自動の閾値を超えたときだけ");
  return { ...proposal, status: "受け入れた" as const };
});

export const accept = Effect.fn("TaskProposal.accept")(function* (proposal: TaskProposal, actor: ProposalActor) {
  const ensure = guard("task-proposal", "accept");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(proposal.status === "提案中", "提案中のときだけ");
  return { ...proposal, status: "受け入れた" as const };
});

export const decline = Effect.fn("TaskProposal.decline")(function* (proposal: TaskProposal, actor: ProposalActor) {
  const ensure = guard("task-proposal", "decline");
  yield* ensure(actor.kind === "user", "ユーザーだけ");
  yield* ensure(proposal.status === "提案中", "提案中のときだけ");
  return { ...proposal, status: "見送った" as const };
});

export const repropose = Effect.fn("TaskProposal.repropose")(function* (proposal: TaskProposal, actor: ProposalActor) {
  const ensure = guard("task-proposal", "repropose");
  yield* ensure(actor.kind === "agent", "AI だけ");
  yield* ensure(proposal.status === "見送った", "見送ったときだけ");
  return { ...proposal, status: "提案中" as const };
});

export const withdraw = Effect.fn("TaskProposal.withdraw")(function* (proposal: TaskProposal, actor: ProposalActor) {
  const ensure = guard("task-proposal", "withdraw");
  yield* ensure(actor.kind === "agent", "AI だけ");
  yield* ensure(proposal.status === "提案中" || proposal.status === "見送った", "提案中か見送ったときだけ");
  return { ...proposal, status: "取り下げた" as const };
});
