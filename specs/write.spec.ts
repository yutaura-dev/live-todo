import { ensure } from "@yutaura/live-spec";
import type { Subject } from "./condition.value.ts";

/**
 * Write（外への書き込み 1 回。PR を merge する・修正を push する・メールをアーカイブする・Slack の To-do を済ませる など）。
 * 承認がなければ書き込まない（charter）。承認のしかたは、何から頼まれたかで決まる。
 * - Action Item から頼まれた: ユーザーが中身を確かめて承認する
 * - ルールから頼まれた: ユーザーがルールを決めた（組み込みのルールなら、有効にした）ことを、そのルールの範囲の書き込みの承認とみなす。組み込みのルールは、初めは止めてある
 * 何を書き込めるか・どう書き込むかは、Source ごとの provider（Adapter）が決めて実装する。
 * 書き込んだ結果、外の世界が変わると、その変化は同期で Source Item に戻ってくる。同じ事実を持つ Task は、それぞれ事実の変化として受け取る。
 */
export type Write = {
  /** 書き込みの段階 */
  stage: Stage;
  /** 承認（まだなければ null）。承認のしかたは、何から頼まれたかで決まる */
  approval: { at: string } | null;
  /** Write を見分ける ID */
  id: string;
  /** 何に書き込むか */
  subject: Subject;
  /** どの操作か。provider が決めた名前（github.merge・github.push・gmail.archive・slack.complete_todo など） */
  operation: string;
  /** 操作ごとの中身（merge の方法・返信の本文・アーカイブするメールの一覧 など）。形は provider が操作ごとに決め、デコードして確かめる。ドメインは中身を読まず、書き込み先にそのまま渡す */
  params: unknown;
  /** 見せたときの対象の版（PR の head の commit など）。承認するとき、今の版と比べる。どの操作にも共通の決まりなので、中身とは分けて持つ */
  version: string;
  /** 確認するときに見せる説明（provider が中身から作る） */
  summary: string;
  /** 何から頼まれたか */
  requestedBy: RequestedBy;
  /** 書き込めなかったときの理由 */
  failure: Failure | null;
  /** 書き込みが終わった時刻（書き込んだ・失敗） */
  finishedAt: string | null;
};

/** 何から頼まれたか */
export type RequestedBy =
  /** 書き込みで果たされる Action Item（Action Item の ID は Task の中でだけ一意なので、Task と組で指す）。ユーザーが中身を確かめて承認する */
  | {
      type: "actionItem";
      /** @ref task */
      taskId: string;
      actionItemId: string;
    }
  /** ルール（ユーザーが作ったルールか、ユーザーが有効にした組み込みのルール）。ルールを決めたことが承認になる */
  | { type: "rule"; ruleId: string }
  /** 完了したときにすること（Task が完了したら書き込む）。ユーザーが足した・☑ を付けたことが承認になる */
  | {
      type: "completionEffect";
      /** @ref task */
      taskId: string;
      effectId: string;
    };

/** 書き込めなかった理由 */
export type Failure = {
  /** 権限が足りないなら、何をすれば書き込めるかを伝える。書き込み先のエラーなら、書き込み先の画面から操作するよう伝える */
  kind: FailureKind;
  message: string;
};
export type FailureKind = "権限が足りない" | "書き込み先のエラー" | "書けていなかった";

export const Stage = {
  /** 書き込む中身を見せて、ユーザーの承認を待っている */
  confirming: "確認中",
  /** 承認があり、書き込んでいる */
  writing: "書き込み中",
  /** 書き込んでいる間にアプリが止まり、書けたかが分からない。外を確かめて決める（やり直さない） */
  unknown: "書けたか分からない",
  /** 書き込めた */
  written: "書き込んだ",
  /** 書き込めなかった（理由を残す） */
  failed: "失敗",
  /** 書き込む前にやめた（ユーザーがやめた・対象が閉じた・Action Item をやらなくなった） */
  cancelled: "取りやめた",
} as const;
export type Stage = (typeof Stage)[keyof typeof Stage];

/** 書き込める状態か（provider が決める。merge なら CI がすべて通っていて conflict がない など） */
type Ready = "書き込める" | "書き込めない";

/** 頼むときに確かめること。Action Item・ルール・Task の状態は、それぞれの集約が持つ */
type Request =
  | {
      way: "Action Item";
      /** その Action Item の番と状態 */
      item: "番が来ていて、まだ" | "番待ち" | "済んでいる";
      /** Action Item の定義にある、対象と操作と同じか */
      sameAsDefinition: boolean;
      /** その Action Item に、終わっていない書き込みがもうあるか */
      openWrite: boolean;
    }
  | {
      way: "ルール";
      /** ルールが有効か（組み込みのルールは、ユーザーが有効にしたときだけ） */
      rule: "有効" | "止めてある";
      /** ルールの範囲の操作か（ラベル・既読・アーカイブ など） */
      inScope: boolean;
      /** 同じものに、同じルールでもう書き込んだか */
      alreadyWritten: boolean;
    }
  | {
      way: "完了したときにすること";
      /** Task が完了した（done）か */
      taskDone: boolean;
    };

type Actor = { kind: "user" } | { kind: "app" } | { kind: "sync" } | { kind: "target" };

/** アプリ: ルールを当てる・起動したときに確かめるなど、アプリが自分で起こす処理。同期: Source から外の状態を取り込む処理 */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
  同期: { kind: "sync" },
  書き込み先: { kind: "target" },
};

/**
 * 書き込みを頼む
 *
 * Action Item から頼むもの（merge のボタンなど）は、ユーザーが頼み、中身を見せて確認中になる。ルールから頼むものは、ルールに当てはまったことが承認なので、すぐ書き込む。完了したときにすることから頼むものは、ユーザーが足した・☑ を付けたことが承認なので、すぐ書き込む。
 */
export function initial(actor: Actor, request: Request, ready: Ready): Write {
  ensure(request.way === "Action Item" ? actor.kind === "user" : actor.kind === "app", "Action Item からはユーザー、ルール・完了したときにすることからはアプリだけ");
  ensure(ready === "書き込める", "書き込める状態のときだけ");
  if (request.way === "Action Item") {
    ensure(request.item === "番が来ていて、まだ", "Action Item に番が来ていて、まだ済んでいないときだけ");
    ensure(request.sameAsDefinition, "Action Item の定義と同じ対象と操作だけ");
    ensure(!request.openWrite, "その Action Item に、終わっていない書き込みがないときだけ");
  } else if (request.way === "完了したときにすること") {
    ensure(request.taskDone, "Task が完了したときだけ（やらないことにしたときは書き込まない）");
  } else {
    ensure(request.rule === "有効", "有効なルールだけ（組み込みのルールは、ユーザーが有効にしたものだけ）");
    ensure(request.inScope, "ルールの範囲の操作だけ");
    ensure(!request.alreadyWritten, "同じものに同じルールで書き込むのは一度だけ");
  }
  const byRule = request.way !== "Action Item";
  return {
    stage: byRule ? "書き込み中" : "確認中",
    approval: byRule ? { at: "2026-11-28T00:00:00Z" } : null,
    id: "w1",
    subject: { accountId: "github-work", uri: "github:acme/app/pull/42" },
    operation: "github.merge",
    params: { method: "squash", title: "axios を 1.8 に上げる (#42)" },
    version: "abc1234",
    summary: "squash で merge する",
    requestedBy:
      request.way === "ルール"
        ? { type: "rule", ruleId: "r1" }
        : request.way === "完了したときにすること"
          ? { type: "completionEffect", taskId: "t1", effectId: "ce1" }
          : { type: "actionItem", taskId: "t1", actionItemId: "a3" },
    failure: null,
    finishedAt: null,
  };
}

/**
 * 承認して書き込む
 *
 * 見せたときの版と今の版を比べ、変わっていたら（PR に commit が足された など）承認できない。取りやめて、頼み直す。
 * 見せたあとに書き込めない状態になっていたら（CI が落ちた など）も、承認できない。
 */
export function approve(write: Write, actor: Actor, version: "見せた版のまま" | "変わった", ready: Ready): Write {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(write.stage === "確認中", "確認中のときだけ");
  ensure(version === "見せた版のまま", "見せた版が今も同じときだけ");
  ensure(ready === "書き込める", "書き込める状態のときだけ");
  return { ...write, stage: "書き込み中", approval: { at: "2026-11-28T00:00:00Z" } };
}

/** 確認をやめる */
export function cancel(write: Write, actor: Actor): Write {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(write.stage === "確認中", "確認中のときだけ");
  return { ...write, stage: "取りやめた" };
}

/** 確認中に、書き込む意味がなくなったので取りやめる（対象が閉じた・消えた、Action Item をやらなくなった） */
export function withdraw(write: Write, actor: Actor): Write {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(write.stage === "確認中", "確認中のときだけ");
  return { ...write, stage: "取りやめた" };
}

/** 書き込めた */
export function succeed(write: Write, actor: Actor): Write {
  ensure(actor.kind === "target", "書き込み先だけ");
  ensure(write.stage === "書き込み中", "書き込み中のときだけ");
  return { ...write, stage: "書き込んだ", finishedAt: "2026-11-28T00:01:00Z" };
}

/**
 * 断られた
 *
 * 理由を残す。やり直すときは、新しく書き込みを頼む（中身を確かめ直す）。
 */
export function fail(write: Write, actor: Actor, kind: "権限が足りない" | "書き込み先のエラー"): Write {
  ensure(actor.kind === "target", "書き込み先だけ");
  ensure(write.stage === "書き込み中", "書き込み中のときだけ");
  return { ...write, stage: "失敗", failure: { kind, message: "" }, finishedAt: "2026-11-28T00:01:00Z" };
}

/**
 * 起動したとき、書き込み中のまま残っていた
 *
 * 書き込みの途中でアプリが止まると、書けたかが分からない。やり直すと二重に書き込むかもしれないので、やり直さずに外を確かめる。
 */
export function interrupt(write: Write, actor: Actor): Write {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(write.stage === "書き込み中", "書き込み中のときだけ");
  return { ...write, stage: "書けたか分からない" };
}

/** 外を確かめて、書けていたかを決める（merge 済みか・アーカイブ済みか） */
export function settle(write: Write, actor: Actor, result: "書けていた" | "書けていなかった"): Write {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(write.stage === "書けたか分からない", "書けたか分からないときだけ");
  return result === "書けていた"
    ? { ...write, stage: "書き込んだ", finishedAt: "2026-11-28T00:05:00Z" }
    : { ...write, stage: "失敗", failure: { kind: "書けていなかった", message: "" }, finishedAt: "2026-11-28T00:05:00Z" };
}

const FROM_ITEM: Request = { way: "Action Item", item: "番が来ていて、まだ", sameAsDefinition: true, openWrite: false };
const FROM_RULE: Request = { way: "ルール", rule: "有効", inScope: true, alreadyWritten: false };
const FROM_EFFECT: Request = { way: "完了したときにすること", taskDone: true };

export const inputs = {
  initial: {
    "Action Item から": [FROM_ITEM, "書き込める"],
    ルールから: [FROM_RULE, "書き込める"],
    書き込めない: [FROM_ITEM, "書き込めない"],
    番待ち: [{ ...FROM_ITEM, item: "番待ち" }, "書き込める"],
    済んだ: [{ ...FROM_ITEM, item: "済んでいる" }, "書き込める"],
    定義と違う: [{ ...FROM_ITEM, sameAsDefinition: false }, "書き込める"],
    書き込みがもうある: [{ ...FROM_ITEM, openWrite: true }, "書き込める"],
    止めたルール: [{ ...FROM_RULE, rule: "止めてある" }, "書き込める"],
    範囲の外: [{ ...FROM_RULE, inScope: false }, "書き込める"],
    書き込み済み: [{ ...FROM_RULE, alreadyWritten: true }, "書き込める"],
    完了したときにすること: [FROM_EFFECT, "書き込める"],
    やらないことにした: [{ way: "完了したときにすること", taskDone: false }, "書き込める"],
  },
  approve: { 見せたとおり: ["見せた版のまま", "書き込める"], 版が変わった: ["変わった", "書き込める"], "CI が落ちた": ["見せた版のまま", "書き込めない"] },
  fail: { 権限: ["権限が足りない"], 書き込み先: ["書き込み先のエラー"] },
  settle: { 書けていた: ["書けていた"], 書けていなかった: ["書けていなかった"] },
};

const APPROVED: Stage[] = ["書き込み中", "書けたか分からない", "書き込んだ", "失敗"];
const FINISHED: Stage[] = ["書き込んだ", "失敗", "取りやめた"];

export const invariants = {
  "書き込むのは、承認があるときだけ": (write: Write) => APPROVED.includes(write.stage) === (write.approval !== null),
  "終わった書き込みは、もう変わらない": (before: Write, after: Write) => !FINISHED.includes(before.stage) || before.stage === after.stage,
  "承認の対象（何に・どの操作で・どの中身を・どの版に）は、作ったあと変わらない": (before: Write, after: Write) =>
    before.subject.uri === after.subject.uri &&
    before.operation === after.operation &&
    JSON.stringify(before.params) === JSON.stringify(after.params) &&
    before.version === after.version,
};

export const links = [
  { from: succeed, to: "task", label: "Action Item から頼まれたなら、その Action Item を果たす（書き込みで果たされる）" },
  { from: settle, to: "task", label: "書けていたなら、Action Item から頼まれたものは、その Action Item を果たす" },
  { from: fail, to: "task", label: "Action Item から頼まれたなら、その Task に、書き込めなかったことと理由を知らせる（ルールからなら、アプリが通知する）" },
];

export const scenarios = {
  "Task が完了したら、完了したときにすることを確かめずに書き込む": [
    { do: initial, by: "アプリ", input: "完了したときにすること", expect: { stage: "書き込み中", requestedBy: { type: "completionEffect" } } },
  ],
  "やらないことにした Task の、完了したときにすることは書き込まない": [
    { do: initial, by: "アプリ", input: "やらないことにした", denied: "Task が完了したときだけ（やらないことにしたときは書き込まない）" },
  ],
  "merge の中身を確かめて承認し、merge する": [
    { do: initial, by: "ユーザー", input: "Action Item から", expect: { stage: "確認中", approval: null } },
    { do: approve, by: "ユーザー", input: "見せたとおり", expect: { stage: "書き込み中" } },
    { do: succeed, by: "書き込み先", expect: { stage: "書き込んだ" } },
  ],
  "番が来ていない Action Item からは頼めない": [{ do: initial, by: "ユーザー", input: "番待ち", denied: "Action Item に番が来ていて、まだ済んでいないときだけ" }],
  "済んだ Action Item からは頼めない": [{ do: initial, by: "ユーザー", input: "済んだ", denied: "Action Item に番が来ていて、まだ済んでいないときだけ" }],
  "Action Item の定義と違う書き込みは頼めない": [{ do: initial, by: "ユーザー", input: "定義と違う", denied: "Action Item の定義と同じ対象と操作だけ" }],
  "同じ Action Item から二重には頼めない": [{ do: initial, by: "ユーザー", input: "書き込みがもうある", denied: "その Action Item に、終わっていない書き込みがないときだけ" }],
  "CI が通っていなければ、merge を頼めない": [{ do: initial, by: "ユーザー", input: "書き込めない", denied: "書き込める状態のときだけ" }],
  "見せたあとに PR が変わった・CI が落ちたら、merge しない": [
    { do: initial, by: "ユーザー", input: "Action Item から" },
    { do: approve, by: "ユーザー", input: "版が変わった", denied: "見せた版が今も同じときだけ" },
    { do: approve, by: "ユーザー", input: "CI が落ちた", denied: "書き込める状態のときだけ" },
    { do: cancel, by: "ユーザー", expect: { stage: "取りやめた" } },
    { do: approve, by: "ユーザー", input: "見せたとおり", denied: "確認中のときだけ" },
  ],
  "確認中に PR が閉じられたら、取りやめる": [
    { do: initial, by: "ユーザー", input: "Action Item から" },
    { do: withdraw, by: "アプリ", expect: { stage: "取りやめた" } },
  ],
  "断られたら理由を残し、終わる（やり直すときは頼み直す）": [
    { do: initial, by: "ユーザー", input: "Action Item から" },
    { do: approve, by: "ユーザー", input: "見せたとおり" },
    { do: fail, by: "書き込み先", input: "権限", expect: { stage: "失敗", failure: { kind: "権限が足りない" } } },
    { do: succeed, by: "書き込み先", denied: "書き込み中のときだけ" },
  ],
  "書き込み中にアプリが止まったら、やり直さずに外を確かめる": [
    { do: initial, by: "ユーザー", input: "Action Item から" },
    { do: approve, by: "ユーザー", input: "見せたとおり" },
    { do: interrupt, by: "アプリ", expect: { stage: "書けたか分からない" } },
    { do: succeed, by: "書き込み先", denied: "書き込み中のときだけ" },
    { do: settle, by: "同期", input: "書けていた", expect: { stage: "書き込んだ" } },
  ],
  "確かめて書けていなかったら、失敗にする": [
    { do: initial, by: "アプリ", input: "ルールから" },
    { do: interrupt, by: "アプリ" },
    { do: settle, by: "同期", input: "書けていなかった", expect: { stage: "失敗", failure: { kind: "書けていなかった" } } },
  ],
  "Task を完了にしたら、有効にした組み込みのルールでメールをアーカイブする": [
    { do: initial, by: "アプリ", input: "ルールから", expect: { stage: "書き込み中", requestedBy: { type: "rule" } } },
    { do: approve, by: "ユーザー", input: "見せたとおり", denied: "確認中のときだけ" },
    { do: succeed, by: "書き込み先", expect: { stage: "書き込んだ" } },
  ],
  "止めたルール（初めの組み込みのルール）では書き込まない": [{ do: initial, by: "アプリ", input: "止めたルール", denied: "有効なルールだけ（組み込みのルールは、ユーザーが有効にしたものだけ）" }],
  "ルールの範囲の外の操作は、ルールでは書き込まない": [{ do: initial, by: "アプリ", input: "範囲の外", denied: "ルールの範囲の操作だけ" }],
  "同じものに同じルールで二度は書き込まない": [{ do: initial, by: "アプリ", input: "書き込み済み", denied: "同じものに同じルールで書き込むのは一度だけ" }],
  "Action Item からの書き込みは、アプリが頼めない": [{ do: initial, by: "アプリ", input: "Action Item から", denied: "Action Item からはユーザー、ルール・完了したときにすることからはアプリだけ" }],
  "ルールからの書き込みは、ユーザーが頼めない": [{ do: initial, by: "ユーザー", input: "ルールから", denied: "Action Item からはユーザー、ルール・完了したときにすることからはアプリだけ" }],
  "書き込みは決まった人と段階でだけ進む": [
    { do: initial, by: "ユーザー", input: "Action Item から" },
    { do: succeed, by: "書き込み先", denied: "書き込み中のときだけ" },
    { do: fail, by: "書き込み先", input: "権限", denied: "書き込み中のときだけ" },
    { do: interrupt, by: "アプリ", denied: "書き込み中のときだけ" },
    { do: settle, by: "同期", input: "書けていた", denied: "書けたか分からないときだけ" },
    { do: approve, by: "アプリ", input: "見せたとおり", denied: "ユーザーだけ" },
    { do: cancel, by: "アプリ", denied: "ユーザーだけ" },
    { do: withdraw, by: "ユーザー", denied: "アプリだけ" },
    { do: approve, by: "ユーザー", input: "見せたとおり" },
    { do: cancel, by: "ユーザー", denied: "確認中のときだけ" },
    { do: withdraw, by: "アプリ", denied: "確認中のときだけ" },
    { do: succeed, by: "ユーザー", denied: "書き込み先だけ" },
    { do: fail, by: "アプリ", input: "権限", denied: "書き込み先だけ" },
    { do: interrupt, by: "ユーザー", denied: "アプリだけ" },
    { do: interrupt, by: "アプリ" },
    { do: settle, by: "アプリ", input: "書けていた", denied: "同期だけ" },
  ],
};

export const reviewed = {
  "ignores-input:fail": "断られた理由の種類で、書き込みの振る舞いは変わらない。理由は残して、ユーザーへの案内（何をすれば書き込めるか・書き込み先の画面から操作する）を変えるのに使う",
  "unused-field:params": "操作ごとの中身は書き込み先にそのまま渡すもので、段階の進み方は変えない。作ったあと変わらない（承認したあとに差し替えない）ことを、不変条件で確かめるために読んでいる",
  "unused-field:version": "見せた版と今の版の比べは、承認の入力（見せた版のまま・変わった）で表す。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:operation": "どの操作かで、書き込みの段階の進み方は変わらない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:approval": "承認があるかは段階で決まり、操作の可否は段階で決める。承認を読むのは、承認なしに書き込まないこと（charter）を不変条件で確かめるため",
};
