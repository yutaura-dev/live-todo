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
    drivenBy: "リリースに入れられるか返事をする（Slack から足した）",
    now: [
      { title: "AI の指摘を見て、レビューを書く", how: "human" },
      { title: "リリースに入れられるか返事をする", how: "write" },
    ],
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

/** 提案のもとになった事実（元の文面の抜粋つき） */
export type ProposalFact = { source: string; title: string; from: string; excerpt: string };

/**
 * Task の提案（specs/task-proposal.spec.ts）。AI が決めきれなかった（確率が中間）ので、自動では Task にも計画にもしていないもの。提案は Task ではない。
 * 受け入れる・別の形で受け入れる・見送るのどれかをユーザーが選ぶ。関係する事実が続けて届くと同じ提案に足され、確信が上がれば AI が自動で受け入れる。
 */
export type ProposalView = {
  id: number;
  kind: "新しい Task" | "既存の Task に足す" | "切り出す";
  status: "提案中" | "見送った";
  /** 作る Task の題・足す（切り出す）Action Item の題 */
  title: string;
  /** なぜ提案するか（Generation が書く） */
  brief: string;
  /** 作る Task の計画の案・足す（切り出す）Action Item の並び */
  plan: string[];
  /** 寄せ先の Task（足す・切り出す提案のとき） */
  target?: { taskId: number; title: string };
  facts: ProposalFact[];
};

export const proposals: ProposalView[] = [
  {
    id: 401,
    kind: "既存の Task に足す",
    status: "提案中",
    title: "影響を受けたユーザーに連絡する",
    brief: "障害対応と一緒に終わる作業に見えるが、連絡は障害が直ったあとになるかもしれず、AI は決めきれなかった",
    plan: ["影響を受けたユーザーの一覧を出す", "お詫びと経緯の連絡文を書く", "連絡を送る"],
    target: { taskId: 105, title: "本番の障害の原因を調べる" },
    facts: [{ source: "gmail", title: "【CS】決済エラーの影響ユーザーへの連絡について", from: "Gmail の受信箱", excerpt: "影響のあったお客様への連絡はどうしましょうか。今日中に方針だけでも決めたいです" }],
  },
  {
    id: 402,
    kind: "新しい Task",
    status: "提案中",
    title: "監視の仕組みを見直す",
    brief: "障害の振り返りで、来月までに見直すことになった。障害対応が終わっても残る作業なので、別の Task にするとよさそう",
    plan: ["今のアラートを書き出す", "見直し案をまとめる", "#infra で合意を取る"],
    facts: [{ source: "slack", title: "#incident のスレッド", from: "Slack のスレッド", excerpt: "今回アラートが鳴るのが遅かったので、来月までに監視を見直しましょう。@yutaura 案をお願いできますか" }],
  },
  {
    id: 403,
    kind: "新しい Task",
    status: "提案中",
    title: "契約を更新するか決める",
    brief: "契約は 12 月 31 日に自動で更新される。変えるなら 12 月 10 日までに連絡が要る。自分の対応が要るか、AI は決めきれなかった",
    plan: ["今の契約の使い方を確かめる", "更新するか決める", "変えるなら先方に連絡する"],
    facts: [
      { source: "gmail", title: "【ご確認】契約更新のお知らせ", from: "Gmail の受信箱", excerpt: "契約は 12 月 31 日で自動更新されます。変更がある場合は 12 月 10 日までにご連絡ください" },
      { source: "gmail", title: "【ご確認】契約更新のお知らせ（2 通目）", from: "Gmail の受信箱", excerpt: "先日ご案内した契約更新の件、改めてご連絡いたします" },
    ],
  },
  {
    id: 404,
    kind: "切り出す",
    status: "提案中",
    title: "README の古い手順を直す",
    brief: "PR は merge できる状態で完了条件を満たしたが、レビューのコメントから足した「README の古い手順を直す」がまだ残っている。PR とは別に終わる作業なので、切り出すとよさそう",
    plan: ["README の古い手順を直す"],
    target: { taskId: 103, title: "依存更新の PR を確かめて merge する" },
    facts: [{ source: "github", title: "acme/web#482 のレビューコメント", from: "GitHub の PR", excerpt: "README の古い手順は別の PR で直してください" }],
  },
  {
    id: 405,
    kind: "新しい Task",
    status: "見送った",
    title: "勉強会の告知に返信する",
    brief: "勉強会の告知に「参加します」と返信するとよさそう",
    plan: ["参加の返信をする"],
    facts: [{ source: "slack", title: "#general の勉強会の告知", from: "Slack のチャンネル", excerpt: "来週の勉強会、参加できる人はスレッドに一言お願いします" }],
  },
];

/**
 * AI が見たのに決められなかった事実（specs/routing.spec.ts の「ユーザー待ち」。refusal・答えが形に合わない）。
 * どの Task にも入れておらず、提案にもできなかった。新しい Task にする・既存の Task に入れる・対象外にするを、ユーザーが選ぶ。
 */
export type UndecidedFact = {
  id: number;
  source: string;
  title: string;
  from: string;
  excerpt: string;
  /** 候補の Task（AI が絞ったもの。判定はできなかった） */
  candidates: Array<{ taskId: number; title: string }>;
};

export const undecidedFacts: UndecidedFact[] = [
  {
    id: 202,
    source: "gmail",
    title: "健康診断の再検査のご案内",
    from: "Gmail の受信箱",
    excerpt: "先日の健康診断の結果、再検査の対象となりました。12 月中に指定の医療機関で受診してください",
    candidates: [],
  },
];

/** AI が自動でしたこと（確信が高く、自動で Task を作った・計画に足した）。寄せたことに気づけるように、提案の画面に閉じて残す */
export const autoActions = [
  { at: "8:40", kind: "計画に足した" as const, what: "「CI が落ちた」から、Task「依存更新の PR を確かめて merge する」の計画に「CI を直す」を足した" },
  { at: "8:15", kind: "計画に足した" as const, what: "Slack の「リリースに入れられる？」から、Task「認証まわりの PR をレビューする」の計画に「リリースに入れられるか返事をする」を足した" },
  { at: "8:02", kind: "Task を作った" as const, what: "issue #318 から、Task「パスワードの表示切り替えをキーボードで操作できるようにする」を作った" },
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
