import { Schema } from "effect";
import { Completion, DueDate, Effort, ItemStatus, TaskStatus } from "./vocabulary.js";

/**
 * 事実（Source Item）のうち、AI に渡してよい中身。
 * アプリが書いた行（appLines）と、外の人が書いた文（external）を分けて持つ。外の文は指示として読ませないよう、
 * 問いや指示の側ではなく入力の側にだけ置く（「自分のアカウント: @attacker」のような行を書かれても、アプリの行と区別できるように）。
 */
export const FactContent = Schema.Struct({
  /** どの Source か（github・gmail・slack など） */
  source: Schema.String,
  /** 何か（PR・メール・スレッド・予定 など） */
  kind: Schema.String,
  title: Schema.String,
  /** アプリが書いた、信頼できる行（「状態: open」「自分: レビューを頼まれた」「conflict: あり」など） */
  appLines: Schema.Array(Schema.String),
  /** 外の人が書いた文（本文・コメント・返信）。信頼しない */
  external: Schema.Array(Schema.Struct({ author: Schema.String, at: Schema.NullOr(Schema.String), text: Schema.String })),
});
export type FactContent = typeof FactContent.Type;

/**
 * 識別子つきの事実。識別子（URL・スレッド）は判定 1（どの Task の事実か）の材料にだけ使う。
 * 判定 3（新しく行動が要るか）には FactContent を渡す（同じスレッドに別の依頼が来ることはよくあるため。routing.spec）。
 */
export const FactMaterial = Schema.Struct({
  ...FactContent.fields,
  id: Schema.String,
  url: Schema.NullOr(Schema.String),
});
export type FactMaterial = typeof FactMaterial.Type;

/** 計画の 1 行（Task の dossier に載せる、計画の要約） */
export const PlanLine = Schema.Struct({
  title: Schema.String,
  status: ItemStatus,
  completes: Schema.Boolean,
  effort: Schema.NullOr(Effort),
  due: Schema.NullOr(DueDate),
  /** 木の深さ（0 が根元）。並べ方と分かれ道の枝を、字下げで見せる */
  depth: Schema.Number,
});
export type PlanLine = typeof PlanLine.Type;

/** Task の dossier（AI に渡す Task の今の姿）。Task の言葉だけで持ち、Source の言葉は facts の側に置く */
export const TaskMaterial = Schema.Struct({
  id: Schema.String,
  /** 何をするか */
  title: Schema.String,
  /** 今の状況と次の一手 */
  brief: Schema.String,
  status: TaskStatus,
  completion: Completion,
  due: Schema.NullOr(DueDate),
  blocksOthers: Schema.Boolean,
  plan: Schema.Array(PlanLine),
  /** Task が持つ事実の見出し（中身は要るときだけ FactMaterial で渡す） */
  facts: Schema.Array(Schema.Struct({ id: Schema.String, source: Schema.String, kind: Schema.String, title: Schema.String })),
});
export type TaskMaterial = typeof TaskMaterial.Type;

/** 事実が求める作業 1 つ（Generation が事実から切り出す。判定 2・3 の単位） */
export const Work = Schema.Struct({
  /** 何をするか（Task の title にそのまま使える言い方） */
  title: Schema.String,
  /** 事実のどこから、何を求められているか */
  detail: Schema.String,
  due: Schema.NullOr(DueDate),
});
export type Work = typeof Work.Type;

/** Agent の作業の成果（agent-run.spec の種類ごと）。Agent は Task を直接変えないので、成果は Task Input として届き、Generation が Task の言葉に置き換える */
export const AgentOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("回答"), text: Schema.String }),
  /** 調べた（読むだけ）。わかったこと */
  Schema.Struct({ type: Schema.Literal("報告"), summary: Schema.String, findings: Schema.Array(Schema.String) }),
  /** 直した（ローカルの作業場所に書いた。外へは書き込まない） */
  Schema.Struct({ type: Schema.Literal("差分"), summary: Schema.String, workspace: Schema.String, files: Schema.Array(Schema.String) }),
]);
export type AgentOutcome = typeof AgentOutcome.Type;
