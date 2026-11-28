import { ensure } from "@yutaura/live-spec";

/**
 * Agent Run（AI に任せた作業 1 回）。Agent Thread の中にあり、Agent Thread を通してだけ扱う。
 * 作業: 質問に答える・計画を考える・Action Item をやる・依存の更新を調べる・PR を直す・コンフリクトを直す。ユーザーが頼むことも、AI が先回りして始めること（Pre-work）もある。
 * Claude Code は外に書き込まない（ADR-0012・0013）。書き込みは、許可しないコマンド・渡さない認証情報・sandbox の 3 つを重ねて止める。外への書き込み（push・返信・merge など）は、結果から計画に Action Item を足し、ユーザーが確かめて承認する（Write）。
 * Claude Code は、どの LLM Profile を選んでいても Anthropic に送る。そのため、Task の事実のアカウントがどれも Claude Code を使うのを有効にしているときだけ、作業を始められる。
 * merge を承認して走る処理は、merge 自体が目的なので Agent Run ではない（追う項目が片付いても知らせない。ADR-0016）。
 */
export type AgentRun = {
  /** 作業の段階 */
  status: Status;
  /**
   * 渡す道具
   * - 読むだけ: ファイルを読む・探す、Web の検索とページ、gws と gh の読むだけのコマンド（Claude Code を有効にしたアカウントだけ）。編集の道具は渡さない（ADR-0013）
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
  /** だれが始めたか */
  trigger: "ユーザーが頼んだ" | "先回り";
  /** 調べたときの元の項目（PR の head の commit など。質問のように元の項目がなければ null）。変わったら調べ直す。push を頼むときの版（Write の version）にし、直し始めたときから動いていないことを確かめる */
  subjectFingerprint: string | null;
  /** 追う項目が片付いたことを、もう知らせたか（知らせるのは 1 回だけ） */
  notified: boolean;
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
  /** 途中で止まった・やめた・うまくいかなかった（理由を残す。Task は AI の作業が終わったことになる。列は AI の作業では変わらない） */
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
export function initial(actor: Actor, kind: Kind, accounts: "すべて有効" | "有効でないアカウントがある"): AgentRun {
  ensure(actor.kind === "user" || actor.kind === "agent", "ユーザーか、先回りする AI だけ");
  ensure(accounts === "すべて有効", "Task の事実のアカウントが、どれも Claude Code を使うのを有効にしているときだけ");
  return {
    status: "待ち行列",
    tools: FIXES.includes(kind) ? "直す" : "読むだけ",
    id: "ar1",
    kind,
    actionItemId: kind === "Action Item をやる" ? "a2" : null,
    sessionId: "s1",
    trigger: actor.kind === "user" ? "ユーザーが頼んだ" : "先回り",
    subjectFingerprint: kind === "質問に答える" ? null : "abc1234",
    notified: false,
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

/** うまくいかなかった・アプリを閉じて止まった（判断中に閉じたときも） */
export function fail(run: AgentRun, actor: Actor, reason: "うまくいかなかった" | "アプリを閉じた"): AgentRun {
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
  return { ...run, status: "判断中", notified: true };
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
  initial: {
    質問: ["質問に答える", "すべて有効"],
    "PR を直す": ["PR を直す", "すべて有効"],
    コンフリクト: ["コンフリクトを直す", "すべて有効"],
    計画: ["計画を考える", "すべて有効"],
    "Action Item": ["Action Item をやる", "すべて有効"],
    依存の更新: ["依存の更新を調べる", "すべて有効"],
    有効でないアカウント: ["質問に答える", "有効でないアカウントがある"],
  },
  fail: { うまくいかなかった: ["うまくいかなかった"], アプリを閉じた: ["アプリを閉じた"] },
  decide: { やめる: ["やめる"], 続ける: ["続ける"], 答えが返らない: ["答えが返らない"] },
};

const FINISHED: Status[] = ["終わった", "止まった", "取り消した"];

export const invariants = {
  "終わった作業は、もう変わらない": (before: AgentRun, after: AgentRun) => !FINISHED.includes(before.status) || before.status === after.status,
  "止まったときだけ、止まった理由がある": (run: AgentRun) => (run.status === "止まった") === (run.stopReason !== null),
  "渡す道具は、作ったあと変わらない": (before: AgentRun, after: AgentRun) => before.tools === after.tools,
  "終わったときだけ、結果がある": (run: AgentRun) => (run.status === "終わった") === (run.result !== null),
};

export const links = [
  { from: start, to: "task", action: "startWork", label: "Task を AI が作業中にする（待ち行列のあいだは作業中にしない）" },
  { from: succeed, to: "task", label: "AI の作業が終わる（finishWork）。Action Item をやる作業なら、その Action Item を果たす。外への書き込み（push・返信など）が要るなら、計画に書き込みで果たされる Action Item を足す（ユーザーが確かめて承認する。push の版はこの作業の元の項目）" },
  { from: fail, to: "task", label: "AI の作業が終わったことにする。Action Item をやる作業なら、報告だけ残して済ませない" },
  { from: stop, to: "task", label: "AI の作業が終わったことにする。Action Item をやる作業なら、報告だけ残して済ませない" },
  { from: decide, to: "task", label: "やめたなら、片付いた追う項目を事実の変化として受け取り、やめた理由を変化として残す。答えが返らないなら、AI の作業が終わったことにする" },
  { from: cancel, to: "task", label: "AI の作業を始めないまま終わる。追う項目が片付いたなら、事実の変化として受け取る" },
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
  "作業中に PR が merge されたら、Claude Code がやめるか続けるかを判断する（続ける）": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "アプリ" },
    { do: interrupt, by: "アプリ", expect: { status: "判断中", notified: true } },
    { do: decide, by: "AI", input: "続ける", expect: { status: "やっている" } },
    { do: interrupt, by: "アプリ", denied: "まだ知らせていないときだけ（続けると判断したら、もう知らせない）" },
    { do: succeed, by: "AI", expect: { status: "終わった" } },
  ],
  "作業中に PR が merge されたら、Claude Code がやめるか続けるかを判断する（やめる）": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "アプリ" },
    { do: interrupt, by: "アプリ" },
    { do: decide, by: "AI", input: "やめる", expect: { status: "止まった", stopReason: "追う項目が片付いたのでやめた" } },
  ],
  "判断中にアプリを閉じたら、止まったことにする": [
    { do: initial, by: "ユーザー", input: "PR を直す" },
    { do: start, by: "アプリ" },
    { do: interrupt, by: "アプリ" },
    { do: fail, by: "アプリ", input: "アプリを閉じた", expect: { status: "止まった" } },
  ],
  "Claude Code を有効にしていないアカウントの事実を持つ Task では、作業を始めない": [
    { do: initial, by: "AI", input: "有効でないアカウント", denied: "Task の事実のアカウントが、どれも Claude Code を使うのを有効にしているときだけ" },
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
  {
    ask: "AI が先回りして始めてよい作業はどこまでか？（今の spec はどの作業も先回りで始められる。PR を直す・コンフリクトを直すは、直したあと push の承認が要るので外には書き込まないが、作業場所と費用を使い、作業場所の中ではパッケージのインストールスクリプトが動く）",
    about: initial,
  },
  {
    ask: "Claude Code（Anthropic）を、会社が許可した LLM とみなすか？ Claude Code は LLM Profile に関係なく Anthropic に送る。今の spec は、Task の事実のアカウントがどれも Claude Code を有効にしているときだけ始める（アカウントごとに決める）。会社のアカウントで有効にしてよいかは、LLM Profile・Account の未決事項と一緒に決めたい",
    about: initial,
  },
  {
    ask: "Action Item の進み具合（progress.claude.run）と、Agent Run の段階が、同じことを 2 か所で持っている。案: Action Item には Agent Run の参照だけを持たせ、段階は Agent Run を正本にする（Task 集約の不変条件「Claude Code がやっている Action Item があれば作業中」は、Agent Run を見て確かめる）",
    about: start,
  },
];
