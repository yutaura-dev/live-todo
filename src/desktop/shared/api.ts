import { Schema } from "effect";
import { DueDate } from "../../domain/values.js";
import { TaskActivity } from "../../domain/task/activity.js";
import { Closure, Completion, TaskStatus } from "../../domain/task/task.js";
import { PrioritizationStatus } from "../../domain/priority/prioritization.js";
import { PriorityLevel } from "../../llm/shared/vocabulary.js";

// renderer と main の間でやりとりする形。renderer はこれだけを知り、DB・秘密情報・AI には触れない（ADR-0002）

export const Mark = Schema.Literals(["新着", "更新マーク", "なし"]);

/** 事実の見せ方（本文は出さず、アプリが書いた行だけ） */
export const FactView = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  lines: Schema.Array(Schema.String),
  present: Schema.Boolean,
});
export type FactView = typeof FactView.Type;

/** 計画の 1 行（木を、字下げ付きの行の並びにして見せる） */
export const PlanRow = Schema.Struct({
  kind: Schema.Literals(["item", "decision", "branch", "group"]),
  id: Schema.String,
  title: Schema.String,
  depth: Schema.Number,
  turn: Schema.NullOr(Schema.Literals(["番が来ている", "番待ち", "済んだ", "やらない"])),
  completes: Schema.Boolean,
  how: Schema.NullOr(Schema.Literals(["human", "claude", "condition", "write", "decision"])),
  options: Schema.Array(Schema.String),
  chosen: Schema.NullOr(Schema.Number),
  added: Schema.Boolean,
});
export type PlanRow = typeof PlanRow.Type;

/** 見せる優先度（いまのラベルと、どう決まったか。まだ決め始めていなければ status は未判定） */
export const PriorityView = Schema.Struct({ status: PrioritizationStatus, level: Schema.NullOr(PriorityLevel), reason: Schema.NullOr(Schema.String) });
export type PriorityView = typeof PriorityView.Type;

export const BoardCard = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: TaskStatus,
  mark: Mark,
  due: Schema.NullOr(Schema.String),
  blocksOthers: Schema.Boolean,
  priority: PriorityView,
  sources: Schema.Array(Schema.String),
});
export type BoardCard = typeof BoardCard.Type;

export const TaskView = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  brief: Schema.NullOr(Schema.String),
  status: TaskStatus,
  completion: Completion,
  closure: Schema.NullOr(Closure),
  due: Schema.NullOr(DueDate),
  mark: Mark,
  priority: PriorityView,
  facts: Schema.Array(FactView),
  plan: Schema.NullOr(Schema.Array(PlanRow)),
  history: Schema.Array(TaskActivity),
  createdAt: Schema.String,
});
export type TaskView = typeof TaskView.Type;

const Id = Schema.String.check(Schema.isNonEmpty());

/** 画面からの操作。どれも「ユーザーが」行う（renderer は登場人物を選べない） */
export const Command = Schema.Union([
  Schema.TaggedStruct("CreateTask", { title: Schema.String, brief: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("CompleteTask", { id: Id }),
  Schema.TaggedStruct("DismissTask", { id: Id }),
  Schema.TaggedStruct("ReopenTask", { id: Id }),
  Schema.TaggedStruct("SetDue", { id: Id, due: Schema.NullOr(DueDate) }),
  Schema.TaggedStruct("DefineCompletion", { id: Id }),
  Schema.TaggedStruct("ViewTask", { id: Id }),
  Schema.TaggedStruct("SetPriority", { id: Id, level: PriorityLevel }),
  Schema.TaggedStruct("ClearPriority", { id: Id }),
  Schema.TaggedStruct("RevisePlan", { id: Id }),
  Schema.TaggedStruct("PlanAction", {
    id: Id,
    action: Schema.Union([
      Schema.TaggedStruct("CompleteItem", { itemId: Id }),
      Schema.TaggedStruct("ReopenItem", { itemId: Id }),
      Schema.TaggedStruct("SkipItem", { itemId: Id }),
      Schema.TaggedStruct("ChooseOption", { itemId: Id, option: Schema.Number }),
    ]),
  }),
]);
export type Command = typeof Command.Type;

export const Query = Schema.Union([Schema.TaggedStruct("Board", {}), Schema.TaggedStruct("Task", { id: Id }), Schema.TaggedStruct("AiSettings", {})]);
export type Query = typeof Query.Type;



export const ProposalView = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["提案中", "見送った"]),
  kind: Schema.Literals(["新しい Task", "既存の Task に足す", "切り出す"]),
  title: Schema.String,
  brief: Schema.String,
  targetTaskId: Schema.NullOr(Schema.String),
  targetTitle: Schema.NullOr(Schema.String),
  facts: Schema.Array(FactView),
  createdAt: Schema.String,
});
export type ProposalView = typeof ProposalView.Type;

export const AccountView = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  origin: Schema.String,
  status: Schema.Literals(["つないでいない", "つないでいる", "つなぎ直しが要る", "外した"]),
  problem: Schema.NullOr(Schema.String),
  secret: Schema.NullOr(Schema.String),
});
export type AccountView = typeof AccountView.Type;

/** 承認の画面に出す書き込み（承認待ちと、書き込めなかったもの） */
export const WriteView = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  taskTitle: Schema.String,
  summary: Schema.String,
  stage: Schema.Literals(["承認待ち", "書き込み中", "書けたか分からない", "書き込んだ", "失敗", "取りやめた"]),
  failure: Schema.NullOr(Schema.String),
});
export type WriteView = typeof WriteView.Type;

/** 提案・事実・アカウントの操作（どれもユーザーが行う） */
export const InboxCommand = Schema.Union([
  Schema.TaggedStruct("AcceptProposal", { id: Id }),
  Schema.TaggedStruct("DeclineProposal", { id: Id }),
  Schema.TaggedStruct("RouteFact", {
    id: Id,
    to: Schema.Union([Schema.TaggedStruct("NewTask", {}), Schema.TaggedStruct("Ignore", {}), Schema.TaggedStruct("AttachTo", { taskId: Id })]),
  }),
  Schema.TaggedStruct("AddGitHubAccount", { key: Schema.String, label: Schema.String }),
  Schema.TaggedStruct("RemoveAccount", { id: Id }),
  Schema.TaggedStruct("SyncNow", {}),
  Schema.TaggedStruct("RequestWrite", { taskId: Id, itemId: Id }),
  Schema.TaggedStruct("ApproveWrite", { id: Id }),
  Schema.TaggedStruct("CancelWrite", { id: Id }),
]);
export type InboxCommand = typeof InboxCommand.Type;

export const InboxView = Schema.Struct({ proposals: Schema.Array(ProposalView), undecided: Schema.Array(FactView), accounts: Schema.Array(AccountView), writes: Schema.Array(WriteView) });
export type InboxView = typeof InboxView.Type;

const AiOptionView = Schema.Struct({ id: Schema.String, label: Schema.String, secret: Schema.NullOr(Schema.String) });
const AiUseView = Schema.Struct({ selected: Schema.NullOr(Schema.String), options: Schema.Array(AiOptionView) });

/** AI 設定（API キーは含めない。どの名前で .env.local に書くかだけを見せる） */
export const AiSettingsView = Schema.Struct({
  status: Schema.Literals(["初期設定中", "使える", "使えない"]),
  problem: Schema.NullOr(Schema.Struct({ use: Schema.Literals(["Decisions", "Generation", "Agent"]), reason: Schema.String })),
  uses: Schema.Struct({ decisions: AiUseView, generation: AiUseView, agent: AiUseView }),
});
export type AiSettingsView = typeof AiSettingsView.Type;

export const AiCommand = Schema.TaggedStruct("ConfigureAi", { use: Schema.Literals(["decisions", "generation", "agent"]), option: Schema.String });
export type AiCommand = typeof AiCommand.Type;

/** 断られた・見つからないは値で返す（画面は reason をそのまま見せる） */
export type Reply<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly reason: string };

export { CHANNELS } from "./channels.js";

export interface LiveTodoApi {
  command(command: Command): Promise<Reply<TaskView>>;
  board(): Promise<Reply<ReadonlyArray<BoardCard>>>;
  task(id: string): Promise<Reply<TaskView>>;
  aiSettings(): Promise<Reply<AiSettingsView>>;
  configureAi(command: AiCommand): Promise<Reply<AiSettingsView>>;
  inbox(): Promise<Reply<InboxView>>;
  inboxCommand(command: InboxCommand): Promise<Reply<InboxView>>;
  /** main 側で Task が変わったら呼ばれる。戻り値で購読をやめる */
  onChanged(listener: () => void): () => void;
}
