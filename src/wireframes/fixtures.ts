import type { WireTask } from "./model.js";

/** ワイヤーフレームで見せる「今」。サンプルの時刻はすべてこの日の朝を基準にする */
export const TODAY = "11月28日（土）";

const seen = "2026-11-28T00:00:00Z";
const earlier = "2026-11-27T23:00:00Z";
const later = "2026-11-28T00:40:00Z";

export const tasks: WireTask[] = [
  {
    id: 101,
    title: "請求書の承認申請を出す",
    brief: "経理の締めが今日 17 時。申請フォームの下書きは AI が作ってある",
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "今すぐ", reason: "期日まで 0 日で、手間が 1 日" },
    blocksOthers: false,
    sources: ["gmail", "notion"],
    now: [{ title: "下書きを確かめて申請を出す", how: "human" }],
    lastSeenAt: seen,
    history: [{ by: "AI", field: "計画", occurredAt: later, summary: "申請の下書きを作った" }],
  },
  {
    id: 102,
    title: "認証まわりの PR をレビューする",
    brief: "変更は 12 ファイル。AI が気になる点を 3 つ挙げている",
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "今すぐ", reason: "PR のレビューを待たれていて、相手は今日リリースしたい" },
    blocksOthers: true,
    sources: ["github", "slack"],
    now: [{ title: "AI の指摘を見て、レビューを書く", how: "human" }],
    lastSeenAt: null,
    history: [],
  },
  {
    id: 103,
    title: "依存更新の PR を確かめて merge する",
    brief: "CI は通過。破壊的変更はないと AI が判断した",
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "今日中", reason: "PR のレビューを待たれている" },
    blocksOthers: true,
    sources: ["github"],
    now: [{ title: "merge する", how: "write" }],
    lastSeenAt: seen,
    history: [{ by: "AI", field: "Action Item の進み", occurredAt: later, summary: "CI が通るのを待つ、が済んだ" }],
  },
  {
    id: 104,
    title: "来週の定例のアジェンダに返事をする",
    brief: "火曜 10 時の案に返事をするだけ。返信の下書きは AI が作ってある",
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "今日中", reason: "返信するだけで、相手が待っている" },
    blocksOthers: true,
    sources: ["slack"],
    now: [{ title: "返信の下書きを確かめて送る", how: "write" }],
    lastSeenAt: seen,
    history: [],
  },
  {
    id: 105,
    title: "本番の障害の原因を調べる",
    brief: "Claude Code がログを読んでいる",
    status: "todo",
    work: "作業中",
    priority: { status: "アプリが決めた", level: "今すぐ", reason: "本番で決済が失敗していて、自分がブロッカーになっている" },
    blocksOthers: true,
    sources: ["slack", "github"],
    now: [
      { title: "ログから原因を調べる", how: "claude", working: true },
      { title: "影響範囲を #incident で聞く", how: "human" },
      { title: "監視のアラートが収まる", how: "condition" },
    ],
    lastSeenAt: seen,
    history: [],
  },
  {
    id: 106,
    title: "年末調整の書類を出す",
    brief: "源泉徴収票が届くのを待っている",
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "3 日以内", reason: "期日まで 5 日で、待つ見込みが 2 日" },
    blocksOthers: false,
    sources: ["gmail"],
    now: [{ title: "源泉徴収票が届くのを待つ", how: "condition" }],
    lastSeenAt: seen,
    history: [],
  },
  {
    id: 107,
    title: "conflict した PR を直す",
    brief: "Claude Code が直した差分が、push の確認を待っている",
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "3 日以内", reason: "期日まで 4 日" },
    blocksOthers: false,
    sources: ["github"],
    now: [{ title: "直した差分を確かめて push する", how: "write" }],
    lastSeenAt: earlier,
    history: [{ by: "AI", field: "AI の作業", occurredAt: seen, summary: "conflict を直し終えた" }],
  },
  {
    id: 108,
    title: "勉強会の発表テーマを決める",
    brief: "候補は 3 つ。去年の傾向を AI が書き出してある",
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "10 日以内", reason: "期日まで 9 日" },
    blocksOthers: false,
    sources: ["notion"],
    now: [{ title: "テーマを 2 つから選ぶ", how: "decision" }],
    lastSeenAt: seen,
    history: [],
  },
  {
    id: 109,
    title: "経費の領収書をまとめる",
    brief: "11 月分の領収書が 4 枚。期日がメールから読み取れなかった",
    status: "todo",
    work: "なし",
    priority: { status: "ラベル未定" },
    blocksOthers: false,
    sources: ["manual"],
    now: [{ title: "領収書をアップロードする", how: "human" }],
    lastSeenAt: seen,
    history: [],
  },
  {
    id: 110,
    title: "古いブランチを整理する",
    brief: null,
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "30 日以内", reason: "期日はないが、手間が少ない" },
    blocksOthers: false,
    sources: ["github"],
    now: [{ title: "消してよいブランチを確かめる", how: "human" }],
    lastSeenAt: seen,
    history: [],
  },
  {
    id: 111,
    title: "社内 wiki の手順書を直す",
    brief: null,
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "30 日以内", reason: "期日まで 25 日" },
    blocksOthers: false,
    sources: ["notion"],
    now: [],
    lastSeenAt: seen,
    history: [],
  },
  {
    id: 113,
    title: "契約更新のお知らせを確かめる",
    brief: "AI は自分の対応が要るか決めきれなかった",
    status: "needs_review",
    work: "なし",
    priority: { status: "アプリが決めた", level: "3 日以内", reason: "期日まで 6 日" },
    blocksOthers: false,
    sources: ["gmail"],
    now: [{ title: "更新するか決める", how: "decision" }],
    lastSeenAt: null,
    history: [],
  },
  {
    id: 112,
    title: "来年の目標を書く",
    brief: null,
    status: "todo",
    work: "なし",
    priority: { status: "アプリが決めた", level: "それより先でよい", reason: "期日まで 40 日" },
    blocksOthers: false,
    sources: ["manual"],
    now: [],
    lastSeenAt: seen,
    history: [],
  },
];

/**
 * 振り分けを待っている事実（specs/routing.spec.ts の「ユーザー待ち」）。AI が迷った（確率が中間・refusal）ので、どの Task にも入れていない。
 * ユーザーは、新しい Task にする・既存の Task の事実にする・対象外にする、のどれかを選ぶ。
 */
export type RoutingItem = {
  id: number;
  source: string;
  title: string;
  from: string;
  lines: string[];
  /** 元の文面の抜粋 */
  excerpt: string;
  judgment: { kind: "確率"; probability: number } | { kind: "判定できなかった" };
  /** 候補の Task（AI が絞ったもの） */
  candidates: Array<{ taskId: number; title: string }>;
};

export const routingItems: RoutingItem[] = [
  {
    id: 201,
    source: "slack",
    title: "#dev-infra でメンションされた: 来週のメンテ時間について",
    from: "Slack のメンション",
    lines: ["種類: スレッド", "あなたへのメンション: あり"],
    excerpt: "@yutaura 来週のメンテ、火曜の夜で大丈夫そうですか？ 障害対応の続きと重なるなら水曜にずらします",
    judgment: { kind: "確率", probability: 0.62 },
    candidates: [{ taskId: 105, title: "本番の障害の原因を調べる" }],
  },
  {
    id: 202,
    source: "gmail",
    title: "【ご確認】契約更新のお知らせ（2 通目）",
    from: "Gmail の受信箱",
    lines: ["種類: スレッド", "未読: あり"],
    excerpt: "契約は 12 月 31 日で自動更新されます。変更がある場合は 12 月 10 日までにご連絡ください",
    judgment: { kind: "判定できなかった" },
    candidates: [{ taskId: 113, title: "契約更新のお知らせを確かめる" }],
  },
  {
    id: 203,
    source: "github",
    title: "issue #318 に自分がアサインされた",
    from: "GitHub の通知",
    lines: ["種類: Issue", "状態: 開いている", "あなたへのアサイン: あり"],
    excerpt: "ログイン画面で、パスワードの表示切り替えがキーボードで操作できない",
    judgment: { kind: "確率", probability: 0.48 },
    candidates: [],
  },
];

/**
 * あなたが頼むのを待っている書き込み。書き込みで果たす Action Item に番が来ていて、自動では書き込まないもの。
 * 頼むと、中身を見せる書き込み（specs/write.spec.ts の「確認中」）ができる。
 */
export type WriteRequest = {
  id: number;
  taskId: number;
  taskTitle: string;
  /** 操作の名前（provider が決める） */
  operation: string;
  /** ボタンに書く動詞（「merge する」） */
  verb: string;
  target: string;
  source: string;
  /** 自動で書き込まない理由（判断表「自動でやってよいか」の答え） */
  whyNotAuto: string;
  /** 確認するときに見せる説明（provider が中身から作る） */
  summary: string;
  /** 書き込む中身（差分・本文） */
  content: string[];
};

export const writeRequests: WriteRequest[] = [
  {
    id: 301,
    taskId: 103,
    taskTitle: "依存更新の PR を確かめて merge する",
    operation: "PR を merge する",
    verb: "merge する",
    target: "acme/web#482",
    source: "github",
    whyNotAuto: "PR の merge は、自動でやってよい範囲を決めていません",
    summary: "squash で merge する",
    content: ["chore(deps): bump vite from 8.3.7 to 8.3.8 (#482)", "1 commit・変更 2 ファイル（package.json・pnpm-lock.yaml）"],
  },
  {
    id: 302,
    taskId: 104,
    taskTitle: "来週の定例のアジェンダに返事をする",
    operation: "スレッドに返信する",
    verb: "返信する",
    target: "#team-weekly のスレッド",
    source: "slack",
    whyNotAuto: "Slack への返信は、下書きまでを自動にしています",
    summary: "「火曜の 10 時で大丈夫です」と返信する",
    content: ["火曜の 10 時で大丈夫です。アジェンダの 3 つ目（来期の体制）は、資料を前日までに共有します。"],
  },
];

/** 書き込めなかった・書けたか分からない書き込み（specs/write.spec.ts の「失敗」「書けたか分からない」） */
export type WriteTrouble = {
  id: number;
  taskId: number;
  taskTitle: string;
  operation: string;
  target: string;
  source: string;
  stage: "失敗" | "書けたか分からない";
  failure?: { kind: "権限が足りない" | "書き込み先のエラー" | "書けていなかった"; message: string };
};

export const writeTroubles: WriteTrouble[] = [
  {
    id: 303,
    taskId: 107,
    taskTitle: "conflict した PR を直す",
    operation: "直した commit を push する",
    target: "acme/api の feature/billing",
    source: "github",
    stage: "失敗",
    failure: { kind: "権限が足りない", message: "GitHub のトークンに workflow の権限がありません。設定でトークンを入れ直すと書き込めます" },
  },
  {
    id: 304,
    taskId: 114,
    taskTitle: "週報を送る",
    operation: "メールを送る",
    target: "チームの週報のスレッド",
    source: "gmail",
    stage: "書けたか分からない",
  },
];

/** 自動でやってよい範囲で、承認なしに書き込んだもの。なぜ書き込んだかを、そのときの範囲と一緒に残す */
export const autoWrites = [
  { at: "8:12", what: "acme/web#477 を直す draft の PR を作った", policy: "PR を作る: 外への書き込み（下書き）まで" },
  { at: "7:55", what: "#team-weekly のスレッドに返信の下書きを作った", policy: "スレッドに返信する: 外への書き込み（下書き）まで" },
];

/** 定期の Task の予告（次の回の作る日が近い。本当の Task ではない） */
export const recurringPreviews = [{ ruleId: 1, title: "経費の領収書をまとめる（12 月分）", createOn: "12 月 2 日" }];
