import { ensure } from "@yutaura/live-spec";
import type { Subject } from "./condition.value.ts";

/**
 * 完了したときにすること（Task が完了したらしておきたい後片付け 1 つ。レビュー依頼のメールをアーカイブする・Slack の To-do を済ませる など）。Task の計画の中にあり、Task を通してだけ扱う。
 * Action Item は Task を進めるために要ること、完了したときにすることは Task の完了には要らないが、完了したらしておきたい後片付け。操作の種類ではなく意味で分ける（後片付けとしての merge もありうる）。
 * 番に入らず、完了条件にもならない。計画の木のどこに置いたかで効くかが決まる（根元ならいつでも、分かれ道の枝の下なら、その枝を選んだときだけ）。
 * 書き込む事実は、足すときに名指しする。完了のときに事実を探さないので、前もって画面で見て外せる。
 * Task をやり終えると、完了したときにすることがあれば完了待ちになる。チェックリスト（初めは ☑、個別に外せる）をユーザーが確かめて完了のボタンを押すと、☑ が付いているものを書き込む（ボタンを押したことが承認）。だれが足したもの（AI が計画に書いた・ユーザーが足した）も、こうして書き込む前にユーザーが確かめる。
 * 版を持つ操作（merge など）は見せたときの版を持ち、ボタンを押したときに版が変わっていたら書き込まない。
 * 書き込めなかったものは完了待ちに残り、もう一度頼むか、☑ を外して済ませる。すべて書き込めた（または外した）ら、Task が終わる。
 * ルールがどう関わるかは、Rule を捉え直すときに決める。
 */
export type CompletionEffect = {
  /** ☑ が付いているか（書き込むか） */
  checked: boolean;
  /** 書き込みがどこまで進んだか */
  delivery: Delivery;
  /** だれが足したか（あとでほかの足し方も表せるよう、種類で持つ） */
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
  /** 版を持つ操作（merge など）なら、見せたときの版。持たない操作（アーカイブ など）なら null */
  version: string | null;
  /** 最後に頼んだ書き込み（書き込めなかった理由を見せる。まだ頼んでいなければ null） */
  /** @ref write */
  writeId: string | null;
};

export const Delivery = {
  /** まだ頼んでいない */
  pending: "まだ",
  /** 書き込みを頼んだ（結果を待っている。☑ は動かせない） */
  requested: "頼んだ",
  /** 書き込めた */
  written: "書き込んだ",
  /** 書き込めなかった（理由は書き込みに残る。完了待ちに残り、もう一度頼むか ☑ を外す） */
  failed: "書き込めなかった",
  /** 取りやめた（置いていた枝を選び直した・Task をやらないことにした・書き込む事実を Task から外した。もう効かない） */
  withdrawn: "取りやめた",
} as const;
export type Delivery = (typeof Delivery)[keyof typeof Delivery];

type Actor = { kind: "agent" } | { kind: "user" } | { kind: "app" };

/** AI: 計画を立てるときに足す。アプリ: 完了のボタンが押されたら書き込みを頼み、書き込みの結果を受け取る */
export const actors: Record<string, Actor> = {
  AI: { kind: "agent" },
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
};

/** 完了したときにすることを足す（計画を立てたとき・事実が増えたとき）。初めは ☑ */
export function initial(actor: Actor): CompletionEffect {
  ensure(actor.kind === "agent" || actor.kind === "user", "AI かユーザーだけ");
  return {
    checked: true,
    delivery: "まだ",
    addedBy: actor.kind === "agent" ? { type: "AI" } : { type: "ユーザー" },
    id: "ce1",
    title: "レビュー依頼のメールをアーカイブする",
    subject: { uri: "gmail://me@acme.co.jp/thread/18c2f" },
    operation: "gmail.archive",
    params: { scope: "受け取り済み" },
    version: null,
    writeId: null,
  };
}

/** ☑ を付け直す（外したものを戻す） */
export function check(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(!effect.checked, "☑ を外しているときだけ");
  ensure(effect.delivery === "まだ" || effect.delivery === "書き込めなかった", "まだ・書き込めなかったときだけ");
  return { ...effect, checked: true };
}

/** ☑ を外す（書き込まない。書き込めなかったものを、手で済ませて外すときも） */
export function uncheck(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(effect.checked, "☑ が付いているときだけ");
  ensure(effect.delivery === "まだ" || effect.delivery === "書き込めなかった", "まだ・書き込めなかったときだけ");
  return { ...effect, checked: false };
}

/**
 * 完了のボタンが押されたので、書き込みを頼む
 *
 * ☑ が付いていて、まだ頼んでいないものだけ。頼めなかった（書き込める状態でない・版が変わった など）なら、書き込めなかったにする。
 */
export function fire(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.checked, "☑ が付いているときだけ");
  ensure(effect.delivery === "まだ", "まだ頼んでいないときだけ");
  return { ...effect, delivery: "頼んだ", writeId: "w1" };
}

/** 書き込めた（書き込みの結果を受け取る） */
export function written(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.delivery === "頼んだ", "頼んだときだけ");
  return { ...effect, delivery: "書き込んだ" };
}

/** 書き込めなかった（書き込みの結果を受け取る。書けたか分からないなら、外を確かめて決まるまで待つ） */
export function failed(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.delivery === "頼んだ", "頼んだときだけ");
  return { ...effect, delivery: "書き込めなかった" };
}

/** 書き込めなかったものを、もう一度頼む（完了待ちのレーンから。もう一度頼むボタンを押したことが承認） */
export function retry(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(effect.checked, "☑ が付いているときだけ");
  ensure(effect.delivery === "書き込めなかった", "書き込めなかったときだけ");
  return { ...effect, delivery: "頼んだ", writeId: "w2" };
}

/** 取りやめる（置いていた枝を選び直した・Task をやらないことにした・書き込む事実を Task から外した） */
export function withdraw(effect: CompletionEffect, actor: Actor): CompletionEffect {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(effect.delivery === "まだ" || effect.delivery === "書き込めなかった", "頼んで結果を待っていないとき・まだ書き込んでいないときだけ");
  return { ...effect, delivery: "取りやめた" };
}

const FINISHED: Delivery[] = ["書き込んだ", "取りやめた"];

export const invariants = {
  "書き込んだ・取りやめたものは、もう変わらない": (before: CompletionEffect, after: CompletionEffect) =>
    !FINISHED.includes(before.delivery) || (before.delivery === after.delivery && before.checked === after.checked),
  "頼むのは ☑ が付いているものだけ": (effect: CompletionEffect) => effect.delivery !== "頼んだ" || effect.checked,
  "何に・どの操作で・どの中身を・どの版に書き込むかは、足したあと変わらない（☑ と完了のボタンが承認なので）": (before: CompletionEffect, after: CompletionEffect) =>
    before.subject.uri === after.subject.uri &&
    before.operation === after.operation &&
    JSON.stringify(before.params) === JSON.stringify(after.params) &&
    before.version === after.version,
};

export const links = [
  { from: fire, to: "write", label: "完了したときにすることから、書き込みを頼む（ユーザーがチェックリストを確かめて完了のボタンを押したので、確かめずにすぐ書き込む。版を持つ操作は、見せたときの版のままか確かめる）。頼めなかったら、書き込めなかったにする" },
  { from: retry, to: "write", label: "もう一度、書き込みを頼む" },
  { from: written, to: "task", action: "noteProgress", label: "書き込めたことを、Task の出来事に残す" },
  { from: failed, to: "task", action: "receive", label: "Task に、書き込めなかったこと（理由つき）が届く（完了待ちのレーンで気づけるように）" },
  { from: written, to: "task", action: "finishCompletion", label: "完了したときにすることが、すべて書き込めた・外されたら、Task が終わる" },
  { from: uncheck, to: "task", action: "finishCompletion", label: "書き込めなかったものを外して、すべて済んだら、Task が終わる" },
];

export const scenarios = {
  "完了のボタンを押したら、☑ が付いているものを書き込む": [
    { do: initial, by: "AI", expect: { checked: true, delivery: "まだ", addedBy: { type: "AI" } } },
    { do: fire, by: "アプリ", expect: { delivery: "頼んだ" } },
    { do: uncheck, by: "ユーザー", denied: "まだ・書き込めなかったときだけ" },
    { do: fire, by: "アプリ", denied: "まだ頼んでいないときだけ" },
    { do: written, by: "アプリ", expect: { delivery: "書き込んだ" } },
  ],
  "チェックリストで ☑ を外したものは書き込まない": [
    { do: initial, by: "ユーザー", expect: { addedBy: { type: "ユーザー" } } },
    { do: check, by: "ユーザー", denied: "☑ を外しているときだけ" },
    { do: uncheck, by: "ユーザー", expect: { checked: false } },
    { do: uncheck, by: "ユーザー", denied: "☑ が付いているときだけ" },
    { do: fire, by: "アプリ", denied: "☑ が付いているときだけ" },
    { do: check, by: "ユーザー", expect: { checked: true } },
  ],
  "取りやめたら、もう効かない": [
    { do: initial, by: "AI" },
    { do: withdraw, by: "アプリ", expect: { delivery: "取りやめた" } },
    { do: fire, by: "アプリ", denied: "まだ頼んでいないときだけ" },
    { do: uncheck, by: "ユーザー", denied: "まだ・書き込めなかったときだけ" },
  ],
  "書き込めなかったら完了待ちに残り、もう一度頼める": [
    { do: initial, by: "AI" },
    { do: written, by: "アプリ", denied: "頼んだときだけ" },
    { do: retry, by: "ユーザー", denied: "書き込めなかったときだけ" },
    { do: fire, by: "アプリ" },
    { do: withdraw, by: "アプリ", denied: "頼んで結果を待っていないとき・まだ書き込んでいないときだけ" },
    { do: failed, by: "アプリ", expect: { delivery: "書き込めなかった" } },
    { do: failed, by: "アプリ", denied: "頼んだときだけ" },
    { do: retry, by: "AI", denied: "ユーザーだけ" },
    { do: retry, by: "ユーザー", expect: { delivery: "頼んだ" } },
    { do: written, by: "アプリ", expect: { delivery: "書き込んだ" } },
  ],
  "書き込めなかったものを手で済ませたら、☑ を外す（もう一度は頼めない）": [
    { do: initial, by: "AI" },
    { do: fire, by: "アプリ" },
    { do: failed, by: "アプリ" },
    { do: uncheck, by: "ユーザー", expect: { checked: false, delivery: "書き込めなかった" } },
    { do: retry, by: "ユーザー", denied: "☑ が付いているときだけ" },
  ],
  "やらないことにしたら、書き込めなかったものも取りやめる": [
    { do: initial, by: "AI" },
    { do: fire, by: "アプリ" },
    { do: failed, by: "アプリ" },
    { do: withdraw, by: "アプリ", expect: { delivery: "取りやめた" } },
  ],
  "足すのは決まった人だけ": [{ do: initial, by: "アプリ", denied: "AI かユーザーだけ" }],
  "動かすのは決まった人だけ": [
    { do: initial, by: "ユーザー" },
    { do: uncheck, by: "AI", denied: "ユーザーだけ" },
    { do: uncheck, by: "ユーザー" },
    { do: check, by: "AI", denied: "ユーザーだけ" },
    { do: check, by: "ユーザー" },
    { do: fire, by: "ユーザー", denied: "アプリだけ" },
    { do: withdraw, by: "ユーザー", denied: "アプリだけ" },
    { do: fire, by: "アプリ" },
    { do: written, by: "ユーザー", denied: "アプリだけ" },
    { do: failed, by: "ユーザー", denied: "アプリだけ" },
  ],
};

export const reviewed = {
  "unused-field:operation": "どの操作か・操作ごとの中身・版は、書き込み先にそのまま渡すもので、状態の進み方は変えない。足したあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:params": "どの操作か・操作ごとの中身・版は、書き込み先にそのまま渡すもので、状態の進み方は変えない。足したあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:version": "版は、完了のボタンを押したときに、書き込み（Write）が今の版と比べる。足したあと変わらないことを、不変条件で確かめるために読んでいる",
};

export const questions = [
  {
    ask: "ルールは CompletionEffect にどう関わるか？（ルールが足す・ルールは関わらない など）。Write のルールの経路もいったん外したので、Rule を捉え直すときに一緒に決める",
    about: initial,
  },
];
