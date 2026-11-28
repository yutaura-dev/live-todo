import { ensure } from "@yutaura/live-spec";

/**
 * Account（Source のアカウント 1 つ。会社の GitHub・私用の Gmail・会社の Slack のワークスペース など）。
 * Source Item・見張る対象・書き込みは、どのアカウントのものかを accountId で指す。
 * つながっているかだけを持つ。どの AI に送るかは AI Settings（PC に 1 つ）が決め、アカウントごとには持たない（ADR-0022）。
 * 外しても、取り込んだ Source Item は消さない（そのまま残り、もう新しくは取り込まない）。それを持つ Task もそのまま。
 * アカウントは origin（URI の頭の部分: scheme と authority）で外の世界のアカウントを表す。Source Item の uri は、アカウントの origin にパスを続けたものになる（gmail://me@gmail.com/thread/18c2f）。
 * ID は使い回さない。同じ origin のアカウントは 1 つだけで、外したアカウントと同じ origin で足そうとしたら、前のアカウントに戻す（前の ID のまま、前の Source Item・Task・見張りの記録を引き継ぎ、同期は続きから取り込む）。origin が違えば新しい ID で足し、前の記録とは混ざらない。
 */
export type Account = {
  /** つながっているか */
  status: Status;
  /** アカウントを見分ける ID（github-work・gmail-private など） */
  id: string;
  /**
   * 外の世界のアカウントを表す URI の頭の部分（scheme と authority）。作ったあと変わらない
   * - scheme: どの Source か（gmail・github・slack …）
   * - authority: 外の世界でのアカウント。同じホストに複数のログインを持てる Source（GitHub など）は、ユーザー名@ホストにする
   * 例: gmail://me@gmail.com・github://yutaura@github.com・slack://acme.slack.com
   */
  origin: string;
  /** 画面に出す名前 */
  label: string;
  /** 取り込む範囲（GitHub のリポジトリ・Slack のチャンネル など。Source ごとに形が違う） */
  scope: unknown;
  /** つなぎ直しが要るときの理由 */
  problem: Problem | null;
};

export const Problem = {
  /** トークンの期限が切れた */
  tokenExpired: "トークンが切れた",
  /** 権限が外された（アプリの許可を取り消された など） */
  permissionRevoked: "権限が外された",
  /** ブラウザでログアウトした・セッションが切れた（Slack・Notion） */
  sessionExpired: "セッションが切れた",
  /** 取り込む範囲を広げて権限が増えたので、サインインし直しが要る（Microsoft。ADR-0017） */
  permissionIncreased: "権限を増やした",
} as const;
export type Problem = (typeof Problem)[keyof typeof Problem];

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
export function initial(actor: Actor, sameOrigin: "同じ origin のアカウントはない" | "外したアカウントと同じ origin" | "足しているアカウントと同じ origin"): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(sameOrigin === "同じ origin のアカウントはない", "同じ origin のアカウントがないときだけ（外したアカウントと同じなら戻す。足しているアカウントと同じなら足せない）");
  return { status: "つないでいない", id: "github-work", origin: "github://yutaura@github.com", label: "会社の GitHub", scope: null, problem: null };
}

/** 外したアカウントと同じ origin で足そうとしたので、前のアカウントに戻す（前の ID のまま。つなぎ直すと、同期は続きから取り込む） */
export function restore(account: Account, actor: Actor): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status === "外した", "外したときだけ");
  return { ...account, status: "つないでいない" };
}

/** つなぐ（認証して、通ったときだけ） */
export function connect(account: Account, actor: Actor, check: "通った" | "通らない"): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status === "つないでいない" || account.status === "つなぎ直しが要る", "つないでいない・つなぎ直しが要るときだけ");
  ensure(check === "通った", "認証が通ったときだけ");
  return { ...account, status: "つないでいる", problem: null };
}

/** トークンが通らなかった（切れた・権限が外された・セッションが切れた） */
export function reject(account: Account, actor: Actor, problem: Exclude<Problem, "権限を増やした">): Account {
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
  initial: { 新しい: ["同じ origin のアカウントはない"], 外したのと同じ: ["外したアカウントと同じ origin"], 足しているのと同じ: ["足しているアカウントと同じ origin"] },
  connect: { 通った: ["通った"], 通らない: ["通らない"] },
  reject: { トークンが切れた: ["トークンが切れた"], 権限が外された: ["権限が外された"], セッションが切れた: ["セッションが切れた"] },
  changeScope: { 変わらない: ["変わらない"], 権限が増える: ["権限が増える"] },
};

export const invariants = {
  "ID・origin は、作ったあと変わらない": (before: Account, after: Account) => before.id === after.id && before.origin === after.origin,
  "外したアカウントは、戻すことしかできない": (before: Account, after: Account) => before.status !== "外した" || after.status === "外した" || after.status === "つないでいない",
  "つなぎ直しが要るときだけ、理由がある": (account: Account) => (account.status === "つなぎ直しが要る") === (account.problem !== null),
};

export const links = [
  { from: connect, to: "sync", label: "つないだら、取り込む種類ごとに取り込みを始める（初めて）・止めていた取り込みを再開する" },
  { from: remove, to: "sync", action: "end", label: "このアカウントの取り込みをやめる" },
  { from: remove, to: "watch-target", label: "このアカウントの見張りをやめる" },
  { from: restore, to: "watch-target", label: "つなぎ直したら、このアカウントの見張りを続きから始める" },
  { from: reject, to: "watch-target", label: "つなぎ直すまで、このアカウントの見張りを止める" },
  { from: changeScope, to: "source-item", action: "remove", label: "範囲から外れた Source Item は、範囲の外になったとして消す" },
  { from: remove, to: "write", action: "withdraw", label: "このアカウントへの、確認中の書き込みを取りやめる" },
  { from: remove, to: "write", label: "このアカウントへの、書き込み中・書けたか分からない書き込みは、外を確かめられないので失敗にする（理由: アカウントを外した）" },
  { from: reject, to: "write", label: "このアカウントへの、確認中の書き込みは残す。つなぎ直すまで承認だけできない（書き込める状態でないので）。つなぎ直したら、見せた版のままなら承認できる" },
];

export const scenarios = {
  "アカウントを足して、つなぎ、トークンが切れたらつなぎ直す": [
    { do: initial, by: "ユーザー", input: "新しい", expect: { status: "つないでいない" } },
    { do: connect, by: "ユーザー", input: "通らない", denied: "認証が通ったときだけ" },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる" } },
    { do: connect, by: "ユーザー", input: "通った", denied: "つないでいない・つなぎ直しが要るときだけ" },
    { do: reject, by: "ユーザー", input: "トークンが切れた", denied: "同期・アプリだけ" },
    { do: reject, by: "同期", input: "トークンが切れた", expect: { status: "つなぎ直しが要る", problem: "トークンが切れた" } },
    { do: reject, by: "同期", input: "トークンが切れた", denied: "つないでいるときだけ" },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる", problem: null } },
  ],
  "Microsoft で権限が増える範囲に広げたら、サインインし直す": [
    { do: initial, by: "ユーザー", input: "新しい" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: changeScope, by: "ユーザー", input: "権限が増える", expect: { status: "つなぎ直しが要る", problem: "権限を増やした" } },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる" } },
  ],
  "Slack のセッションが切れたら、つなぎ直す": [
    { do: initial, by: "ユーザー", input: "新しい" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: reject, by: "アプリ", input: "セッションが切れた", expect: { status: "つなぎ直しが要る", problem: "セッションが切れた" } },
  ],
  "外したアカウントは、もう使わない": [
    { do: initial, by: "ユーザー", input: "新しい" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: changeScope, by: "ユーザー", input: "変わらない", expect: { status: "つないでいる" } },
    { do: remove, by: "ユーザー", expect: { status: "外した" } },
    { do: remove, by: "ユーザー", denied: "外していないときだけ" },
    { do: changeScope, by: "ユーザー", input: "変わらない", denied: "外していないときだけ" },
    { do: connect, by: "ユーザー", input: "通った", denied: "つないでいない・つなぎ直しが要るときだけ" },
  ],
  "同じアカウントを足し直したら、前のアカウントに戻して記録を引き継ぐ": [
    { do: initial, by: "ユーザー", input: "新しい" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: restore, by: "ユーザー", denied: "外したときだけ" },
    { do: remove, by: "ユーザー" },
    { do: restore, by: "同期", denied: "ユーザーだけ" },
    { do: restore, by: "ユーザー", expect: { status: "つないでいない" } },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる" } },
  ],
  "外したアカウントと同じ origin では、新しく足さない（戻す）": [
    { do: initial, by: "ユーザー", input: "外したのと同じ", denied: "同じ origin のアカウントがないときだけ（外したアカウントと同じなら戻す。足しているアカウントと同じなら足せない）" },
  ],
  "足しているアカウントと同じ origin は、足せない": [
    { do: initial, by: "ユーザー", input: "足しているのと同じ", denied: "同じ origin のアカウントがないときだけ（外したアカウントと同じなら戻す。足しているアカウントと同じなら足せない）" },
  ],
  "アカウントを足すのはユーザーだけ": [{ do: initial, by: "同期", input: "新しい", denied: "ユーザーだけ" }],
  "アカウントを変えるのはユーザーだけ": [
    { do: initial, by: "ユーザー", input: "新しい" },
    { do: connect, by: "同期", input: "通った", denied: "ユーザーだけ" },
    { do: changeScope, by: "同期", input: "変わらない", denied: "ユーザーだけ" },
    { do: remove, by: "同期", denied: "ユーザーだけ" },
  ],
};

export const reviewed = {
  "unused-field:origin": "origin は、足すときに同じアカウントを探すのに使う（足す操作の入力で表す）。Source Item の uri の頭の部分にもなる。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "indistinguishable-actor:同期,アプリ": "同期（取りに行く）とアプリ（書き込み・見張り）のどちらが、トークンが通らないことに気づいても、つなぎ直しが要るになる",
  "unused-field:id": "アカウントを見分ける値・どの Source かは、ほかの spec が指すためのもので、操作の可否は変えない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "equivalent-states:つないでいない · problem=なし/つなぎ直しが要る · トークンが切れた/つなぎ直しが要る · 権限が外された/つなぎ直しが要る · セッションが切れた/つなぎ直しが要る · 権限を増やした": "まだつないでいないのと、つなぎ直しが要る（理由ごと）のは、できること（つなぐ・外す・範囲を変える）は同じで、同期・見張り・書き込みを止めていることも同じ。違うのはユーザーに見せる案内（初めての認証か、つなぎ直しの理由）",
};

