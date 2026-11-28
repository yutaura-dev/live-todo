import { ensure } from "@yutaura/live-spec";

/**
 * Agent Run（AI に任せた作業 1 回）。Agent Thread の中にあり、Agent Thread を通してだけ扱う。
 * Agent（AI Settings で選んだ Claude Code・Codex など）が、複雑な作業・調査をする（ADR-0022）。作業: 質問に答える・Action Item をやる・依存の更新を調べる・PR を直す・コンフリクトを直す。計画を考えるのは Agent ではなく Generation（Agent の作業にしない）。
 * 始め方は 2 つ: ユーザーが直接頼む（質問・PR を直す など）か、計画の Action Item（Claude Code が果たす）から始める（番が来たら自動で・ボタンで。どちらにするかは計画の中で決める。自動で始めるのは、渡す道具の段が自動でやってよい範囲に入るときだけ（読むだけ = 調べる、直す = ローカルの書き込み。ADR-0023）。先回り（Pre-work）はこれで表す）。AI が自分で作業を始めることはしない。
 * Agent は Task を直接変えない。成果（回答・報告・差分）は、Task に「AI の作業の成果」として届き、Generation が Task の言葉に置き換える。外への書き込みが要るなら、Generation が計画に書き込みで果たされる Action Item を足し、ユーザーが確かめて承認する（Write。自動でやってよい範囲に入る書き込みは、確かめずに書き込む）。
 * Agent は外に書き込まない（ADR-0012・0013）。書き込みは、許可しないコマンド・渡さない認証情報・sandbox の 3 つを重ねて止める。
 * merge を承認して走る処理は、merge 自体が目的なので Agent Run ではない（追う項目が片付いても知らせない。ADR-0016）。
 */
export type AgentRun = {
  /** 作業の段階 */
  status: Status;
  /**
   * 渡す道具
   * - 読むだけ: ファイルを読む・探す、Web の検索とページ、gws と gh の読むだけのコマンド。編集の道具は渡さない（ADR-0013）
   * - 直す: 作業場所のファイルを読む・書く、Bash（sandbox の中。書けるのは作業場所とパッケージのキャッシュ、通信は npm・yarn のレジストリだけ）。外の API の認証情報も、Web・gws・gh も渡さない（ADR-0012）。読むだけの上に重ねない
   */
  tools: Tools;
  /** 作業を見分ける ID */
  id: string;
  /** 何の作業か */
  kind: Kind;
  /** やる Action Item（Action Item をやる作業のとき。Task は会話が持つ） */
  actionItemId: string | null;
  /** どの会話で動いたか（新しい会話を始めても、前の作業がどの会話だったかを追えるように） */
  sessionId: string;
  /** どう始まったか（Action Item から = 番が来て自動で、またはボタンで） */
  trigger: "ユーザーが頼んだ" | "Action Item から";
  /** 調べたときの元の項目（PR の head の commit など。質問のように元の項目がなければ null）。変わったら調べ直す。push を頼むときの版（Write の version）にし、直し始めたときから動いていないことを確かめる */
  subjectFingerprint: string | null;
  /** 追う項目が片付いたことを、もう知らせたか（知らせるのは 1 回だけ） */
  notified: boolean;
  /** 結果（回答・報告・差分）。終わったときだけ */
  result: string | null;
  /** 終わらなかった理由 */
  stopReason: StopReason | null;
};

export type Kind = "質問に答える" | "Action Item をやる（読むだけ）" | "Action Item をやる（直す）" | "依存の更新を調べる" | "PR を直す" | "コンフリクトを直す";
export type Tools = "読むだけ" | "直す";
export type StopReason =
  | "ユーザーが止めた"
  | "追う項目が片付いたのでやめた"
  | "うまくいかなかった"
  | "アプリを閉じた"
  | "決まった形の答えが返らない"
  | "作業場所が消えた"
  | "ユーザーが取り消した"
  | "追う項目が片付いたので取り消した"
  | "やらなくなった"
  | "ユーザーが済ませた";

export const Status = {
  /** 作業の順番を待っている */
  queued: "待ち行列",
  /** Claude Code がやっている */
  running: "やっている",
  /** 追う項目が片付いたので、やめるか続けるかを Claude Code が判断している（ADR-0016） */
  deciding: "判断中",
  /** やり遂げた */
  succeeded: "終わった",
  /** 途中で止まった・やめた・うまくいかなかった（理由を残す。Task は AI の作業が終わったことになる。列は AI の作業では変わらない） */
  stopped: "止まった",
  /** 待ち行列のうちに取り消した（追う項目が片付いた・ユーザーが取り消した） */
  cancelled: "取り消した",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

const FIXES: Kind[] = ["PR を直す", "コンフリクトを直す", "Action Item をやる（直す）"];
const FROM_ITEM: Kind[] = ["Action Item をやる（読むだけ）", "Action Item をやる（直す）"];

type Actor = { kind: "user" } | { kind: "agent" } | { kind: "app" };

/** AI: Claude Code。アプリ: 作業を並べ、起動し、知らせを伝える */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  AI: { kind: "agent" },
  アプリ: { kind: "app" },
};

/**
 * 作業を頼む・Action Item から始める
 *
 * 直す道具（Edit・Write・Bash）を渡すのは、PR を直す・コンフリクトを直す・直す Action Item をやるときだけ。それ以外は読むだけ。
 */
export function initial(actor: Actor, kind: Kind, task: "開いている" | "開いていない"): AgentRun {
  ensure(actor.kind === "user" || actor.kind === "app", "ユーザーか、Action Item から始めるアプリだけ");
  ensure(actor.kind === "user" || FROM_ITEM.includes(kind), "アプリが始めるのは、Action Item をやる作業だけ");
  ensure(task === "開いている", "Task が要確認か todo のときだけ（完了待ち・終わった Task には頼まない）");
  return {
    status: "待ち行列",
    tools: FIXES.includes(kind) ? "直す" : "読むだけ",
    id: "ar1",
    kind,
    actionItemId: FROM_ITEM.includes(kind) ? "a2" : null,
    sessionId: "s1",
    trigger: FROM_ITEM.includes(kind) ? "Action Item から" : "ユーザーが頼んだ",
    subjectFingerprint: kind === "質問に答える" ? null : "abc1234",
    notified: false,
    result: null,
    stopReason: null,
  };
}

/** 順番が来たので、Claude Code を起動する */
export function start(run: AgentRun, actor: Actor, thread: "続けられる" | "続けられない", task: "開いている" | "開いていない"): AgentRun {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(run.status === "待ち行列", "待ち行列のときだけ");
  ensure(thread === "続けられる", "会話を続けられるときだけ（続けられないなら、先に新しい会話を始める）");
  ensure(task === "開いている", "Task が要確認か todo のときだけ（完了待ち・終わった Task では始めない）");
  return { ...run, status: "やっている" };
}

/** やり遂げた（回答・報告・差分を残す。外への書き込みが要るなら、Write を頼む） */
export function succeed(run: AgentRun, actor: Actor): AgentRun {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(run.status === "やっている", "やっているときだけ");
  return { ...run, status: "終わった", result: "差分と確認のコマンドの結果" };
}

/** うまくいかなかった・アプリを閉じて止まった（判断中に閉じたときも） */
export function fail(run: AgentRun, actor: Actor, reason: "うまくいかなかった" | "アプリを閉じた" | "作業場所が消えた"): AgentRun {
  ensure(actor.kind === "agent" || actor.kind === "app", "AI かアプリだけ");
  ensure(run.status === "やっている" || run.status === "判断中", "やっている・判断中のときだけ");
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
  ensure(!run.notified, "まだ知らせていないときだけ（続けると判断したら、もう知らせない）");
  ensure(run.subjectFingerprint !== null, "追う元の項目がある作業だけ");
  return { ...run, status: "判断中", notified: true };
}

/** Claude Code が判断した（やめる・続ける・決まった形の答えが返らない） */
export function decide(run: AgentRun, actor: Actor, answer: "やめる" | "続ける" | "答えが返らない"): AgentRun {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(run.status === "判断中", "判断中のときだけ");
  if (answer === "続ける") return { ...run, status: "やっている" };
  return { ...run, status: "止まった", stopReason: answer === "やめる" ? "追う項目が片付いたのでやめた" : "決まった形の答えが返らない" };
}

/**
 * もう要らなくなった作業をやめる（Action Item をやらなくなった・ユーザーが自分で済ませた・Task をやらないことにした）
 *
 * アプリがやめる。ユーザーが止めたのか、やらなくなって止まったのかを、理由で分ける。待ち行列なら取り消す。
 */
export function withdraw(run: AgentRun, actor: Actor, reason: "やらなくなった" | "ユーザーが済ませた"): AgentRun {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(run.status === "待ち行列" || run.status === "やっている" || run.status === "判断中", "終わっていないときだけ");
  return { ...run, status: run.status === "待ち行列" ? "取り消した" : "止まった", stopReason: reason };
}

/** 待ち行列のうちに取り消す（追う項目が片付いた・ユーザーが取り消した。判断させずに取り消す。ADR-0016） */
export function cancel(run: AgentRun, actor: Actor, reason: "ユーザーが取り消した" | "追う項目が片付いたので取り消した"): AgentRun {
  ensure(actor.kind === "app" || actor.kind === "user", "アプリかユーザーだけ");
  ensure(run.status === "待ち行列", "待ち行列のときだけ");
  return { ...run, status: "取り消した", stopReason: reason };
}

export const inputs = {
  initial: {
    質問: ["質問に答える", "開いている"],
    "PR を直す": ["PR を直す", "開いている"],
    コンフリクト: ["コンフリクトを直す", "開いている"],
    "Action Item（読むだけ）": ["Action Item をやる（読むだけ）", "開いている"],
    "Action Item（直す）": ["Action Item をやる（直す）", "開いている"],
    依存の更新: ["依存の更新を調べる", "開いている"],
    "Task が閉じた": ["質問に答える", "開いていない"],
  },
  fail: { うまくいかなかった: ["うまくいかなかった"], アプリを閉じた: ["アプリを閉じた"], 作業場所が消えた: ["作業場所が消えた"] },
  start: { 続けられる: ["続けられる", "開いている"], 続けられない: ["続けられない", "開いている"], "Task が閉じた": ["続けられる", "開いていない"] },
  withdraw: { やらなくなった: ["やらなくなった"], 済ませた: ["ユーザーが済ませた"] },
  cancel: { ユーザー: ["ユーザーが取り消した"], 片付いた: ["追う項目が片付いたので取り消した"] },
  decide: { やめる: ["やめる"], 続ける: ["続ける"], 答えが返らない: ["答えが返らない"] },
};

const FINISHED: Status[] = ["終わった", "止まった", "取り消した"];

export const invariants = {
  "終わった作業は、もう変わらない": (before: AgentRun, after: AgentRun) => !FINISHED.includes(before.status) || before.status === after.status,
  "止まった・取り消したときだけ、理由がある": (run: AgentRun) => (run.status === "止まった" || run.status === "取り消した") === (run.stopReason !== null),
  "渡す道具は、作ったあと変わらない": (before: AgentRun, after: AgentRun) => before.tools === after.tools,
  "終わったときだけ、結果がある": (run: AgentRun) => (run.status === "終わった") === (run.result !== null),
};

export const links = [
  { from: start, to: "task", action: "startWork", label: "Task を AI が作業中にする（待ち行列のあいだは作業中にしない）" },
  { from: succeed, to: "task", action: "finishWork", label: "AI の作業が終わる。Action Item をやる作業なら、番が来ていればその Action Item を果たす（番が来る前なら、番が来たときに果たす）" },
  { from: succeed, to: "task", action: "receive", label: "成果が「AI の作業の成果」として届き、Generation が Task の言葉にする（外への書き込みが要るなら、Generation が計画に書き込みで果たされる Action Item を足す。push の版はこの作業の元の項目）" },
  { from: fail, to: "task", action: "stopWork", label: "AI の作業が終わったことにする。Action Item をやる作業なら、報告だけ残して済ませない" },
  { from: stop, to: "task", action: "stopWork", label: "AI の作業が終わったことにする。Action Item をやる作業なら、報告だけ残して済ませない" },
  { from: withdraw, to: "task", action: "stopWork", label: "やっている・判断中だったなら、AI の作業が終わったことにする（Action Item は果たさない）。待ち行列で取り消したなら、cancel と同じく Task は変えない" },
  { from: decide, to: "task", action: "stopWork", label: "やめたなら、片付いた追う項目を事実の変化として受け取り、やめた理由を変化として残す。答えが返らないなら、AI の作業が終わったことにする" },
  { from: cancel, to: "task", label: "AI の作業を始めないまま終わる。追う項目が片付いたので取り消したなら、事実の変化として受け取る" },
  { from: fail, to: "agent-thread", action: "lose", label: "作業場所が消えたなら、会話を続けられなくする" },
];

export const scenarios = {
  "やらなくなった Action Item の作業は、アプリがやめる（理由はやらなくなった）": [
    { do: initial, by: "アプリ", input: "Action Item（読むだけ）" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: withdraw, by: "ユーザー", input: "やらなくなった", denied: "アプリだけ" },
    { do: withdraw, by: "アプリ", input: "やらなくなった", expect: { status: "止まった", stopReason: "やらなくなった" } },
    { do: withdraw, by: "アプリ", input: "やらなくなった", denied: "終わっていないときだけ" },
  ],
  "待ち行列のうちにやらなくなったら、取り消す": [
    { do: initial, by: "アプリ", input: "Action Item（読むだけ）" },
    { do: withdraw, by: "アプリ", input: "やらなくなった", expect: { status: "取り消した", stopReason: "やらなくなった" } },
  ],
  "質問を頼み、Claude Code が調べて答える": [
    { do: initial, by: "ユーザー", input: "質問", expect: { status: "待ち行列", tools: "読むだけ", trigger: "ユーザーが頼んだ" } },
    { do: start, by: "アプリ", input: "続けられる", expect: { status: "やっている" } },
    { do: succeed, by: "AI", expect: { status: "終わった" } },
    { do: stop, by: "ユーザー", denied: "やっている・判断中のときだけ" },
  ],
  "PR を直すときは、直す道具を渡す": [{ do: initial, by: "ユーザー", input: "PR を直す", expect: { tools: "直す" } }],
  "コンフリクトを直すときも、直す道具を渡す": [{ do: initial, by: "ユーザー", input: "コンフリクト", expect: { tools: "直す" } }],
  "Action Item から始める（番が来たら自動で・ボタンで）": [{ do: initial, by: "アプリ", input: "Action Item（読むだけ）", expect: { trigger: "Action Item から", tools: "読むだけ" } }],
  "直す Action Item には、直す道具を渡す": [{ do: initial, by: "アプリ", input: "Action Item（直す）", expect: { tools: "直す" } }],
  "完了待ち・終わった Task には、作業を頼まない": [
    { do: initial, by: "ユーザー", input: "Task が閉じた", denied: "Task が要確認か todo のときだけ（完了待ち・終わった Task には頼まない）" },
  ],
  "Task が終わったあとは、作業を始めない": [
    { do: initial, by: "ユーザー", input: "質問" },
    { do: start, by: "アプリ", input: "Task が閉じた", denied: "Task が要確認か todo のときだけ（完了待ち・終わった Task では始めない）" },
  ],
  "ユーザーが自分で済ませたら、アプリが作業をやめる": [
    { do: initial, by: "アプリ", input: "Action Item（読むだけ）" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: withdraw, by: "アプリ", input: "済ませた", expect: { status: "止まった", stopReason: "ユーザーが済ませた" } },
  ],
  "続けられない会話では、作業を始めない": [
    { do: initial, by: "ユーザー", input: "質問" },
    { do: start, by: "アプリ", input: "続けられない", denied: "会話を続けられるときだけ（続けられないなら、先に新しい会話を始める）" },
  ],
  "元の項目がない作業（質問）には、追う項目が片付いた知らせを送らない": [
    { do: initial, by: "ユーザー", input: "質問" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: interrupt, by: "アプリ", denied: "追う元の項目がある作業だけ" },
  ],
  "アプリが始めるのは、Action Item をやる作業だけ（AI が自分で作業を始めない）": [
    { do: initial, by: "アプリ", input: "PR を直す", denied: "アプリが始めるのは、Action Item をやる作業だけ" },
  ],
  "AI は自分で作業を始めない": [{ do: initial, by: "AI", input: "質問", denied: "ユーザーか、Action Item から始めるアプリだけ" }],
  "作業中に PR が merge されたら、Claude Code がやめるか続けるかを判断する（続ける）": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: interrupt, by: "アプリ", expect: { status: "判断中", notified: true } },
    { do: decide, by: "AI", input: "続ける", expect: { status: "やっている" } },
    { do: interrupt, by: "アプリ", denied: "まだ知らせていないときだけ（続けると判断したら、もう知らせない）" },
    { do: succeed, by: "AI", expect: { status: "終わった" } },
  ],
  "作業中に PR が merge されたら、Claude Code がやめるか続けるかを判断する（やめる）": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: interrupt, by: "アプリ" },
    { do: decide, by: "AI", input: "やめる", expect: { status: "止まった", stopReason: "追う項目が片付いたのでやめた" } },
  ],
  "判断中にアプリを閉じたら、止まったことにする": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: interrupt, by: "アプリ" },
    { do: fail, by: "アプリ", input: "アプリを閉じた", expect: { status: "止まった" } },
  ],
  "判断の答えが返らなければ、うまくいかなかったのと同じに扱う": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: interrupt, by: "アプリ" },
    { do: decide, by: "AI", input: "答えが返らない", expect: { status: "止まった", stopReason: "決まった形の答えが返らない" } },
  ],
  "待ち行列のうちに追う項目が片付いたら、判断させずに取り消す": [
    { do: initial, by: "アプリ", input: "Action Item（読むだけ）" },
    { do: cancel, by: "AI", input: "片付いた", denied: "アプリかユーザーだけ" },
    { do: cancel, by: "アプリ", input: "片付いた", expect: { status: "取り消した" } },
    { do: start, by: "アプリ", input: "続けられる", denied: "待ち行列のときだけ" },
  ],
  "ユーザーが止める": [
    { do: initial, by: "ユーザー", input: "質問" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: stop, by: "AI", denied: "ユーザーだけ" },
    { do: stop, by: "ユーザー", expect: { status: "止まった", stopReason: "ユーザーが止めた" } },
    { do: succeed, by: "AI", denied: "やっているときだけ" },
  ],
  "アプリを閉じたら、止まったことにする": [
    { do: initial, by: "ユーザー", input: "質問" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: fail, by: "アプリ", input: "アプリを閉じた", expect: { status: "止まった", stopReason: "アプリを閉じた" } },
  ],
  "作業を進めるのは決まった人だけ": [
    { do: initial, by: "AI", input: "Action Item（読むだけ）", denied: "ユーザーか、Action Item から始めるアプリだけ" },
  ],
  "作業の段階を進めるのは決まった人だけ": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "AI", input: "続けられる", denied: "アプリだけ" },
    { do: start, by: "アプリ", input: "続けられる" },
    { do: succeed, by: "アプリ", denied: "AI だけ" },
    { do: fail, by: "ユーザー", input: "うまくいかなかった", denied: "AI かアプリだけ" },
    { do: interrupt, by: "AI", denied: "アプリだけ" },
    { do: decide, by: "AI", input: "やめる", denied: "判断中のときだけ" },
    { do: interrupt, by: "アプリ" },
    { do: decide, by: "アプリ", input: "やめる", denied: "AI だけ" },
    { do: interrupt, by: "アプリ", denied: "やっているときだけ" },
  ],
  "やり遂げられるのは、やっているときだけ": [
    { do: initial, by: "ユーザー", input: "質問" },
    { do: succeed, by: "AI", denied: "やっているときだけ" },
    { do: fail, by: "AI", input: "うまくいかなかった", denied: "やっている・判断中のときだけ" },
  ],
};

export const reviewed = {
  "unused-field:result": "結果（回答・報告・差分）はユーザーに見せるもので、操作の可否は変えない。終わったときだけあることを、不変条件で確かめるために読んでいる",
  "same-for-similar-actors:fail": "うまくいかなかったことには Claude Code が、アプリを閉じて止まったことにはアプリが気づく。どちらでも止まったになり、理由で分ける",
  "same-for-similar-actors:cancel": "待ち行列の作業は、追う項目が片付いたらアプリが、要らなくなったらユーザーが取り消す。どちらでも取り消したになる",
};

export const questions = [
];
