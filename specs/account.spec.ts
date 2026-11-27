import { ensure } from "@yutaura/live-spec";

/**
 * Account（Source のアカウント 1 つ。会社の GitHub・私用の Gmail・会社の Slack のワークスペース など）。
 * Source Item・見張る対象・書き込みは、どのアカウントのものかを accountId で指す。
 * 会社のアカウントのデータは、会社が許可した LLM Profile にだけ送る（charter の前提と制約）。会社のアカウントには、会社のデータを送ってよい Profile しか選べない。
 */
export type Account = {
  /** つながっているか */
  status: Status;
  /** 会社のアカウントか、私用か。ユーザーが決め、作ったあと変わらない（変えるなら、外して足し直す） */
  owner: Owner;
  /** アカウントを見分ける ID（github-work・gmail-private など） */
  id: string;
  /** どの Source か */
  source: "github" | "slack" | "gmail" | "google-calendar" | "notion" | "microsoft";
  /** 画面に出す名前 */
  label: string;
  /** 使う LLM Profile（選ばなければ null で、既定の Profile を使う） */
  /** @ref llm-profile */
  llmProfileId: string | null;
  /** 取り込む範囲（GitHub のリポジトリ・Slack のチャンネル など。Source ごとに形が違う） */
  scope: unknown;
  /** つなぎ直しが要るときの理由 */
  problem: "トークンが切れた" | "権限が外された" | null;
};

export const Status = {
  /** 設定に足したが、まだつないでいない（認証していない） */
  notConnected: "つないでいない",
  /** つないでいる。同期・見張り・書き込みができる */
  connected: "つないでいる",
  /** トークンが切れた・権限が外された。つなぎ直すまで、このアカウントの同期・見張り・書き込みは止める */
  needsReconnect: "つなぎ直しが要る",
  /** ユーザーが外した */
  removed: "外した",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export const Owner = { company: "会社", personal: "私用" } as const;
export type Owner = (typeof Owner)[keyof typeof Owner];

/** 使う Profile（選ばなければ既定）が、会社のデータを送ってよいか */
type ProfileCheck = "会社に許可されている" | "会社に許可されていない";

type Actor = { kind: "user" } | { kind: "sync" };

/** 同期: Source を取りに行って、トークンが通らないことに気づく */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
};

/** アカウントを足す（会社か私用かと、使う Profile を決める） */
export function initial(actor: Actor, owner: Owner, profile: ProfileCheck): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(owner === "私用" || profile === "会社に許可されている", "会社のアカウントには、会社のデータを送ってよい Profile だけ");
  return {
    status: "つないでいない",
    owner,
    id: owner === "会社" ? "github-work" : "gmail-private",
    source: owner === "会社" ? "github" : "gmail",
    label: owner === "会社" ? "会社の GitHub" : "私用の Gmail",
    llmProfileId: owner === "会社" ? "work" : null,
    scope: null,
    problem: null,
  };
}

/** つなぐ（認証して、通ったときだけ） */
export function connect(account: Account, actor: Actor, check: "通った" | "通らない"): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status === "つないでいない" || account.status === "つなぎ直しが要る", "つないでいない・つなぎ直しが要るときだけ");
  ensure(check === "通った", "認証が通ったときだけ");
  return { ...account, status: "つないでいる", problem: null };
}

/** トークンが通らなかった（切れた・権限が外された） */
export function reject(account: Account, actor: Actor): Account {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(account.status === "つないでいる", "つないでいるときだけ");
  return { ...account, status: "つなぎ直しが要る", problem: "トークンが切れた" };
}

/** 使う Profile を替える */
export function changeProfile(account: Account, actor: Actor, profile: ProfileCheck): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status !== "外した", "外していないときだけ");
  ensure(account.owner === "私用" || profile === "会社に許可されている", "会社のアカウントには、会社のデータを送ってよい Profile だけ");
  return { ...account, llmProfileId: "work-2" };
}

/** 取り込む範囲を変える */
export function changeScope(account: Account, actor: Actor): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status !== "外した", "外していないときだけ");
  return { ...account, scope: { repositories: { include: ["acme/*"] } } };
}

/** 外す（同期・見張りをやめ、確認中の書き込みを取りやめる） */
export function remove(account: Account, actor: Actor): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status !== "外した", "外していないときだけ");
  return { ...account, status: "外した", problem: null };
}

export const inputs = {
  initial: {
    会社: ["会社", "会社に許可されている"],
    私用: ["私用", "会社に許可されていない"],
    会社に許可されていない: ["会社", "会社に許可されていない"],
  },
  connect: { 通った: ["通った"], 通らない: ["通らない"] },
  changeProfile: { 許可されている: ["会社に許可されている"], 許可されていない: ["会社に許可されていない"] },
};

export const invariants = {
  "会社か私用かは、作ったあと変わらない": (before: Account, after: Account) => before.owner === after.owner,
  "外したアカウントは、もう変わらない": (before: Account, after: Account) => before.status !== "外した" || after.status === "外した",
  "つなぎ直しが要るときだけ、理由がある": (account: Account) => (account.status === "つなぎ直しが要る") === (account.problem !== null),
};

export const links = [
  { from: changeProfile, to: "llm-profile", label: "会社のアカウントが使う Profile は、会社のデータを送らないことにも、送り先を変えることもできなくなる" },
  { from: remove, to: "watch-target", label: "このアカウントの見張りをやめる" },
  { from: remove, to: "write", action: "withdraw", label: "このアカウントへの、確認中の書き込みを取りやめる" },
  { from: reject, to: "write", action: "withdraw", label: "このアカウントへの、確認中の書き込みを取りやめる（つなぎ直してから頼み直す）" },
];

export const scenarios = {
  "会社の GitHub を足して、つなぎ、トークンが切れたらつなぎ直す": [
    { do: initial, by: "ユーザー", input: "会社", expect: { status: "つないでいない", owner: "会社" } },
    { do: connect, by: "ユーザー", input: "通らない", denied: "認証が通ったときだけ" },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる" } },
    { do: connect, by: "ユーザー", input: "通った", denied: "つないでいない・つなぎ直しが要るときだけ" },
    { do: reject, by: "ユーザー", denied: "同期だけ" },
    { do: reject, by: "同期", expect: { status: "つなぎ直しが要る", problem: "トークンが切れた" } },
    { do: reject, by: "同期", denied: "つないでいるときだけ" },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる", problem: null } },
  ],
  "会社のアカウントには、会社のデータを送ってよい Profile しか選べない（足すとき）": [
    { do: initial, by: "ユーザー", input: "会社に許可されていない", denied: "会社のアカウントには、会社のデータを送ってよい Profile だけ" },
  ],
  "会社のアカウントには、会社のデータを送ってよい Profile しか選べない（替えるとき）": [
    { do: initial, by: "ユーザー", input: "会社" },
    { do: changeProfile, by: "ユーザー", input: "許可されていない", denied: "会社のアカウントには、会社のデータを送ってよい Profile だけ" },
    { do: changeProfile, by: "ユーザー", input: "許可されている" },
  ],
  "私用のアカウントは、どの Profile でも選べる": [
    { do: initial, by: "ユーザー", input: "私用", expect: { owner: "私用" } },
    { do: changeProfile, by: "ユーザー", input: "許可されていない" },
  ],
  "外したアカウントは、もう使わない": [
    { do: initial, by: "ユーザー", input: "私用" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: changeScope, by: "ユーザー" },
    { do: remove, by: "ユーザー", expect: { status: "外した" } },
    { do: remove, by: "ユーザー", denied: "外していないときだけ" },
    { do: changeScope, by: "ユーザー", denied: "外していないときだけ" },
    { do: changeProfile, by: "ユーザー", input: "許可されている", denied: "外していないときだけ" },
    { do: connect, by: "ユーザー", input: "通った", denied: "つないでいない・つなぎ直しが要るときだけ" },
  ],
  "アカウントを足す・変えるのはユーザーだけ": [
    { do: initial, by: "同期", input: "私用", denied: "ユーザーだけ" },
  ],
  "アカウントを変えるのはユーザーだけ": [
    { do: initial, by: "ユーザー", input: "私用" },
    { do: connect, by: "同期", input: "通った", denied: "ユーザーだけ" },
    { do: changeProfile, by: "同期", input: "許可されている", denied: "ユーザーだけ" },
    { do: changeScope, by: "同期", denied: "ユーザーだけ" },
    { do: remove, by: "同期", denied: "ユーザーだけ" },
  ],
};

export const reviewed = {
  "equivalent-states:つないでいない · 会社 · problem=なし/つなぎ直しが要る · 会社 · トークンが切れた": "まだつないでいないのと、つなぎ直しが要るのは、できること（つなぐ・外す・変える）は同じだが、ユーザーに見せることが違う（初めての認証か、切れたトークンの理由とつなぎ直しの案内か）。同期を止めていることも同じ",
  "equivalent-states:つないでいない · 私用 · problem=なし/つなぎ直しが要る · 私用 · トークンが切れた": "まだつないでいないのと、つなぎ直しが要るのは、できること（つなぐ・外す・変える）は同じだが、ユーザーに見せることが違う（初めての認証か、切れたトークンの理由とつなぎ直しの案内か）。同期を止めていることも同じ",
  "unused-field:problem": "つなぎ直しが要る理由は、ユーザーに見せるための記録で、操作の可否は変えない。つなぎ直しが要るときだけあることを、不変条件で確かめるために読んでいる",
};

export const questions = [
  {
    ask: "アカウントを外したら、そのアカウントの Source Item と、それだけを持つ Task をどうするか？ 案: Source Item は消えた（範囲の外になった）にし、それだけを持つ Task は振り分けで「もう要らなくなった」として片付ける。データ（ローカル DB）は消さずに残す",
    about: remove,
  },
];
