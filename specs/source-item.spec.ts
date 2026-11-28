import { ensure } from "@yutaura/live-spec";
import type { Activity, Removal } from "./activity.value.ts";
import type { Snapshot } from "./snapshot.value.ts";

/**
 * Source Item
 *
 * Source から届いた 1 件。PR・Issue・メールのスレッド・Slack の会話・予定など）。外の世界の写し（事実）で、Task のことは知らない。
 * 届いた事実が、どの Task についての事実かは、振り分け（routing）が決める。1 つの Source Item を、いくつの Task が持ってもよい。
 * Source Item は、Source での状態（開いている・マージ済み など）を正規化して持たない。状態は Source の言葉で事実の行に書き、持っている Task が変化を受け取って、Task の言葉（Action Item が果たされた・もう要らない・やり直す）に置き換える。
 */
export type SourceItem = {
  /** Source にまだあるか */
  presence: Presence;
  /** 今見えている取り込みの種類（Gmail の受信箱・ラベル など）。種類から外れても、ほかの種類に見えていれば消えない。どの種類にも見えなくなったときだけ消える */
  streams: string[];
  /** 今の姿。振り分けと判定はこれを見る */
  latest: Snapshot;
  /** 起きた出来事の履歴（起きた順）。取り込む・変わる・消える・また現れる のたびに、変わった項目の前と後を持つ出来事を 1 つ足す */
  history: Activity[];
  /** Source Item を見分ける ID */
  id: string;
  /** この事実を見分ける識別子。アカウントの origin（scheme と authority）にパスを続けたもの（github://yutaura@github.com/acme/app/pull/42・gmail://me@gmail.com/thread/18c2f… など）。開く先（URL）とは限らない。同じ事実かは、この識別子だけで決まる。どのアカウントから届いたか・どの Source かは、origin で分かる */
  uri: string;
  /** 開く先（なければ null） */
  url: string | null;
  /** 初めて届いた日時 */
  firstSeenAt: string;
};

export const Presence = {
  /** Source にある */
  present: "あり",
  /** Source から消えた。消えている間は、中身を変えない（また現れたら戻す） */
  gone: "消えた",
} as const;
export type Presence = (typeof Presence)[keyof typeof Presence];

type Actor = { kind: "sync" } | { kind: "agent" } | { kind: "user" };

/** 同期: Source から取り込む処理。Watcher が、一覧からは分からない状態（conflict しているか など）を確かめて事実として届けるのも、同期の一種 */
export const actors: Record<string, Actor> = {
  同期: { kind: "sync" },
  AI: { kind: "agent" },
  ユーザー: { kind: "user" },
};

/**
 * 取り込む
 *
 * 同じ事実かは、uri だけで決まる。取り込みはまず uri で探し、あれば「事実が変わる」か「また現れる」にする（同じ事実を 2 件作らない）。
 * 同期が、Source から初めて届いた 1 件を取り込む。Slack の会話・Gmail のスレッドのように、何件かをまとめて 1 つの事実にする単位は、Source ごとに決める。
 */
export function initial(actor: Actor): SourceItem {
  ensure(actor.kind === "sync", "同期だけ");
  return {
    presence: "あり",
    streams: ["受信箱"],
    latest: {
      title: "axios を 1.8 に上げる",
      author: "dependabot[bot]",
      fact: { trusted: [{ key: "種類", value: "PullRequest" }, { key: "状態", value: "開いている" }, { key: "あなたへのレビュー依頼", value: "あり" }], body: "" },
      sourceUpdatedAt: "2026-11-27T23:50:00Z",
      capturedAt: "2026-11-28T00:00:00Z",
    },
    history: [{ kind: "appeared", observedAt: "2026-11-28T00:00:00Z", sourceAt: "2026-11-27T23:50:00Z", removal: null, changes: [] }],
    id: "s1",
    uri: "github://yutaura@github.com/acme/app/pull/42",
    url: "https://github.com/acme/app/pull/42",
    firstSeenAt: "2026-11-28T00:00:00Z",
  };
}


/**
 * 事実が変わる
 *
 * タイトル・本文・アプリが書く行（Source での状態を含む。マージされた など）が変わった。変わった項目すべての前と後を、出来事として残す。
 * 取り込んでも中身が変わっていなければ、この操作は起きない（出来事も足さない）。
 */
export function update(item: SourceItem, actor: Actor): SourceItem {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(item.presence === "あり", "Source にあるときだけ");
  return {
    ...item,
    latest: {
      ...item.latest,
      fact: { ...item.latest.fact, trusted: [{ key: "種類", value: "PullRequest" }, { key: "状態", value: "マージ済み" }, { key: "あなたへのレビュー依頼", value: "なし" }] },
      capturedAt: "2026-11-28T01:00:00Z",
    },
    history: [
      ...item.history,
      {
        kind: "changed",
        observedAt: "2026-11-28T01:00:00Z",
        sourceAt: null,
        removal: null,
        changes: [
          { field: "trusted", key: "状態", before: "開いている", after: "マージ済み" },
          { field: "trusted", key: "あなたへのレビュー依頼", before: "あり", after: "なし" },
        ],
      },
    ],
  };
}

/**
 * Source から消える
 *
 * 削除されたのか、見張る範囲・一覧の条件から外れただけなのか（閉じた PR が一覧から抜けた など）を、消えた理由として残す。
 * 同じアカウントのどの種類にも見えなくなったときだけ消える（受信箱から外れてもラベルに残っていれば、見えている種類が減るだけ）。
 * 範囲の外になったときは、取れるなら最後の姿を取り直して、事実を変えてから消す（マージ済みだったことを、Task が「もう要らない」と取り違えないため）。
 */
export function remove(item: SourceItem, actor: Actor, removal: Removal): SourceItem {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(item.presence === "あり", "Source にあるときだけ");
  return { ...item, presence: "消えた", streams: [], history: [...item.history, { kind: "removed", observedAt: "2026-11-28T02:00:00Z", sourceAt: null, removal, changes: [] }] };
}

/**
 * 消えたものが、また現れる
 *
 * 今の姿を取り直し、消えていた間に変わった項目があれば、その前と後も出来事に残す。
 */
export function restore(item: SourceItem, actor: Actor): SourceItem {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(item.presence === "消えた", "消えたときだけ");
  return {
    ...item,
    presence: "あり",
    streams: ["受信箱"],
    latest: { ...item.latest, capturedAt: "2026-11-28T03:00:00Z" },
    history: [...item.history, { kind: "restored", observedAt: "2026-11-28T03:00:00Z", sourceAt: null, removal: null, changes: [] }],
  };
}

export const links = [
  { to: "routing", label: "取り込んだら、その事実の振り分けを始める" },
  { from: update, to: "routing", action: "factChanged", label: "事実が変わったことを、振り分けに伝える（振り分けが、持ち主の Task に伝えるか、振り分け直す）" },
  { from: remove, to: "routing", action: "factChanged", label: "事実が消えたことを、振り分けに伝える" },
  { from: restore, to: "routing", action: "factChanged", label: "事実がまた現れたことを、振り分けに伝える" },
  { from: update, to: "write", action: "withdraw", label: "対象が閉じたなら（PR が閉じられた など）、確認中の書き込みを取りやめる" },
  { from: remove, to: "write", action: "withdraw", label: "対象が消えたら、確認中の書き込みを取りやめる" },
];

export const inputs = {
  remove: { 削除された: ["削除された"], 範囲の外: ["範囲の外になった"] },
};

export const scenarios = {
  "PR が届いて変わり、消え、また現れる": [
    { do: initial, by: "同期", expect: { presence: "あり" } },
    { do: update, by: "同期", expect: { presence: "あり", latest: { fact: { body: "" } } } },
    { do: restore, by: "同期", denied: "消えたときだけ" },
    { do: remove, by: "同期", input: "範囲の外", expect: { presence: "消えた" } },
    { do: update, by: "同期", denied: "Source にあるときだけ" },
    { do: remove, by: "同期", input: "削除された", denied: "Source にあるときだけ" },
    { do: restore, by: "同期", expect: { presence: "あり" } },
  ],
  "Source の事実を変えるのは同期だけ": [
    { do: initial, by: "同期" },
    { do: update, by: "AI", denied: "同期だけ" },
    { do: remove, by: "ユーザー", input: "削除された", denied: "同期だけ" },
    { do: remove, by: "同期", input: "削除された" },
    { do: restore, by: "AI", denied: "同期だけ" },
  ],
  "取り込むのは同期だけ": [{ do: initial, by: "AI", denied: "同期だけ" }],
};



export const invariants = {
  "Source にあるときだけ、見えている種類がある": (item: SourceItem) => (item.presence === "あり") === (item.streams.length > 0),
  "見分けるための値（ID・uri・初めて届いた日時）は、変わらない": (before: SourceItem, after: SourceItem) =>
    before.id === after.id && before.uri === after.uri && before.firstSeenAt === after.firstSeenAt,
};

export const reviewed = {
  "unused-field:streams": "見えている種類は、どの種類から外れたかを同期が書き換える記録。消えるかは同期が決める（どの種類にも見えなくなったときだけ消す）。Source にあるかとそろっていることを、不変条件で確かめるために読んでいる",
  "ignores-input:remove": "削除されたか範囲の外になったかで、Source Item の振る舞いは変わらない。消えた理由は出来事に残り、Task が受け取って判定するときの材料になる",
  "unused-field:id": "見分けるための値で、振る舞いは変えない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:uri": "見分けるための値で、振る舞いは変えない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
  "unused-field:firstSeenAt": "初めて届いた日時で、振る舞いは変えない。作ったあと変わらないことを、不変条件で確かめるために読んでいる",
};
