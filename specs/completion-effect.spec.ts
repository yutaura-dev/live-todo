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
  /** だれが足したか */
  addedBy: "AI" | "ユーザー";
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
  /** 完了しても書き込まない（☑ を外した） */
  off: "しない",
  /** 完了したので書き込んだ */
  written: "書き込んだ",
  /** 完了したので頼んだが、書き込めなかった（理由は書き込みに残る） */
  failed: "書き込めなかった",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "agent" } | { kind: "user" } | { kind: "app" } | { kind: "target" };

/** AI: 計画を立てるときに足す。アプリ: Task が完了したら書き込みを頼む。書き込み先: 書き込みの結果を返す */
export const actors: Record<string, Actor> = {
  AI: { kind: "agent" },
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
  書き込み先: { kind: "target" },
};

/** 完了したときにすることを足す（計画を立てたとき・事実が増えたとき） */
export function initial(actor: Actor): CompletionEffect {
  ensure(actor.kind === "agent" || actor.kind === "user", "AI かユーザーだけ");
  const addedBy = actor.kind === "agent" ? "AI" : "ユーザー";
  return {
    status: addedBy === "AI" ? "提案" : "する",
    addedBy,
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
 * 選んだ枝（または根元）にあって、☑ が付いているものだけ。選ばなかった枝・取りやめた枝にあるものは頼まない。
 */
export function fire(effect: CompletionEffect, actor: Actor, place: "選んだ枝・根元にある" | "選ばなかった枝にある"): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.status === "する", "する（☑）のときだけ");
  ensure(place === "選んだ枝・根元にある", "選んだ枝か根元にあるときだけ");
  return { ...effect };
}

/** 書き込めた */
export function written(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "target", "書き込み先だけ");
  ensure(effect.status === "する", "する（☑）のときだけ");
  return { ...effect, status: "書き込んだ" };
}

/** 書き込めなかった */
export function failed(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "target", "書き込み先だけ");
  ensure(effect.status === "する", "する（☑）のときだけ");
  return { ...effect, status: "書き込めなかった" };
}

export const inputs = {
  fire: { 選んだ枝: ["選んだ枝・根元にある"], 選ばなかった枝: ["選ばなかった枝にある"] },
};

const FINISHED: Status[] = ["書き込んだ", "書き込めなかった"];

export const invariants = {
  "書き込んだ・書き込めなかったものは、もう変わらない": (before: CompletionEffect, after: CompletionEffect) =>
    !FINISHED.includes(before.status) || before.status === after.status,
  "AI が足したものは、ユーザーが ☑ を付けるまで書き込まない": (before: CompletionEffect, after: CompletionEffect) =>
    before.status !== "提案" || after.status === "提案" || after.status === "する" || after.status === "しない",
};

export const links = [
  { from: fire, to: "write", label: "完了したときにすることから、書き込みを頼む（ユーザーが足した・☑ を付けたので、確かめずにすぐ書き込む）" },
];

export const scenarios = {
  "ユーザーが足したアーカイブを、完了したら書き込む": [
    { do: initial, by: "ユーザー", expect: { status: "する", addedBy: "ユーザー" } },
    { do: fire, by: "アプリ", input: "選んだ枝" },
    { do: written, by: "書き込み先", expect: { status: "書き込んだ" } },
    { do: uncheck, by: "ユーザー", denied: "する・提案のときだけ" },
  ],
  "書き込みたくなくなったら、☑ を外して書き込まない": [
    { do: initial, by: "ユーザー" },
    { do: uncheck, by: "ユーザー", expect: { status: "しない" } },
    { do: fire, by: "アプリ", input: "選んだ枝", denied: "する（☑）のときだけ" },
    { do: check, by: "ユーザー", expect: { status: "する" } },
  ],
  "AI が足したものは、☑ を付けるまで提案のまま": [
    { do: initial, by: "AI", expect: { status: "提案", addedBy: "AI" } },
    { do: fire, by: "アプリ", input: "選んだ枝", denied: "する（☑）のときだけ" },
    { do: check, by: "AI", denied: "ユーザーだけ" },
    { do: check, by: "ユーザー", expect: { status: "する" } },
  ],
  "AI の提案を外す": [
    { do: initial, by: "AI" },
    { do: uncheck, by: "ユーザー", expect: { status: "しない" } },
  ],
  "選ばなかった枝にあるものは書き込まない": [
    { do: initial, by: "ユーザー", expect: { status: "する", addedBy: "ユーザー" } },
    { do: fire, by: "アプリ", input: "選ばなかった枝", denied: "選んだ枝か根元にあるときだけ" },
  ],
  "書き込めなかったら、そのことを残す": [
    { do: initial, by: "ユーザー" },
    { do: fire, by: "アプリ", input: "選んだ枝" },
    { do: failed, by: "書き込み先", expect: { status: "書き込めなかった" } },
    { do: written, by: "書き込み先", denied: "する（☑）のときだけ" },
  ],
  "足すのは決まった人だけ": [{ do: initial, by: "アプリ", denied: "AI かユーザーだけ" }],
  "動かすのは決まった人だけ": [
    { do: initial, by: "ユーザー" },
    { do: uncheck, by: "AI", denied: "ユーザーだけ" },
    { do: fire, by: "ユーザー", input: "選んだ枝", denied: "アプリだけ" },
    { do: written, by: "アプリ", denied: "書き込み先だけ" },
    { do: failed, by: "アプリ", denied: "書き込み先だけ" },
    { do: uncheck, by: "ユーザー" },
    { do: written, by: "書き込み先", denied: "する（☑）のときだけ" },
    { do: failed, by: "書き込み先", denied: "する（☑）のときだけ" },
  ],
};

export const questions = [
  {
    ask: "ルールは CompletionEffect にどう関わるか？（ルールが足す・ルールの承認で初めから ☑ にする・ルールは関わらない など）。Rule を捉え直すときに決める",
    about: initial,
  },
  {
    ask: "Task をやり直した（reopen）あと、また完了したら、もう書き込んだものはどうするか？ 案: 書き込んだものは二度書き込まない。まだのもの（する）は、次に完了したときに書き込む",
    about: written,
  },
];
