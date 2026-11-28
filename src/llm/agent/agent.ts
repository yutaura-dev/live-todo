import { Context, type Effect, Schema, type Stream } from "effect";
import type { Answer } from "../shared/answer.js";
import type { AiUnreachableError } from "../shared/errors.js";
import { AgentOutcome, TaskMaterial } from "../shared/materials.js";

// agent-run.spec・agent-thread.spec の Agent Run を、Agent（Claude Code・Codex など）に頼む口

export const AgentRunKind = Schema.Literals(["質問に答える", "Action Item をやる（読むだけ）", "Action Item をやる（直す）", "依存の更新を調べる", "PR を直す", "コンフリクトを直す"]);
export type AgentRunKind = typeof AgentRunKind.Type;

/**
 * 渡す道具の段（ADR-0012・ADR-0013・ADR-0023）。外へ書き込む段はない（Agent は外へ書き込まない。書き込みは Approval を通してアプリが行う）。
 * - 読むだけ: 読む・探す・Web・gws と gh の読むだけのコマンド
 * - 直す: 作業場所のファイルの読み書きと、sandbox の中の Bash。外の API の認証情報・Web・gws・gh は渡さない
 */
export const AgentTools = Schema.Literals(["読むだけ", "直す"]);
export type AgentTools = typeof AgentTools.Type;

const FIXES: ReadonlyArray<AgentRunKind> = ["PR を直す", "コンフリクトを直す", "Action Item をやる（直す）"];

/** 作業の種類から道具の段が決まる（呼ぶ側に選ばせない） */
export const toolsFor = (kind: AgentRunKind): AgentTools => (FIXES.includes(kind) ? "直す" : "読むだけ");

export const AgentRunRequest = Schema.Struct({
  runId: Schema.String,
  kind: AgentRunKind,
  tools: AgentTools,
  /** 作業場所（直すときは必須。会話は作業場所に結び付くので、続けるときは同じ場所） */
  workspace: Schema.NullOr(Schema.String),
  /** 続ける会話（Agent Thread の session）。新しく始めるなら null */
  sessionId: Schema.NullOr(Schema.String),
  task: TaskMaterial,
  /** 頼むこと（ユーザーの質問・「PR #42 を直す」など） */
  request: Schema.String,
  /** Action Item から始めるときの、その Action Item */
  item: Schema.NullOr(Schema.Struct({ id: Schema.String, title: Schema.String })),
}).check(
  Schema.makeFilter((request) => request.tools === toolsFor(request.kind) || "作業の種類と道具の段が合わない"),
  Schema.makeFilter((request) => request.tools === "読むだけ" || request.workspace !== null || "直すときは作業場所が要る"),
);
export type AgentRunRequest = typeof AgentRunRequest.Type;

/** 作業中に起きたこと。終わった・やめたのどちらかで終わる */
export const AgentEvent = Schema.Union([
  /** 会話が始まった（Agent Thread に session を残す） */
  Schema.Struct({ type: Schema.Literal("始まった"), sessionId: Schema.String }),
  /** 途中経過（画面に出す。Task は変えない） */
  Schema.Struct({ type: Schema.Literal("進んだ"), text: Schema.String }),
  /** 成果が出た。Task Input（AI の作業の成果）として Task に届け、Generation が Task の言葉に置き換える */
  Schema.Struct({ type: Schema.Literal("終わった"), outcome: AgentOutcome }),
  /** 成果を出さずにやめた（ユーザーが止めた・アプリを閉じたは、呼ぶ側が Stream を止めるので、ここには来ない） */
  Schema.Struct({ type: Schema.Literal("やめた"), reason: Schema.Literals(["うまくいかなかった", "決まった形の答えが返らない", "作業場所が消えた", "続けられない会話"]) }),
]);
export type AgentEvent = typeof AgentEvent.Type;

/**
 * AI 設定の Agent。Task を直接変えず、成果を出来事で返す。
 * - run: 作業を 1 回走らせる。止めるときは Stream を中断する（ユーザーが止めた・取り消した・アプリを閉じた）
 * - askToStop: 追う元の項目が片付いた（PR が merge された など）と作業中の会話に伝え、やめるか続けるかを決めさせる。答えなかったら呼ぶ側がやめる
 */
export class AgentRunner extends Context.Service<
  AgentRunner,
  {
    run(request: AgentRunRequest): Stream.Stream<AgentEvent, AiUnreachableError>;
    askToStop(input: { runId: string; sessionId: string; notice: string }): Effect.Effect<Answer<"やめる" | "続ける">, AiUnreachableError>;
  }
>()("live-todo/llm/agent/AgentRunner") {}
