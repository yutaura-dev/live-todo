import { ensure } from "@yutaura/live-spec";
import type { Level } from "./autonomy-policy.spec.ts";
import type { Subject } from "./condition.value.ts";

/**
 * Write（外への書き込み 1 回。PR を merge する・修正を push する・メールをアーカイブする・Slack の To-do を済ませる など）。
 * 承認がなければ書き込まない（charter）。承認のしかたは、何から頼まれたかで決まる。
 * - Action Item から頼まれた: ユーザーが中身を確かめて承認する。自動でやってよい範囲（Autonomy Policy）に入る書き込みは、ユーザーが範囲を決めたことを承認とみなし、アプリが確かめずに書き込む（ADR-0023）
 * - 完了したときにすることから頼まれた: ユーザーが完了待ちのチェックリストを確かめて、完了のボタン（書き込めなかったものは、もう一度頼むボタン）を押したことが承認になる
 * ルールでの書き込み（ルールを決めたことを承認とみなす）は、Rule を捉え直すときに決め直す。
 * 何を書き込めるか・どう書き込むかは、Source ごとの provider（Adapter）が決めて実装する。
 * 書き込んだ結果、外の世界が変わると、その変化は同期で Source Item に戻ってくる。同じ事実を持つ Task は、それぞれ事実の変化として受け取る。
 */
export type Write = {
  /** 書き込みの段階 */
  stage: Stage;
  /** 承認（まだなければ null）。承認のしかたは、何から頼まれたかで決まる 。自動でやってよい範囲による承認なら、そのときの操作と上限も残す（あとで範囲を変えても、なぜ書き込んだかを追えるように） */
  approval: { by: "ユーザーが確かめた" | "自動でやってよい範囲" | "完了のボタン"; at: string; policy: { operation: string; limit: Level } | null } | null;
  /** Write を見分ける ID */
  id: string;
  /** 何に書き込むか。作る操作（draft の PR を作る・返信の下書きを作る など）では、作る元の事実（issue #12 を直す PR なら issue #12、返信の下書きならそのスレッド）。下書きは同期で戻ってこないので、元の事実への書き込みのまま扱う */
  subject: Subject;
  /** 作る操作で、作る場所（PR を作るリポジトリ・下書きを置くスレッド）。作らない操作では null。自動で書き込めるのは、作る元の事実と同じ場所（同じリポジトリ・同じスレッド）のときだけ（判断表「自動でやってよいか」の書き込む先で「元の事実と違う場所に作る」になり、ユーザーの承認に回る） */
  place: Subject | null;
  /** 作る操作で書き込めたとき、書き込み先が返した作ったもの（PR・issue など、同期で戻ってくるもの）。書き込み先が返した URI が作る場所の中にあるときだけ持つ（外なら持たず、ふつうの振り分けに任せる）。書けたか分からず、あとで書けていたと分かったときは持たない（作ったものは見張りや同期の取り込みで届き、ふつうに振り分ける）。同期で届いたとき、これと URI が一致すれば、この Write の Task に振り分ける */
  created: Subject | null;
  /** どの操作か。provider が決めた名前（github.merge・github.push・gmail.archive・slack.complete_todo など） */
  operation: string;
  /** 操作ごとの中身（merge の方法・返信の本文・アーカイブするメールの一覧 など）。形は provider が操作ごとに決め、デコードして確かめる。ドメインは中身を読まず、書き込み先にそのまま渡す */
  params: unknown;
  /** 見せたときの対象の版（PR の head の commit など）。承認するとき、今の版と比べる。どの操作にも共通の決まりなので、中身とは分けて持つ 。版を持たない書き込み（メールをアーカイブする など）は null で、そのときは版を比べない */
  version: string | null;
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
  /** 完了したときにすること。ユーザーが完了待ちのチェックリストを確かめて、完了のボタンを押したことが承認になる */
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
export type FailureKind = "権限が足りない" | "書き込み先のエラー" | "書けていなかった" | "書けたか確かめられない" | "アカウントを外した";

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

/** 書き込める状態か（provider が決める。merge なら CI がすべて通っていて conflict がない など）。書き込み先のアカウントがつないでいないなら、書き込めない */
type Ready = "書き込める" | "書き込めない";

/** 頼むときに確かめること。Action Item・Task の状態は、それぞれの集約が持つ */
type Request =
  | {
      way: "Action Item";
      /** その Action Item の番と状態 */
      item: "番が来ていて、まだ" | "番待ち" | "済んでいる";
      /** Action Item の定義にある、対象と操作と同じか */
      sameAsDefinition: boolean;
      /** その Action Item に、終わっていない書き込みがもうあるか */
      openWrite: boolean;
      /** 判断表「自動でやってよいか」（Autonomy Policy）の答え。書き込む先が、その Task が追っている事実そのものかも含めて決まる */
      policy: "自動でやる" | "ユーザーが頼む・承認する";
      /** 自動で書き込むとき、計画を立てた（Agent が調べた）ときの対象の版（Action Item の中身に持つ）が今も同じか。中身も Action Item の中身をそのまま写す */
      planVersion: "計画の版のまま" | "変わった";
      /** その Task の列（自動で書き込むのは todo のときだけ。要確認は AI の判定が割れたので、完了待ちはもう終えるので、自動では書き込まない） */
      taskColumn: "todo" | "要確認・完了待ち";
      /** その Action Item が、番が来たら自動でやるものか（ボタンで頼むものは、範囲に入っていても自動では書き込まない） */
      trigger: "auto" | "on_request";
      /** この Action Item から、もう自動で頼んだことがあるか（自動の承認で作った書き込みが前にあるか。自動で頼むのは 1 回だけ。失敗したあとはユーザーが頼む） */
      autoTried: boolean;
    }
  | {
      way: "完了したときにすること";
      /** 完了待ちで、ユーザーが完了のボタン（書き込めなかったものは、もう一度頼むボタン）を押したか */
      confirmed: boolean;
      /** その完了したときにすることに、終わっていない書き込みがもうあるか */
      openWrite: boolean;
      /** 版を持つ操作（merge など）なら、見せたときの版が今も同じか */
      version: "版を持たない" | "見せた版のまま" | "変わった";
    };

type Actor = { kind: "user" } | { kind: "app" } | { kind: "sync" } | { kind: "target" };

/** アプリ: 完了したときにすることを頼む・起動したときに確かめるなど、アプリが自分で起こす処理。同期: Source から外の状態を取り込む処理 */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  アプリ: { kind: "app" },
  同期: { kind: "sync" },
  書き込み先: { kind: "target" },
};

/**
 * 書き込みを頼む
 *
 * Action Item から頼むもの（merge のボタンなど）は、ユーザーが頼み、中身を見せて確認中になる。完了したときにすることから頼むものは、ユーザーが完了待ちのチェックリストを確かめて完了のボタンを押したことが承認なので、すぐ書き込む。
 */
export function initial(actor: Actor, request: Request, ready: Ready): Write {
  ensure(
    request.way === "Action Item" ? actor.kind === "user" || (actor.kind === "app" && request.policy === "自動でやる") : actor.kind === "app",
    "Action Item からはユーザー（自動でやってよい範囲ならアプリも）、完了したときにすることからはアプリだけ",
  );
  ensure(ready === "書き込める", "書き込める状態のときだけ");
  if (request.way === "Action Item" && actor.kind === "app") {
    ensure(request.trigger === "auto", "自動で書き込むのは、番が来たら自動でやる Action Item だけ（ボタンで頼むものは、ユーザーが頼む）");
    ensure(request.taskColumn === "todo", "自動で書き込むのは、Task が todo のときだけ（要確認・完了待ちでは、ユーザーが頼む）");
    ensure(request.planVersion === "計画の版のまま", "自動で書き込むのは、計画を立てたときの版が今も同じときだけ");
    ensure(!request.autoTried, "自動で頼むのは、Action Item ごとに 1 回だけ（失敗したあとはユーザーが頼む）");
  }
  if (request.way === "Action Item") {
    ensure(request.item === "番が来ていて、まだ", "Action Item に番が来ていて、まだ済んでいないときだけ");
    ensure(request.sameAsDefinition, "Action Item の定義と同じ対象・操作・作る場所だけ");
    ensure(!request.openWrite, "その Action Item に、終わっていない書き込みがないときだけ");
  } else if (request.way === "完了したときにすること") {
    ensure(request.confirmed, "ユーザーが完了待ちのチェックリストを確かめて、完了のボタンを押したときだけ");
    ensure(!request.openWrite, "その完了したときにすることに、終わっていない書き込みがないときだけ");
    ensure(request.version !== "変わった", "版を持つ操作なら、見せたときの版が今も同じときだけ");
  }
  const byEffect = request.way === "完了したときにすること" || actor.kind === "app";
  return {
    stage: byEffect ? "書き込み中" : "確認中",
    approval: byEffect
      ? request.way === "完了したときにすること"
        ? { by: "完了のボタン", at: "2026-11-28T00:00:00Z", policy: null }
        : { by: "自動でやってよい範囲", at: "2026-11-28T00:00:00Z", policy: { operation: "github.merge", limit: "外への書き込み（本番）" } }
      : null,
    id: "w1",
    subject: { uri: "github://yutaura@github.com/acme/app/pull/42" },
    place: null,
    created: null,
    operation: "github.merge",
    params: { method: "squash", title: "axios を 1.8 に上げる (#42)" },
    version: "abc1234",
    summary: "squash で merge する",
    requestedBy:
      request.way === "完了したときにすること" ? { type: "completionEffect", taskId: "t1", effectId: "ce1" } : { type: "actionItem", taskId: "t1", actionItemId: "a3" },
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
  return { ...write, stage: "書き込み中", approval: { by: "ユーザーが確かめた", at: "2026-11-28T00:00:00Z", policy: null } };
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

/**
 * 外を確かめて、書けていたかを決める（merge 済みか・アーカイブ済みか）
 *
 * 外を確かめられない操作（Slack の To-do を済ませる など）は、書けたか確かめられないとして失敗にし、書き込み先で確かめるよう見せる（書けたか分からないのまま残さない。やり直さない）。
 */
export function settle(write: Write, actor: Actor, result: "書けていた" | "書けていなかった" | "確かめられない"): Write {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(write.stage === "書けたか分からない", "書けたか分からないときだけ");
  if (result === "書けていた") return { ...write, stage: "書き込んだ", finishedAt: "2026-11-28T00:05:00Z" };
  return { ...write, stage: "失敗", failure: { kind: result === "確かめられない" ? "書けたか確かめられない" : "書けていなかった", message: "" }, finishedAt: "2026-11-28T00:05:00Z" };
}

/** アカウントを外したので、書き込み中・書けたか分からない書き込みを失敗にする（外を確かめられないので。理由: アカウントを外した） */
export function abandon(write: Write, actor: Actor): Write {
  ensure(actor.kind === "app", "アプリだけ");
  ensure(write.stage === "書き込み中" || write.stage === "書けたか分からない", "書き込み中・書けたか分からないときだけ");
  return { ...write, stage: "失敗", failure: { kind: "アカウントを外した", message: "" }, finishedAt: "2026-11-28T00:05:00Z" };
}

const FROM_ITEM: Request = { way: "Action Item", item: "番が来ていて、まだ", sameAsDefinition: true, openWrite: false, policy: "ユーザーが頼む・承認する", taskColumn: "todo", trigger: "on_request", planVersion: "計画の版のまま", autoTried: false };
const FROM_EFFECT: Request = { way: "完了したときにすること", confirmed: true, openWrite: false, version: "版を持たない" };

export const inputs = {
  initial: {
    "Action Item から": [FROM_ITEM, "書き込める"],
    自動でやってよい範囲: [{ ...FROM_ITEM, trigger: "auto", policy: "自動でやる" }, "書き込める"],
    "自動だが、計画のあとに版が変わった": [{ ...FROM_ITEM, trigger: "auto", policy: "自動でやる", planVersion: "変わった" }, "書き込める"],
    "自動だが、Task が要確認": [{ ...FROM_ITEM, trigger: "auto", policy: "自動でやる", taskColumn: "要確認・完了待ち" }, "書き込める"],
    "自動で一度頼んで失敗した": [{ ...FROM_ITEM, trigger: "auto", policy: "自動でやる", autoTried: true }, "書き込める"],
    "範囲に入るが、ボタンで頼む Action Item": [{ ...FROM_ITEM, policy: "自動でやる" }, "書き込める"],
    書き込めない: [FROM_ITEM, "書き込めない"],
    番待ち: [{ ...FROM_ITEM, item: "番待ち" }, "書き込める"],
    済んだ: [{ ...FROM_ITEM, item: "済んでいる" }, "書き込める"],
    定義と違う: [{ ...FROM_ITEM, sameAsDefinition: false }, "書き込める"],
    書き込みがもうある: [{ ...FROM_ITEM, openWrite: true }, "書き込める"],
    完了したときにすること: [FROM_EFFECT, "書き込める"],
    ボタンを押していない: [{ ...FROM_EFFECT, confirmed: false }, "書き込める"],
    完了したときにすることに書き込みがもうある: [{ ...FROM_EFFECT, openWrite: true }, "書き込める"],
    "後片付けの merge": [{ ...FROM_EFFECT, version: "見せた版のまま" }, "書き込める"],
    "後片付けの merge の版が変わった": [{ ...FROM_EFFECT, version: "変わった" }, "書き込める"],
  },
  approve: { 見せたとおり: ["見せた版のまま", "書き込める"], 版が変わった: ["変わった", "書き込める"], "CI が落ちた": ["見せた版のまま", "書き込めない"] },
  fail: { 権限: ["権限が足りない"], 書き込み先: ["書き込み先のエラー"] },
  settle: { 書けていた: ["書けていた"], 書けていなかった: ["書けていなかった"] , 確かめられない: ["確かめられない"] },
};

const APPROVED: Stage[] = ["書き込み中", "書けたか分からない", "書き込んだ", "失敗"];
const FINISHED: Stage[] = ["書き込んだ", "失敗", "取りやめた"];

export const invariants = {
  "書き込むのは、承認があるときだけ": (write: Write) => APPROVED.includes(write.stage) === (write.approval !== null),
  "作ったものを持つのは、作る場所がある書き込みで、書き込んだときだけ": (write: Write) => write.created === null || (write.place !== null && write.stage === "書き込んだ"),
  "作る場所は、作ったあと変わらない": (before: Write, after: Write) => before.place?.uri === after.place?.uri,
  "自動でやってよい範囲による承認にだけ、そのときの操作と上限がある": (write: Write) =>
    write.approval === null || (write.approval.by === "自動でやってよい範囲") === (write.approval.policy !== null),
  "終わった書き込みは、もう変わらない": (before: Write, after: Write) => !FINISHED.includes(before.stage) || before.stage === after.stage,
  "承認の対象（何に・どの操作で・どの中身を・どの版に）は、作ったあと変わらない": (before: Write, after: Write) =>
    before.subject.uri === after.subject.uri &&
    before.operation === after.operation &&
    JSON.stringify(before.params) === JSON.stringify(after.params) &&
    before.version === after.version,
};

export const links = [
  { from: succeed, to: "task", label: "（完了したときにすることの written）完了したときにすることから頼まれたなら、その完了したときにすることを書き込んだにする（Decisions を通さず、決まったとおりに返す）" },
  { from: fail, to: "task", label: "（完了したときにすることの failed）完了したときにすることから頼まれたなら、その完了したときにすることを書き込めなかったにする" },
  { from: settle, to: "task", label: "（完了したときにすることの written・failed）完了したときにすることから頼まれたなら、書けていたら書き込んだ（written）、書けていなかった・確かめられないなら書き込めなかった（failed）にする" },
  { from: abandon, to: "task", label: "（完了したときにすることの failed）完了したときにすることから頼まれたなら、書き込めなかったにする（理由: アカウントを外した）" },
  { from: succeed, to: "task", label: "（Action Item の completeByWrite）Action Item から頼まれたなら、その Action Item を果たす（書き込みで果たされる）" },
  { from: settle, to: "task", label: "（Action Item の completeByWrite）書けていたなら、Action Item から頼まれたものは、その Action Item を果たす" },
  { from: succeed, to: "routing", action: "route", label: "作る操作で作ったもの（PR・issue など）が同期で届いたら、この Write の Task に振り分ける（Decisions を通さず、作ったものの URI との一致で決める。URI が作る場所の中にあるときだけ）。作ったものへのそのあとの書き込みも、その操作の上限で決まる" },
  { from: fail, to: "task", action: "receive", label: "Action Item から頼まれたなら、その Task に、書き込めなかったこと（理由つき）が届く" },
  { from: settle, to: "task", action: "receive", label: "書けていなかった・確かめられないなら、Action Item から頼まれたものは、その Task に書き込めなかったこと（理由つき）が届く" },
  { from: abandon, to: "task", action: "receive", label: "Action Item から頼まれたなら、その Task に書き込めなかったこと（理由: アカウントを外した）が届く" },
];

export const scenarios = {
  "書けたか確かめられない操作は、失敗にして書き込み先で確かめてもらう": [
    { do: initial, by: "ユーザー", input: "Action Item から" },
    { do: approve, by: "ユーザー", input: "見せたとおり" },
    { do: interrupt, by: "アプリ" },
    { do: settle, by: "同期", input: "確かめられない", expect: { stage: "失敗", failure: { kind: "書けたか確かめられない", message: "" } } },
  ],
  "アカウントを外したら、書き込み中の書き込みは失敗にする": [
    { do: initial, by: "ユーザー", input: "Action Item から" },
    { do: abandon, by: "アプリ", denied: "書き込み中・書けたか分からないときだけ" },
    { do: approve, by: "ユーザー", input: "見せたとおり" },
    { do: abandon, by: "ユーザー", denied: "アプリだけ" },
    { do: abandon, by: "アプリ", expect: { stage: "失敗", failure: { kind: "アカウントを外した", message: "" } } },
  ],
  "自動で書き込むのは、計画を立てたときの版が今も同じときだけ": [
    { do: initial, by: "アプリ", input: "自動だが、計画のあとに版が変わった", denied: "自動で書き込むのは、計画を立てたときの版が今も同じときだけ" },
  ],
  "ボタンで頼む Action Item は、範囲に入っていても自動では書き込まない": [
    { do: initial, by: "アプリ", input: "範囲に入るが、ボタンで頼む Action Item", denied: "自動で書き込むのは、番が来たら自動でやる Action Item だけ（ボタンで頼むものは、ユーザーが頼む）" },
  ],
  "要確認・完了待ちの Task では、自動で書き込まない": [
    { do: initial, by: "アプリ", input: "自動だが、Task が要確認", denied: "自動で書き込むのは、Task が todo のときだけ（要確認・完了待ちでは、ユーザーが頼む）" },
  ],
  "自動で頼むのは 1 回だけ。失敗したあとはユーザーが頼む": [
    { do: initial, by: "アプリ", input: "自動で一度頼んで失敗した", denied: "自動で頼むのは、Action Item ごとに 1 回だけ（失敗したあとはユーザーが頼む）" },
  ],
  "自動でやってよい範囲の書き込みは、アプリが確かめずに書き込む（draft の PR を作る など）": [
    { do: initial, by: "アプリ", input: "自動でやってよい範囲", expect: { stage: "書き込み中", requestedBy: { type: "actionItem" }, approval: { by: "自動でやってよい範囲" } } },
    { do: succeed, by: "書き込み先", expect: { stage: "書き込んだ" } },
  ],
  "完了のボタンを押したら、完了したときにすることを確かめずに書き込む": [
    { do: initial, by: "アプリ", input: "完了したときにすること", expect: { stage: "書き込み中", requestedBy: { type: "completionEffect" } } },
  ],
  "同じ完了したときにすることから、二重には書き込まない": [
    { do: initial, by: "アプリ", input: "完了したときにすることに書き込みがもうある", denied: "その完了したときにすることに、終わっていない書き込みがないときだけ" },
  ],
  "完了のボタンを押すまで、完了したときにすることは書き込まない": [
    { do: initial, by: "アプリ", input: "ボタンを押していない", denied: "ユーザーが完了待ちのチェックリストを確かめて、完了のボタンを押したときだけ" },
  ],
  "merge の中身を確かめて承認し、merge する": [
    { do: initial, by: "ユーザー", input: "Action Item から", expect: { stage: "確認中", approval: null } },
    { do: approve, by: "ユーザー", input: "見せたとおり", expect: { stage: "書き込み中" } },
    { do: succeed, by: "書き込み先", expect: { stage: "書き込んだ" } },
  ],
  "番が来ていない Action Item からは頼めない": [{ do: initial, by: "ユーザー", input: "番待ち", denied: "Action Item に番が来ていて、まだ済んでいないときだけ" }],
  "済んだ Action Item からは頼めない": [{ do: initial, by: "ユーザー", input: "済んだ", denied: "Action Item に番が来ていて、まだ済んでいないときだけ" }],
  "Action Item の定義と違う書き込みは頼めない": [{ do: initial, by: "ユーザー", input: "定義と違う", denied: "Action Item の定義と同じ対象・操作・作る場所だけ" }],
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
    { do: initial, by: "アプリ", input: "完了したときにすること" },
    { do: interrupt, by: "アプリ" },
    { do: settle, by: "同期", input: "書けていなかった", expect: { stage: "失敗", failure: { kind: "書けていなかった" } } },
  ],
  "後片付けの merge は、見せたときの版が変わっていたら書き込まない": [
    { do: initial, by: "アプリ", input: "後片付けの merge の版が変わった", denied: "版を持つ操作なら、見せたときの版が今も同じときだけ" },
  ],
  "後片付けの merge は、見せた版のままなら書き込む": [
    { do: initial, by: "アプリ", input: "後片付けの merge", expect: { stage: "書き込み中" } },
    { do: approve, by: "ユーザー", input: "見せたとおり", denied: "確認中のときだけ" },
    { do: succeed, by: "書き込み先", expect: { stage: "書き込んだ" } },
  ],
  "自動でやってよい範囲に入らない Action Item からの書き込みは、アプリが頼めない": [{ do: initial, by: "アプリ", input: "Action Item から", denied: "Action Item からはユーザー（自動でやってよい範囲ならアプリも）、完了したときにすることからはアプリだけ" }],
  "完了したときにすることからの書き込みは、ユーザーが頼めない": [{ do: initial, by: "ユーザー", input: "完了したときにすること", denied: "Action Item からはユーザー（自動でやってよい範囲ならアプリも）、完了したときにすることからはアプリだけ" }],
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
  "indistinguishable-example:settle:書けていなかった,確かめられない": "どちらも書き込めなかったにし、やり直さない。書けていなかったのか、確かめられなかったのか（書き込み先で確かめてもらう）は、失敗の理由として見せ分ける",
  "ignores-input:fail": "断られた理由の種類で、書き込みの振る舞いは変わらない。理由は残して、ユーザーへの案内（何をすれば書き込めるか・書き込み先の画面から操作する）を変えるのに使う",
  "unused-field:params": "操作ごとの中身は書き込み先にそのまま渡すもので、段階の進み方は変えない。作ったあと変わらない（承認したあとに差し替えない）ことを、不変条件で確かめるために読んでいる",
  "unused-field:version": "見せた版と今の版の比べは、承認の入力（見せた版のまま・変わった）で表す。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:operation": "どの操作かで、書き込みの段階の進み方は変わらない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:approval": "承認があるかは段階で決まり、操作の可否は段階で決める。承認を読むのは、承認なしに書き込まないこと（charter）を不変条件で確かめるため",
};
