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
  /** どの Source か（github・slack・gmail・google-calendar・notion・microsoft） */
  source: string;
  /** 画面に出す名前 */
  label: string;
  /** 使う LLM Profile（選ばなければ null で、既定の Profile を使う） */
  /** @ref llm-profile */
  llmProfileId: string | null;
  /** 取り込む範囲（GitHub のリポジトリ・Slack のチャンネル など。Source ごとに形が違う） */
  scope: unknown;
  /** つなぎ直しが要るときの理由 */
  problem: Problem | null;
};

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

export type Problem = "トークンが切れた" | "権限が外された" | "セッションが切れた" | "権限を増やした";

export const Owner = { company: "会社", personal: "私用" } as const;
export type Owner = (typeof Owner)[keyof typeof Owner];

/** 使う Profile（選ばなければ既定）が、会社のデータを送ってよいか */
type ProfileCheck = "会社に許可されている" | "会社に許可されていない";

type Actor = { kind: "user" } | { kind: "sync" } | { kind: "app" };

/** 同期: Source を取りに行って、トークンが通らないことに気づく。アプリ: 書き込み・見張りで、トークンが通らないことに気づく */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
  アプリ: { kind: "app" },
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

/** トークンが通らなかった（切れた・権限が外された・セッションが切れた） */
export function reject(account: Account, actor: Actor, problem: "トークンが切れた" | "権限が外された" | "セッションが切れた"): Account {
  ensure(actor.kind === "sync" || actor.kind === "app", "同期・アプリだけ");
  ensure(account.status === "つないでいる", "つないでいるときだけ");
  return { ...account, status: "つなぎ直しが要る", problem };
}

/** 使う Profile を替える */
export function changeProfile(account: Account, actor: Actor, profile: ProfileCheck): Account {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(account.status !== "外した", "外していないときだけ");
  ensure(account.owner === "私用" || profile === "会社に許可されている", "会社のアカウントには、会社のデータを送ってよい Profile だけ");
  return { ...account, llmProfileId: "work-2" };
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

/** 外す（同期・見張りをやめ、確認中の書き込みを取りやめ、このアカウントのトークン・セッションを消す） */
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
  reject: { トークンが切れた: ["トークンが切れた"], 権限が外された: ["権限が外された"], セッションが切れた: ["セッションが切れた"] },
  changeScope: { 変わらない: ["変わらない"], 権限が増える: ["権限が増える"] },
};

export const invariants = {
  "会社か私用か・ID・どの Source かは、作ったあと変わらない": (before: Account, after: Account) =>
    before.owner === after.owner && before.id === after.id && before.source === after.source,
  "外したアカウントは、もう変わらない": (before: Account, after: Account) => before.status !== "外した" || after.status === "外した",
  "つなぎ直しが要るときだけ、理由がある": (account: Account) => (account.status === "つなぎ直しが要る") === (account.problem !== null),
};

export const links = [
  { from: remove, to: "watch-target", label: "このアカウントの見張りをやめる" },
  { from: reject, to: "watch-target", label: "つなぎ直すまで、このアカウントの見張りを止める" },
  { from: changeScope, to: "source-item", action: "remove", label: "範囲から外れた Source Item は、範囲の外になったとして消す" },
  { from: remove, to: "write", label: "このアカウントへの、書き込み中・書けたか分からない書き込みは、外を確かめられないので失敗にする（理由: アカウントを外した）" },
  { from: remove, to: "write", action: "withdraw", label: "このアカウントへの、確認中の書き込みを取りやめる" },
  { from: reject, to: "write", action: "withdraw", label: "このアカウントへの、確認中の書き込みを取りやめる（つなぎ直してから頼み直す）" },
];

export const scenarios = {
  "会社の GitHub を足して、つなぎ、トークンが切れたらつなぎ直す": [
    { do: initial, by: "ユーザー", input: "会社", expect: { status: "つないでいない", owner: "会社" } },
    { do: connect, by: "ユーザー", input: "通らない", denied: "認証が通ったときだけ" },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる" } },
    { do: connect, by: "ユーザー", input: "通った", denied: "つないでいない・つなぎ直しが要るときだけ" },
    { do: reject, by: "ユーザー", input: "トークンが切れた", denied: "同期・アプリだけ" },
    { do: reject, by: "同期", input: "トークンが切れた", expect: { status: "つなぎ直しが要る", problem: "トークンが切れた" } },
    { do: reject, by: "同期", input: "トークンが切れた", denied: "つないでいるときだけ" },
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
  "Microsoft で権限が増える範囲に広げたら、サインインし直す": [
    { do: initial, by: "ユーザー", input: "会社" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: changeScope, by: "ユーザー", input: "権限が増える", expect: { status: "つなぎ直しが要る", problem: "権限を増やした" } },
    { do: connect, by: "ユーザー", input: "通った", expect: { status: "つないでいる" } },
  ],
  "Slack のセッションが切れたら、つなぎ直す": [
    { do: initial, by: "ユーザー", input: "会社" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: reject, by: "アプリ", input: "セッションが切れた", expect: { status: "つなぎ直しが要る", problem: "セッションが切れた" } },
  ],
  "外したアカウントは、もう使わない": [
    { do: initial, by: "ユーザー", input: "私用" },
    { do: connect, by: "ユーザー", input: "通った" },
    { do: changeScope, by: "ユーザー", input: "変わらない", expect: { status: "つないでいる" } },
    { do: remove, by: "ユーザー", expect: { status: "外した" } },
    { do: remove, by: "ユーザー", denied: "外していないときだけ" },
    { do: changeScope, by: "ユーザー", input: "変わらない", denied: "外していないときだけ" },
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
    { do: changeScope, by: "同期", input: "変わらない", denied: "ユーザーだけ" },
    { do: remove, by: "同期", denied: "ユーザーだけ" },
  ],
};

export const reviewed = {
  "indistinguishable-actor:同期,アプリ": "同期（取りに行く）とアプリ（書き込み・見張り）のどちらが、トークンが通らないことに気づいても、つなぎ直しが要るになる",
  "unused-field:id": "アカウントを見分ける値・どの Source かは、ほかの spec が指すためのもので、操作の可否は変えない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:source": "アカウントを見分ける値・どの Source かは、ほかの spec が指すためのもので、操作の可否は変えない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "equivalent-states:つないでいない · 会社 · github-work · github · problem=なし/つなぎ直しが要る · 会社 · github-work · github · トークンが切れた/つなぎ直しが要る · 会社 · github-work · github · 権限が外された/つなぎ直しが要る · 会社 · github-work · github · セッションが切れた/つなぎ直しが要る · 会社 · github-work · github · 権限を増やした": "まだつないでいないのと、つなぎ直しが要る（理由ごと）のは、できること（つなぐ・外す・変える）は同じで、同期・見張り・書き込みを止めていることも同じ。違うのはユーザーに見せる案内（初めての認証か、つなぎ直しの理由）",
  "equivalent-states:つないでいない · 私用 · gmail-private · gmail · problem=なし/つなぎ直しが要る · 私用 · gmail-private · gmail · トークンが切れた/つなぎ直しが要る · 私用 · gmail-private · gmail · 権限が外された/つなぎ直しが要る · 私用 · gmail-private · gmail · セッションが切れた/つなぎ直しが要る · 私用 · gmail-private · gmail · 権限を増やした": "まだつないでいないのと、つなぎ直しが要る（理由ごと）のは、できること（つなぐ・外す・変える）は同じで、同期・見張り・書き込みを止めていることも同じ。違うのはユーザーに見せる案内（初めての認証か、つなぎ直しの理由）",
};

export const questions = [
  {
    ask: "会社のアカウントが Profile を選ばず既定を使っているとき、既定をあとで許可のない Profile に替えると、会社のデータがそちらに流れる。llm-profile の未決事項（会社のアカウントは必ず明示して選ぶか、既定が許可されているときだけ既定に落とすか）と一緒に決めたい。どちらにするか？",
    about: changeProfile,
  },
  {
    ask: "Claude Code（planNextActions・reviewDependencyPrs）はアカウントの設定で、Profile と関係なく Anthropic にデータを送る。Account に「Claude Code を使う」を持ち、会社のアカウントでは許可があるときだけ有効にするか？（llm-profile の未決事項の案 B）",
    about: initial,
  },
  {
    ask: "トークンが切れたとき、確認中の書き込みを取りやめるか（今の spec）、残してつなぎ直すまで承認だけ止めるか？",
    about: reject,
  },
  {
    ask: "外したアカウントの ID を、足し直すときに使い回してよいか？ 使い回すと、前の Source Item・見張りの記録と混ざる。案: 使い回さない（足し直すと新しい ID）",
    about: remove,
  },
  {
    ask: "会社の Slack を足すとき、管理者に確かめてから使う（ADR-0010）ことを、足す条件にするか？",
    about: initial,
  },
  {
    ask: "アカウントを外したら、そのアカウントの Source Item と、それだけを持つ Task をどうするか？ 案: Source Item は消えた（範囲の外になった）にし、それだけを持つ Task は振り分けで「もう要らなくなった」として片付ける。データ（ローカル DB）は消さずに残す",
    about: remove,
  },
];
