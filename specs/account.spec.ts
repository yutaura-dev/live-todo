import { ensure } from "@yutaura/live-spec";

/**
 * Account（Source のアカウント 1 つ。会社の GitHub・私用の Gmail・会社の Slack のワークスペース など）。
 * Source Item・見張る対象・書き込みは、どのアカウントのものかを accountId で指す。
 * つながっているかだけを持つ。どの AI に送るかは AI Settings（PC に 1 つ）が決め、アカウントごとには持たない（ADR-0022）。
 * 外しても、取り込んだ Source Item は消さない（そのまま残り、もう新しくは取り込まない）。それを持つ Task もそのまま。
 * ID は使い回さない（足し直したら新しい ID）。前の Source Item・見張りの記録と混ざらないように。
 */
export type Account = {
  /** つながっているか */
  status: Status;
  /** アカウントを見分ける ID（github-work・gmail-private など） */
  id: string;
  /** どの Source か（github・slack・gmail・google-calendar・notion・microsoft） */
  source: string;
  /** 画面に出す名前 */
  label: string;
  /** 取り込む範囲（GitHub のリポジトリ・Slack のチャンネル など。Source ごとに形が違う） */
  scope: unknown;
  /** つなぎ直しが要るときの理由 */
  problem: Problem | null;
};

export type Problem = "トークンが切れた" | "権限が外された" | "セッションが切れた" | "権限を増やした";

export const Status = {
  /** 設定に足したが、まだつないでいない（認証していない） */
  notConnected: "つないでいない",
  /** つないでいる。同期・見張り・書き込みができる */
  connected: "つないでいる",
  /** トークンが切れた・権限が外された・セッションが切れた・権限を増やしたのでサインインし直しが要る。つなぎ直すまで、このアカウントの同期・見張り・書き込みは止める。回数の上限・ネットワークの失敗は、これにはせず、その回だけ取りやめて次の回にやり直す */
  needsReconnect: "つなぎ直しが要る",
  /** ユーザーが外した */
  removed: "外した",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "user" } | { kind: "sync" } | { kind: "app" };

/** 同期: Source を取りに行って、トークンが通らないことに気づく。アプリ: 書き込み・見張りで、トークンが通らないことに気づく */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
  アプリ: { kind: "app" },
};

/** アカウントを足す（会社の Slack は、管理者に確かめてから使うよう、足す画面で注意を出す。ADR-0010。確かめたかは条件にしない） */
export function initial(actor: Actor): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { status: "つないでいない", id: "github-work", source: "github", label: "会社の GitHub", scope: null, problem: null };
}

/** つなぐ（認証して、通ったときだけ） */
export function connect(account: Account, actor: Actor, check: "通った" | "通らない"): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status === "つないでいない" || account.status === "つなぎ直しが要る", "つないでいない・つなぎ直しが要るときだけ");
  ensure(check === "通った", "認証が通ったときだけ");
  return { ...account, status: "つないでいる", problem: null };
}

/** トークンが通らなかった（切れた・権限が外された・セッションが切れた） */
export function reject(account: Account, actor: Actor, problem: "トークンが切れた" | "権限が外された" | "セッションが切れた"): Account {
  ensure(actor.kind === "sync" || actor.kind === "app", "同期・アプリだけ");
  ensure(account.status === "つないでいる", "つないでいるときだけ");
  return { ...account, status: "つなぎ直しが要る", problem };
}

/**
 * 取り込む範囲を変える
 *
 * 範囲を広げるのに権限が増える（Microsoft で予定表も取り込む など。ADR-0017）なら、つなぎ直しが要る。範囲から外れた Source Item は、範囲の外になったとして消す。
 */
export function changeScope(account: Account, actor: Actor, permission: "権限が増える" | "変わらない"): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status !== "外した", "外していないときだけ");
  const scoped = { ...account, scope: { repositories: { include: ["acme/*"] } } };
  return permission === "権限が増える" && account.status === "つないでいる" ? { ...scoped, status: "つなぎ直しが要る", problem: "権限を増やした" } : scoped;
}

/** 外す（同期・見張りをやめ、確認中の書き込みを取りやめ、このアカウントのトークン・セッションを消す。取り込んだ Source Item は消さない） */
export function remove(account: Account, actor: Actor): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status !== "外した", "外していないときだけ");
  return { ...account, status: "外した", problem: null };
}

export const inputs = {
  connect: { 通った: ["通った"], 通らない: ["通らない"] },
  reject: { トークンが切れた: ["トークンが切れた"], 権限が外された: ["権限が外された"], セッションが切れた: ["セッションが切れた"] },
  changeScope: { 変わらない: ["変わらない"], 権限が増える: ["権限が増える"] },
};

export const invariants = {
  "ID・どの Source かは、作ったあと変わらない": (before: Account, after: Account) => before.id === after.id && before.source === after.source,
  "外したアカウントは、もう変わらない": (before: Account, after: Account) => before.status !== "外した" || after.status === "外した",
  "つなぎ直しが要るときだけ、理由がある": (account: Account) => (account.status === "つなぎ直しが要る") === (account.problem !== null),
};

export const links = [
  { from: remove, to: "watch-target", label: "このアカウントの見張りをやめる" },
  { from: reject, to: "watch-target", label: "つなぎ直すまで、このアカウントの見張りを止める" },
  { from: changeScope, to: "source-item", action: "remove", label: "範囲から外れた Source Item は、範囲の外になったとして消す" },
  { from: remove, to: "write", action: "withdraw", label: "このアカウントへの、確認中の書き込みを取りやめる" },
  { from: remove, to: "write", label: "このアカウントへの、書き込み中・書けたか分からない書き込みは、外を確かめられないので失敗にする（理由: アカウントを外した）" },
  { from: reject, to: "write", label: "このアカウントへの、確認中の書き込みは残す。つなぎ直すまで承認だけできない（書き込める状態でないので）。つなぎ直したら、見せた版のままなら承認できる" },
];

export const scenarios = {
  "アカウントを足して、つなぎ、トークンが切れたらつなぎ直す": [
    { do: initial, by: "ユーザー", expect: { status: "つないでいない" } },
    { do: connect, by: "ユーザー", input: "通らない", denied: "認証が通ったときだけ" },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる" } },
    { do: connect, by: "ユーザー", input: "通った", denied: "つないでいない・つなぎ直しが要るときだけ" },
    { do: reject, by: "ユーザー", input: "トークンが切れた", denied: "同期・アプリだけ" },
    { do: reject, by: "同期", input: "トークンが切れた", expect: { status: "つなぎ直しが要る", problem: "トークンが切れた" } },
    { do: reject, by: "同期", input: "トークンが切れた", denied: "つないでいるときだけ" },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる", problem: null } },
  ],
  "Microsoft で権限が増える範囲に広げたら、サインインし直す": [
    { do: initial, by: "ユーザー" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: changeScope, by: "ユーザー", input: "権限が増える", expect: { status: "つなぎ直しが要る", problem: "権限を増やした" } },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる" } },
  ],
  "Slack のセッションが切れたら、つなぎ直す": [
    { do: initial, by: "ユーザー" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: reject, by: "アプリ", input: "セッションが切れた", expect: { status: "つなぎ直しが要る", problem: "セッションが切れた" } },
  ],
  "外したアカウントは、もう使わない": [
    { do: initial, by: "ユーザー" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: changeScope, by: "ユーザー", input: "変わらない", expect: { status: "つないでいる" } },
    { do: remove, by: "ユーザー", expect: { status: "外した" } },
    { do: remove, by: "ユーザー", denied: "外していないときだけ" },
    { do: changeScope, by: "ユーザー", input: "変わらない", denied: "外していないときだけ" },
    { do: connect, by: "ユーザー", input: "通った", denied: "つないでいない・つなぎ直しが要るときだけ" },
  ],
  "アカウントを足すのはユーザーだけ": [{ do: initial, by: "同期", denied: "ユーザーだけ" }],
  "アカウントを変えるのはユーザーだけ": [
    { do: initial, by: "ユーザー" },
    { do: connect, by: "同期", input: "通った", denied: "ユーザーだけ" },
    { do: changeScope, by: "同期", input: "変わらない", denied: "ユーザーだけ" },
    { do: remove, by: "同期", denied: "ユーザーだけ" },
  ],
};

export const reviewed = {
  "indistinguishable-actor:同期,アプリ": "同期（取りに行く）とアプリ（書き込み・見張り）のどちらが、トークンが通らないことに気づいても、つなぎ直しが要るになる",
  "unused-field:id": "アカウントを見分ける値・どの Source かは、ほかの spec が指すためのもので、操作の可否は変えない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:source": "アカウントを見分ける値・どの Source かは、ほかの spec が指すためのもので、操作の可否は変えない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "equivalent-states:つないでいない · problem=なし/つなぎ直しが要る · トークンが切れた/つなぎ直しが要る · 権限が外された/つなぎ直しが要る · セッションが切れた/つなぎ直しが要る · 権限を増やした": "まだつないでいないのと、つなぎ直しが要る（理由ごと）のは、できること（つなぐ・外す・範囲を変える）は同じで、同期・見張り・書き込みを止めていることも同じ。違うのはユーザーに見せる案内（初めての認証か、つなぎ直しの理由）",
};

export const questions = [
  {
    ask: "外したアカウントと同じ外の世界での名前（メールアドレス・ログイン名・ワークスペース）で足そうとしたら、前のアカウントに戻して（前の ID のまま）、前の Source Item・Task・見張りの記録を引き継ぐか？ 今つないでいるアカウントと同じ名前は足せないようにするか？",
    about: initial,
  },
];
