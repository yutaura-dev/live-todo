import { ensure } from "@yutaura/live-spec";

/**
 * Agent Run（AI に任せた作業 1 回）。Agent Thread の中にあり、Agent Thread を通してだけ扱う。
 * 作業: 質問に答える・計画を考える・Action Item をやる・依存の更新を調べる・PR を直す・コンフリクトを直す。ユーザーが頼むことも、AI が先回りして始めること（Pre-work）もある。
 * Claude Code は外に書き込まない（ADR-0012・0013）。読むことは広く許し、書き込みは許可しないコマンド・渡さない認証情報・sandbox の 3 つを重ねて止める。外への書き込み（push・返信・merge など）は、結果として Write を頼むだけで、ユーザーが確かめて承認する。
 */
export type AgentRun = {
  /** 作業の段階 */
  status: Status;
  /** 渡す道具。読むだけ（Read・Grep・Glob・Web・gws と gh の読むだけのコマンド）か、直す（それに加えて、作業場所の中での Edit・Write・Bash）か */
  tools: Tools;
  /** 作業を見分ける ID */
  id: string;
  /** 何の作業か */
  kind: Kind;
  /** だれが始めたか */
  trigger: "ユーザーが頼んだ" | "先回り";
  /** 調べたときの元の項目（PR の head の commit など）。変わったら調べ直す・merge するときに指定する */
  subjectFingerprint: string;
  /** 結果（回答・報告・差分）。終わったときだけ */
  result: string | null;
  /** 終わらなかった理由 */
  stopReason: StopReason | null;
};

export type Kind = "質問に答える" | "計画を考える" | "Action Item をやる" | "依存の更新を調べる" | "PR を直す" | "コンフリクトを直す";
export type Tools = "読むだけ" | "直す";
export type StopReason = "ユーザーが止めた" | "追う項目が片付いたのでやめた" | "うまくいかなかった" | "アプリを閉じた" | "決まった形の答えが返らない";

export const Status = {
  /** 作業の順番を待っている */
  queued: "待ち行列",
  /** Claude Code がやっている */
  running: "やっている",
  /** 追う項目が片付いたので、やめるか続けるかを Claude Code が判断している（ADR-0016） */
  deciding: "判断中",
  /** やり遂げた */
  succeeded: "終わった",
  /** 途中で止まった・やめた・うまくいかなかった（理由を残す。Task は作業の前の状態に戻る） */
  stopped: "止まった",
  /** 待ち行列のうちに取り消した（追う項目が片付いた・ユーザーが取り消した） */
  cancelled: "取り消した",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

const FIXES: Kind[] = ["PR を直す", "コンフリクトを直す"];

type Actor = { kind: "user" } | { kind: "agent" } | { kind: "app" };

/** AI: Claude Code。アプリ: 作業を並べ、起動し、知らせを伝える */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  AI: { kind: "agent" },
  アプリ: { kind: "app" },
};

/**
 * 作業を頼む・先回りして始める
 *
 * 直す道具（Edit・Write・Bash）を渡すのは、PR を直す・コンフリクトを直すときだけ。それ以外は読むだけ。
 */
export function initial(actor: Actor, kind: Kind): AgentRun {
  ensure(actor.kind === "user" || actor.kind === "agent", "ユーザーか、先回りする AI だけ");
  return {
    status: "待ち行列",
    tools: FIXES.includes(kind) ? "直す" : "読むだけ",
    id: "ar1",
    kind,
    trigger: actor.kind === "user" ? "ユーザーが頼んだ" : "先回り",
    subjectFingerprint: "abc1234",
    result: null,
    stopReason: null,
  };
}

/** 順番が来たので、Claude Code を起動する */
export function start(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(run.status === "待ち行列", "待ち行列のときだけ");
  return { ...run, status: "やっている" };
}

/** やり遂げた（回答・報告・差分を残す。外への書き込みが要るなら、Write を頼む） */
export function succeed(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(run.status === "やっている", "やっているときだけ");
  return { ...run, status: "終わった", result: "差分と確認のコマンドの結果" };
}

/** うまくいかなかった・アプリを閉じて止まった */
export function fail(run: AgentRun, actor: Actor, reason: "うまくいかなかった" | "アプリを閉じた"): AgentRun {
  ensure(actor.kind === "agent" || actor.kind === "app", "AI かアプリだけ");
  ensure(run.status === "やっている", "やっているときだけ");
  return { ...run, status: "止まった", stopReason: reason };
}

/** ユーザーが止める（画面では、注意のダイアログで確かめてから止める） */
export function stop(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(run.status === "やっている" || run.status === "判断中", "やっている・判断中のときだけ");
  return { ...run, status: "止まった", stopReason: "ユーザーが止めた" };
}

/**
 * 追う項目がすべて片付いた（merge・close された・消えた）ので、やめるか続けるかを判断させる
 *
 * 動いている Claude Code を止め、同じ会話で知らせを伝える（ADR-0016）。Decisions ではなく、途中経過を知っている Claude Code 自身に判断させる。
 */
export function interrupt(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(run.status === "やっている", "やっているときだけ");
  return { ...run, status: "判断中" };
}

/** Claude Code が判断した（やめる・続ける・決まった形の答えが返らない） */
export function decide(run: AgentRun, actor: Actor, answer: "やめる" | "続ける" | "答えが返らない"): AgentRun {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(run.status === "判断中", "判断中のときだけ");
  if (answer === "続ける") return { ...run, status: "やっている" };
  return { ...run, status: "止まった", stopReason: answer === "やめる" ? "追う項目が片付いたのでやめた" : "決まった形の答えが返らない" };
}

/** 待ち行列のうちに取り消す（追う項目が片付いた・ユーザーが取り消した。判断させずに取り消す。ADR-0016） */
export function cancel(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "app" || actor.kind === "user", "アプリかユーザーだけ");
  ensure(run.status === "待ち行列", "待ち行列のときだけ");
  return { ...run, status: "取り消した" };
}

export const inputs = {
  initial: { 質問: ["質問に答える"], "PR を直す": ["PR を直す"], コンフリクト: ["コンフリクトを直す"], 計画: ["計画を考える"], "Action Item": ["Action Item をやる"], 依存の更新: ["依存の更新を調べる"] },
  fail: { うまくいかなかった: ["うまくいかなかった"], アプリを閉じた: ["アプリを閉じた"] },
  decide: { やめる: ["やめる"], 続ける: ["続ける"], 答えが返らない: ["答えが返らない"] },
};

const FINISHED: Status[] = ["終わった", "止まった", "取り消した"];

export const invariants = {
  "終わった作業は、もう変わらない": (before: AgentRun, after: AgentRun) => !FINISHED.includes(before.status) || before.status === after.status,
  "止まったときだけ、止まった理由がある": (run: AgentRun) => (run.status === "止まった") === (run.stopReason !== null),
  "渡す道具は、作ったあと変わらない": (before: AgentRun, after: AgentRun) => before.tools === after.tools,
};

export const links = [
  { from: start, to: "task", action: "startWork", label: "Task を AI が作業中にする" },
  { from: succeed, to: "task", label: "AI の作業が終わる。Action Item をやる作業なら、その Action Item を果たす" },
  { from: succeed, to: "write", label: "外への書き込み（push・返信など）が要るなら、Action Item から頼む（ユーザーが確かめて承認する）" },
  { from: fail, to: "task", action: "stopWork", label: "Task を作業の前の状態に戻す" },
  { from: stop, to: "task", action: "stopWork", label: "Task を作業の前の状態に戻す" },
  { from: decide, to: "task", label: "やめたなら、追う項目の今の状態から Task を導き直し、やめた理由を変化として残す。答えが返らないなら、作業の前の状態に戻す" },
  { from: cancel, to: "task", label: "追う項目が片付いたなら、追う項目の今の状態から Task を導き直す" },
];

export const scenarios = {
  "質問を頼み、Claude Code が調べて答える": [
    { do: initial, by: "ユーザー", input: "質問", expect: { status: "待ち行列", tools: "読むだけ", trigger: "ユーザーが頼んだ" } },
    { do: start, by: "アプリ", expect: { status: "やっている" } },
    { do: succeed, by: "AI", expect: { status: "終わった" } },
    { do: stop, by: "ユーザー", denied: "やっている・判断中のときだけ" },
  ],
  "PR を直すときだけ、直す道具を渡す": [{ do: initial, by: "ユーザー", input: "PR を直す", expect: { tools: "直す" } }],
  "コンフリクトを直すときも、直す道具を渡す": [{ do: initial, by: "AI", input: "コンフリクト", expect: { tools: "直す", trigger: "先回り" } }],
  "計画を考えるときは、読むだけ": [{ do: initial, by: "AI", input: "計画", expect: { tools: "読むだけ" } }],
  "作業中に PR が merge されたら、Claude Code がやめるか続けるかを判断する": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "アプリ" },
    { do: interrupt, by: "アプリ", expect: { status: "判断中" } },
    { do: decide, by: "AI", input: "続ける", expect: { status: "やっている" } },
    { do: interrupt, by: "アプリ" },
    { do: decide, by: "AI", input: "やめる", expect: { status: "止まった", stopReason: "追う項目が片付いたのでやめた" } },
  ],
  "判断の答えが返らなければ、うまくいかなかったのと同じに扱う": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "アプリ" },
    { do: interrupt, by: "アプリ" },
    { do: decide, by: "AI", input: "答えが返らない", expect: { status: "止まった", stopReason: "決まった形の答えが返らない" } },
  ],
  "待ち行列のうちに追う項目が片付いたら、判断させずに取り消す": [
    { do: initial, by: "AI", input: "計画" },
    { do: cancel, by: "AI", denied: "アプリかユーザーだけ" },
    { do: cancel, by: "アプリ", expect: { status: "取り消した" } },
    { do: start, by: "アプリ", denied: "待ち行列のときだけ" },
  ],
  "ユーザーが止める": [
    { do: initial, by: "ユーザー", input: "質問" },
    { do: start, by: "アプリ" },
    { do: stop, by: "AI", denied: "ユーザーだけ" },
    { do: stop, by: "ユーザー", expect: { status: "止まった", stopReason: "ユーザーが止めた" } },
    { do: succeed, by: "AI", denied: "やっているときだけ" },
  ],
  "アプリを閉じたら、止まったことにする": [
    { do: initial, by: "ユーザー", input: "質問" },
    { do: start, by: "アプリ" },
    { do: fail, by: "アプリ", input: "アプリを閉じた", expect: { status: "止まった", stopReason: "アプリを閉じた" } },
  ],
  "作業を進めるのは決まった人だけ": [
    { do: initial, by: "アプリ", input: "質問", denied: "ユーザーか、先回りする AI だけ" },
  ],
  "作業の段階を進めるのは決まった人だけ": [
    { do: initial, by: "ユーザー", input: "質問" },
    { do: start, by: "AI", denied: "アプリだけ" },
    { do: start, by: "アプリ" },
    { do: succeed, by: "アプリ", denied: "AI だけ" },
    { do: fail, by: "ユーザー", input: "うまくいかなかった", denied: "AI かアプリだけ" },
    { do: interrupt, by: "AI", denied: "アプリだけ" },
    { do: decide, by: "AI", input: "やめる", denied: "判断中のときだけ" },
    { do: interrupt, by: "アプリ" },
    { do: decide, by: "アプリ", input: "やめる", denied: "AI だけ" },
    { do: interrupt, by: "アプリ", denied: "やっているときだけ" },
  ],
};

export const reviewed = {
  "same-for-similar-actors:fail": "うまくいかなかったことには Claude Code が、アプリを閉じて止まったことにはアプリが気づく。どちらでも止まったになり、理由で分ける",
  "same-for-similar-actors:cancel": "待ち行列の作業は、追う項目が片付いたらアプリが、要らなくなったらユーザーが取り消す。どちらでも取り消したになる",
};

export const questions = [
  {
    ask: "AI が先回りして始めてよい作業はどこまでか？（今の spec はどの作業も先回りで始められる。PR を直す・コンフリクトを直すは、直したあと push の承認が要るので外には書き込まないが、作業場所と費用は使う）",
    about: initial,
  },
];
