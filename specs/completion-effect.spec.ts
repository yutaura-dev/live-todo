import { ensure } from "@yutaura/live-spec";
import type { Subject } from "./condition.value.ts";

/**
 * 完了したときにすること（Task が完了したら書き込むこと 1 つ）。Task の計画の中にあり、Task を通してだけ扱う。
 * やること（Action Item）ではないので、番に入らず、完了条件にもならない。計画の木のどこに置いたかで効くかが決まる（根元ならいつでも、分かれ道の枝の下なら、その枝を選んだときだけ。選び直したら、前の枝のものは効かない）。
 * 書き込む事実は、足すときに名指しする。完了のときに事実を探さないので、AI が誤って紐づけた事実も、前もって画面で見て外せる。
 * Task をやり終えると、完了したときにすることがあれば完了待ちになる。チェックリスト（初めは ☑、個別に外せる）をユーザーが確かめて完了のボタンを押すと、☑ が付いているものを書き込む（ボタンを押したことが承認）。だれが足したもの（AI が計画に書いた・ユーザーが足した）も、こうして書き込む前にユーザーが確かめる。
 * やらないことにした（dismissed）ときは書き込まない。書き込めなかったものは完了待ちに残り、もう一度頼むか、☑ を外して済ませる。すべて書き込めた（または外した）ら、Task が終わる。
 * ルールがどう関わるか（ルールが足す・ルールの承認で ☑ にする など）は、Rule を捉え直すときに決める。
 */
export type CompletionEffect = {
  /** するか */
  status: Status;
  /** だれが足したか（あとでルールが足すことも表せるよう、種類で持つ） */
  addedBy: { type: "AI" } | { type: "ユーザー" };
  /** 見分ける ID（Task の中でだけ一意） */
  id: string;
  /** 何をするか */
  title: string;
  /** 何に書き込むか */
  subject: Subject;
  /** どの操作か（provider が決めた名前） */
  operation: string;
  /** 操作ごとの中身（形は provider が決める） */
  params: unknown;
};

export const Status = {
  /** 完了のボタンを押したら書き込む（☑。初めはこれ） */
  on: "する",
  /** 完了のボタンが押されたので、書き込みを頼んだ（結果を待っている。☑ は動かせない） */
  requested: "頼んだ",
  /** 書き込まない（☑ を外した） */
  off: "しない",
  /** 完了したので書き込んだ */
  written: "書き込んだ",
  /** 頼んだが、書き込めなかった（理由は書き込みに残る。完了待ちに残り、もう一度頼むか ☑ を外す） */
  failed: "書き込めなかった",
  /** 置いていた枝を、分かれ道で選び直して取りやめた（もう効かない） */
  withdrawn: "取りやめた",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "agent" } | { kind: "user" } | { kind: "app" };

/** AI: 計画を立てるときに足す。アプリ: 完了のボタンが押されたら書き込みを頼み、書き込みの結果を受け取る */
export const actors: Record<string, Actor> = {
  AI: { kind: "agent" },
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** 完了したときにすることを足す（計画を立てたとき・事実が増えたとき） */
export function initial(actor: Actor): CompletionEffect {
  ensure(actor.kind === "agent" || actor.kind === "user", "AI かユーザーだけ");
  return {
    status: "する",
    addedBy: actor.kind === "agent" ? { type: "AI" } : { type: "ユーザー" },
    id: "ce1",
    title: "レビュー依頼のメールをアーカイブする",
    subject: { accountId: "gmail-work", uri: "gmail:thread/18c2f" },
    operation: "gmail.archive",
    params: { scope: "受け取り済み" },
  };
}

/** ☑ を付け直す（外したものを戻す） */
export function check(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(effect.status === "しない", "しないのときだけ");
  return { ...effect, status: "する" };
}

/** ☑ を外す（書き込まない。書き込めなかったものを、手で済ませて外すときも） */
export function uncheck(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(effect.status === "する" || effect.status === "書き込めなかった", "する・書き込めなかったときだけ");
  return { ...effect, status: "しない" };
}

/**
 * 完了のボタンが押されたので、書き込みを頼む
 *
 * ☑ が付いているものだけ（取りやめた枝にあるものは、取りやめたになっているので頼まない）。完了待ちでボタンが押されたときだけで、やらないことにしたときは頼まない。
 */
export function fire(effect: CompletionEffect, actor: Actor, task: "完了のボタンが押された" | "やらないことにした"): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.status === "する", "する（☑）のときだけ");
  ensure(task === "完了のボタンが押された", "完了のボタンが押されたときだけ（やらないことにしたときは書き込まない）");
  return { ...effect, status: "頼んだ" };
}

/** 書き込めた（書き込みの結果を受け取る） */
export function written(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.status === "頼んだ", "頼んだときだけ");
  return { ...effect, status: "書き込んだ" };
}

/** 書き込めなかった（書き込みの結果を受け取る。書けたか分からないなら、外を確かめて決まるまで待つ） */
export function failed(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.status === "頼んだ", "頼んだときだけ");
  return { ...effect, status: "書き込めなかった" };
}

/** 書き込めなかったものを、もう一度頼む（完了待ちのレーンから） */
export function retry(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(effect.status === "書き込めなかった", "書き込めなかったときだけ");
  return { ...effect, status: "頼んだ" };
}

/** 置いていた枝を、分かれ道で選び直して取りやめた */
export function withdraw(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.status === "する" || effect.status === "しない", "まだ頼んでいないときだけ");
  return { ...effect, status: "取りやめた" };
}

export const inputs = {
  fire: { 完了のボタン: ["完了のボタンが押された"], やらないことにした: ["やらないことにした"] },
};

const FINISHED: Status[] = ["書き込んだ", "取りやめた"];

export const invariants = {
  "書き込んだ・取りやめたものは、もう変わらない": (before: CompletionEffect, after: CompletionEffect) =>
    !FINISHED.includes(before.status) || before.status === after.status,
  "頼むのは ☑（する）が付いているものと、書き込めなかったものをもう一度頼むときだけ": (before: CompletionEffect, after: CompletionEffect) =>
    after.status !== "頼んだ" || before.status === "する" || before.status === "書き込めなかった" || before.status === "頼んだ",
  "何に・どの操作で・どの中身を書き込むかは、足したあと変わらない（☑ が承認なので）": (before: CompletionEffect, after: CompletionEffect) =>
    before.subject.uri === after.subject.uri && before.operation === after.operation && JSON.stringify(before.params) === JSON.stringify(after.params),
};

export const links = [
  { from: fire, to: "write", label: "完了したときにすることから、書き込みを頼む（ユーザーがチェックリストを確かめて完了のボタンを押したので、確かめずにすぐ書き込む）。結果（書き込めた・書き込めなかった）は、Task を通して受け取る" },
  { from: retry, to: "write", label: "もう一度、書き込みを頼む" },
  { from: written, to: "task", action: "finishCompletion", label: "完了したときにすることが、すべて書き込めた・外されたら、Task が終わる" },
  { from: uncheck, to: "task", action: "finishCompletion", label: "書き込めなかったものを外して、すべて済んだら、Task が終わる" },
];

export const scenarios = {
  "完了のボタンを押したら、☑ が付いているものを書き込む": [
    { do: initial, by: "AI", expect: { status: "する", addedBy: { type: "AI" } } },
    { do: fire, by: "アプリ", input: "完了のボタン", expect: { status: "頼んだ" } },
    { do: uncheck, by: "ユーザー", denied: "する・書き込めなかったときだけ" },
    { do: fire, by: "アプリ", input: "完了のボタン", denied: "する（☑）のときだけ" },
    { do: written, by: "アプリ", expect: { status: "書き込んだ" } },
  ],
  "チェックリストで ☑ を外したものは書き込まない": [
    { do: initial, by: "ユーザー", expect: { addedBy: { type: "ユーザー" } } },
    { do: check, by: "ユーザー", denied: "しないのときだけ" },
    { do: uncheck, by: "ユーザー", expect: { status: "しない" } },
    { do: fire, by: "アプリ", input: "完了のボタン", denied: "する（☑）のときだけ" },
    { do: check, by: "ユーザー", expect: { status: "する" } },
  ],
  "やらないことにしたときは書き込まない": [
    { do: initial, by: "AI" },
    { do: fire, by: "アプリ", input: "やらないことにした", denied: "完了のボタンが押されたときだけ（やらないことにしたときは書き込まない）" },
  ],
  "分かれ道を選び直したら、前の枝のものは取りやめる": [
    { do: initial, by: "AI" },
    { do: withdraw, by: "アプリ", expect: { status: "取りやめた" } },
    { do: fire, by: "アプリ", input: "完了のボタン", denied: "する（☑）のときだけ" },
    { do: check, by: "ユーザー", denied: "しないのときだけ" },
  ],
  "書き込めなかったら完了待ちに残り、もう一度頼める": [
    { do: initial, by: "AI" },
    { do: written, by: "アプリ", denied: "頼んだときだけ" },
    { do: retry, by: "ユーザー", denied: "書き込めなかったときだけ" },
    { do: fire, by: "アプリ", input: "完了のボタン" },
    { do: withdraw, by: "アプリ", denied: "まだ頼んでいないときだけ" },
    { do: failed, by: "アプリ", expect: { status: "書き込めなかった" } },
    { do: failed, by: "アプリ", denied: "頼んだときだけ" },
    { do: retry, by: "AI", denied: "ユーザーだけ" },
    { do: retry, by: "ユーザー", expect: { status: "頼んだ" } },
    { do: written, by: "アプリ", expect: { status: "書き込んだ" } },
  ],
  "書き込めなかったものを手で済ませたら、☑ を外す": [
    { do: initial, by: "AI" },
    { do: fire, by: "アプリ", input: "完了のボタン" },
    { do: failed, by: "アプリ" },
    { do: uncheck, by: "ユーザー", expect: { status: "しない" } },
  ],
  "足すのは決まった人だけ": [{ do: initial, by: "アプリ", denied: "AI かユーザーだけ" }],
  "動かすのは決まった人だけ": [
    { do: initial, by: "ユーザー" },
    { do: uncheck, by: "AI", denied: "ユーザーだけ" },
    { do: uncheck, by: "ユーザー" },
    { do: check, by: "AI", denied: "ユーザーだけ" },
    { do: check, by: "ユーザー" },
    { do: fire, by: "ユーザー", input: "完了のボタン", denied: "アプリだけ" },
    { do: withdraw, by: "ユーザー", denied: "アプリだけ" },
    { do: fire, by: "アプリ", input: "完了のボタン" },
    { do: written, by: "ユーザー", denied: "アプリだけ" },
    { do: failed, by: "ユーザー", denied: "アプリだけ" },
  ],
};

export const reviewed = {
  "unused-field:operation": "どの操作か・操作ごとの中身は、書き込み先にそのまま渡すもので、状態の進み方は変えない。足したあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:params": "どの操作か・操作ごとの中身は、書き込み先にそのまま渡すもので、状態の進み方は変えない。足したあと変わらないことを、不変条件で確かめるために読んでいる",
};

export const questions = [
  {
    ask: "状態に、意図（する・しない）と結果（頼んだ・書き込んだ・書き込めなかった・取りやめた）が混ざっている。2 つの項目に分けるか？（保留中）",
    about: check,
  },
  {
    ask: "ルールは CompletionEffect にどう関わるか？（ルールが足す・ルールの承認で初めから ☑ にする・ルールは関わらない など）。今の Write の「ルールから頼む」で完了をきっかけに書き込むものと、二重にならないようにしたい。Rule を捉え直すときに決める",
    about: initial,
  },
  {
    ask: "Task をやり直した（reopen）あと、また完了したら、もう書き込んだものはどうするか？ 案: 書き込んだものは二度書き込まない。まだのもの（する）は、次に完了したときに書き込む",
    about: written,
  },
];
