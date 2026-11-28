import { ensure } from "@yutaura/live-spec";
import type { Subject } from "./condition.value.ts";

/**
 * 完了したときにすること（Task が完了したら書き込むこと 1 つ）。Task の計画の中にあり、Task を通してだけ扱う。
 * やること（Action Item）ではないので、番に入らず、完了条件にもならない。計画の木のどこに置いたかで効くかが決まる（根元ならいつでも、分かれ道の枝の下なら、その枝を選んだときだけ。選び直したら、前の枝のものは効かない）。
 * 書き込む事実は、足すときに名指しする。完了のときに事実を探さないので、AI が誤って紐づけた事実も、前もって画面で見て外せる。
 * Task が完了した（done）ときだけ書き込む。やらないことにした（dismissed）ときは書き込まない。
 * 外への書き込みなので、承認がなければ書き込まない。ユーザーが足したもの・☑ を付けたものは、ユーザーが決めたことが承認になる。AI が足したものは、ユーザーが ☑ を付けるまで提案のまま。
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
  /** AI が足した。ユーザーが ☑ を付けるまで、書き込まない */
  proposed: "提案",
  /** 完了したら書き込む（☑） */
  on: "する",
  /** Task が完了したので、書き込みを頼んだ（結果を待っている。☑ は動かせない） */
  requested: "頼んだ",
  /** 完了しても書き込まない（☑ を外した） */
  off: "しない",
  /** 完了したので書き込んだ */
  written: "書き込んだ",
  /** 完了したので頼んだが、書き込めなかった（理由は書き込みに残る） */
  failed: "書き込めなかった",
  /** 置いていた枝を、分かれ道で選び直して取りやめた（もう効かない） */
  withdrawn: "取りやめた",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "agent" } | { kind: "user" } | { kind: "app" };

/** AI: 計画を立てるときに足す。アプリ: Task が完了したら書き込みを頼み、書き込みの結果を受け取る */
export const actors: Record<string, Actor> = {
  AI: { kind: "agent" },
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** 完了したときにすることを足す（計画を立てたとき・事実が増えたとき） */
export function initial(actor: Actor): CompletionEffect {
  ensure(actor.kind === "agent" || actor.kind === "user", "AI かユーザーだけ");
  return {
    status: actor.kind === "agent" ? "提案" : "する",
    addedBy: actor.kind === "agent" ? { type: "AI" } : { type: "ユーザー" },
    id: "ce1",
    title: "レビュー依頼のメールをアーカイブする",
    subject: { accountId: "gmail-work", uri: "gmail:thread/18c2f" },
    operation: "gmail.archive",
    params: { scope: "受け取り済み" },
  };
}

/** ☑ を付ける（AI の提案を受け入れる・外したものを戻す） */
export function check(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(effect.status === "提案" || effect.status === "しない", "提案・しないのときだけ");
  return { ...effect, status: "する" };
}

/** ☑ を外す（完了しても書き込まない。AI が誤って紐づけた事実など） */
export function uncheck(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(effect.status === "する" || effect.status === "提案", "する・提案のときだけ");
  return { ...effect, status: "しない" };
}

/**
 * Task が完了したので、書き込みを頼む
 *
 * ☑ が付いているものだけ（取りやめた枝にあるものは、取りやめたになっているので頼まない）。Task が完了した（done）ときだけで、やらないことにしたときは頼まない。
 */
export function fire(effect: CompletionEffect, actor: Actor, task: "完了した" | "やらないことにした"): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.status === "する", "する（☑）のときだけ");
  ensure(task === "完了した", "Task が完了したときだけ（やらないことにしたときは書き込まない）");
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

/** 置いていた枝を、分かれ道で選び直して取りやめた */
export function withdraw(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.status === "提案" || effect.status === "する" || effect.status === "しない", "まだ頼んでいないときだけ");
  return { ...effect, status: "取りやめた" };
}

export const inputs = {
  fire: { 完了した: ["完了した"], やらないことにした: ["やらないことにした"] },
};

const FINISHED: Status[] = ["書き込んだ", "書き込めなかった", "取りやめた"];

export const invariants = {
  "書き込んだ・書き込めなかった・取りやめたものは、もう変わらない": (before: CompletionEffect, after: CompletionEffect) =>
    !FINISHED.includes(before.status) || before.status === after.status,
  "頼むのは ☑（する）が付いているものだけ（提案のままのものは頼まない）": (before: CompletionEffect, after: CompletionEffect) =>
    after.status !== "頼んだ" || before.status === "する" || before.status === "頼んだ",
  "何に・どの操作で・どの中身を書き込むかは、足したあと変わらない（☑ が承認なので）": (before: CompletionEffect, after: CompletionEffect) =>
    before.subject.uri === after.subject.uri && before.operation === after.operation && JSON.stringify(before.params) === JSON.stringify(after.params),
};

export const links = [
  { from: fire, to: "write", label: "完了したときにすることから、書き込みを頼む（ユーザーが足した・☑ を付けたので、確かめずにすぐ書き込む）。結果（書き込めた・書き込めなかった）は、Task を通して受け取る" },
];

export const scenarios = {
  "ユーザーが足したアーカイブを、完了したら書き込む": [
    { do: initial, by: "ユーザー", expect: { status: "する", addedBy: { type: "ユーザー" } } },
    { do: fire, by: "アプリ", input: "完了した", expect: { status: "頼んだ" } },
    { do: uncheck, by: "ユーザー", denied: "する・提案のときだけ" },
    { do: fire, by: "アプリ", input: "完了した", denied: "する（☑）のときだけ" },
    { do: written, by: "アプリ", expect: { status: "書き込んだ" } },
  ],
  "書き込みたくなくなったら、☑ を外して書き込まない": [
    { do: initial, by: "ユーザー" },
    { do: uncheck, by: "ユーザー", expect: { status: "しない" } },
    { do: fire, by: "アプリ", input: "完了した", denied: "する（☑）のときだけ" },
    { do: check, by: "ユーザー", expect: { status: "する" } },
  ],
  "AI が足したものは、☑ を付けるまで提案のまま": [
    { do: initial, by: "AI", expect: { status: "提案", addedBy: { type: "AI" } } },
    { do: fire, by: "アプリ", input: "完了した", denied: "する（☑）のときだけ" },
    { do: check, by: "AI", denied: "ユーザーだけ" },
    { do: check, by: "ユーザー", expect: { status: "する" } },
  ],
  "AI の提案を外す": [
    { do: initial, by: "AI" },
    { do: uncheck, by: "ユーザー", expect: { status: "しない" } },
  ],
  "やらないことにしたときは書き込まない": [
    { do: initial, by: "ユーザー" },
    { do: fire, by: "アプリ", input: "やらないことにした", denied: "Task が完了したときだけ（やらないことにしたときは書き込まない）" },
  ],
  "分かれ道を選び直したら、前の枝のものは取りやめる": [
    { do: initial, by: "ユーザー" },
    { do: withdraw, by: "アプリ", expect: { status: "取りやめた" } },
    { do: fire, by: "アプリ", input: "完了した", denied: "する（☑）のときだけ" },
    { do: check, by: "ユーザー", denied: "提案・しないのときだけ" },
  ],
  "書き込めなかったら、そのことを残す": [
    { do: initial, by: "ユーザー" },
    { do: written, by: "アプリ", denied: "頼んだときだけ" },
    { do: fire, by: "アプリ", input: "完了した" },
    { do: withdraw, by: "アプリ", denied: "まだ頼んでいないときだけ" },
    { do: failed, by: "アプリ", expect: { status: "書き込めなかった" } },
    { do: failed, by: "アプリ", denied: "頼んだときだけ" },
  ],
  "足すのは決まった人だけ": [{ do: initial, by: "アプリ", denied: "AI かユーザーだけ" }],
  "動かすのは決まった人だけ": [
    { do: initial, by: "ユーザー" },
    { do: uncheck, by: "AI", denied: "ユーザーだけ" },
    { do: fire, by: "ユーザー", input: "完了した", denied: "アプリだけ" },
    { do: withdraw, by: "ユーザー", denied: "アプリだけ" },
    { do: fire, by: "アプリ", input: "完了した" },
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
    ask: "分かれ道の選択肢の先（下書き）に置いた完了したときにすることは、選んだときにだれが足したことにするか？ 案 A: 計画を書いたのは AI なので「提案」にする。案 B: ユーザーが選んだことを承認とみなして「する」にする",
    about: initial,
  },
  {
    ask: "Task が完了したとき、提案のまま残ったものは書き込まれない。知らせるか、完了の確認の画面に出すか？",
    about: fire,
  },
  {
    ask: "書き込めなかったものを、もう一度頼めるようにするか？ それとも、手で済ませる前提にするか？",
    about: failed,
  },
  {
    ask: "振り分けが外れて、書き込む事実が Task から外れたら、☑ をどうするか？ 案: 提案に戻す（ユーザーに確かめてもらう）",
    about: uncheck,
  },
  {
    ask: "状態に、意図（提案・する・しない）と結果（頼んだ・書き込んだ・書き込めなかった・取りやめた）が混ざっている。2 つの項目に分けるか？",
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
