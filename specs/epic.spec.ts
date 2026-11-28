import { ensure } from "@yutaura/live-spec";

/**
 * Epic（Task をまとめる親）。Epic → Task の 2 段だけで、Epic の下に Epic は作らない（ADR-0004）。
 * Epic は自動で作る。未分類の Task のうち、同じまとまりの仕事だと判定したものが 2 つ以上あれば、それらを合わせて Epic を作る。名前と概要は chat の LLM が書く（Decisions は文章を書けないため）。
 * どの Epic に入るかは、Task が持つ（1 つの Task が入る Epic は 1 つまで。どこにも入っていなければ未分類）。新しい Task を既存の Epic に入れるかは判定で決め、答えが返らない・閾値に届かないなら未分類のままにする（まとめないだけで、取りこぼしにはならない）。
 * 既存の Epic の構成は、同期のたびには組み直さない。ユーザーは名前の変更・統合と、Task の移動を手でできる。
 */
export type Epic = {
  /** 段階 */
  status: Status;
  /** 名前を、ユーザーが決めたか（ユーザーが決めた名前は、AI が書き換えない） */
  naming: "AI が書いた" | "ユーザーが決めた";
  /** Epic を見分ける ID */
  id: string;
  /** 名前と概要 */
  title: string;
  summary: string;
  /** 統合した先（統合したときだけ） */
  /** @ref epic */
  mergedInto: string | null;
};

export const Status = {
  /** まだ終わっていない Task がある */
  active: "進行中",
  /** 入っている Task がすべて終わった（Task をやり直したら、また進行中になる） */
  done: "終わった",
  /** ほかの Epic に統合した（入っていた Task は統合先に移る） */
  merged: "統合した",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

type Actor = { kind: "agent" } | { kind: "user" } | { kind: "sync" };

/** AI: まとまる Task を見つけて Epic を作る・名前を書く。同期: Task の変化を Epic に伝える */
export const actors: Record<string, Actor> = {
  AI: { kind: "agent" },
  ユーザー: { kind: "user" },
  同期: { kind: "sync" },
};

/** まとまる未分類の Task が 2 つ以上あったので、Epic を作る */
export function initial(actor: Actor, group: "2 つ以上" | "1 つだけ"): Epic {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(group === "2 つ以上", "まとまる Task が 2 つ以上あるときだけ");
  return { status: "進行中", naming: "AI が書いた", id: "e1", title: "axios の更新", summary: "依存の更新の PR と、その確認", mergedInto: null };
}

/** 名前を変える（ユーザーが決めた名前は、AI が書き換えない） */
export function rename(epic: Epic, actor: Actor): Epic {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(epic.status !== "統合した", "統合していないときだけ");
  return { ...epic, naming: "ユーザーが決めた", title: "依存の更新" };
}

/** AI が名前と概要を書き直す（入っている Task が変わった。ユーザーが決めた名前は書き換えない） */
export function rewrite(epic: Epic, actor: Actor): Epic {
  ensure(actor.kind === "agent", "AI だけ");
  ensure(epic.status !== "統合した", "統合していないときだけ");
  ensure(epic.naming === "AI が書いた", "AI が書いた名前のときだけ（ユーザーが決めた名前は書き換えない）");
  return { ...epic, summary: "依存の更新の PR と、その確認（2 件）" };
}

/** ほかの Epic に統合する（入っていた Task は、統合先に移る） */
export function merge(epic: Epic, actor: Actor, into: "ほかの Epic" | "自分"): Epic {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(epic.status !== "統合した", "統合していないときだけ");
  ensure(into === "ほかの Epic", "ほかの Epic にだけ");
  return { ...epic, status: "統合した", mergedInto: "e2" };
}

/** 入っている Task がすべて終わった */
export function finish(epic: Epic, actor: Actor): Epic {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(epic.status === "進行中", "進行中のときだけ");
  return { ...epic, status: "終わった" };
}

/** 入っている Task をやり直すことになった・終わっていない Task が移ってきた */
export function reactivate(epic: Epic, actor: Actor): Epic {
  ensure(actor.kind === "sync", "同期だけ");
  ensure(epic.status === "終わった", "終わったときだけ");
  return { ...epic, status: "進行中" };
}

export const inputs = {
  initial: { "2 つ以上": ["2 つ以上"], "1 つだけ": ["1 つだけ"] },
  merge: { ほかの: ["ほかの Epic"], 自分: ["自分"] },
};

export const invariants = {
  "統合したときだけ、統合した先がある": (epic: Epic) => (epic.status === "統合した") === (epic.mergedInto !== null),
  "統合した Epic は、もう変わらない": (before: Epic, after: Epic) => before.status !== "統合した" || after.status === "統合した",
  "ユーザーが決めた名前は、AI の名前に戻らない": (before: Epic, after: Epic) => before.naming === "AI が書いた" || after.naming === "ユーザーが決めた",
};

export const links = [
  { from: initial, to: "task", label: "まとまった Task を、この Epic に入れる" },
  { from: merge, to: "task", label: "入っていた Task を、統合先の Epic に移す" },
];

export const scenarios = {
  "同じまとまりの Task が 2 つあれば、Epic を作り、すべて終わったら終わる": [
    { do: initial, by: "AI", input: "2 つ以上", expect: { status: "進行中", naming: "AI が書いた" } },
    { do: rewrite, by: "AI" },
    { do: finish, by: "同期", expect: { status: "終わった" } },
    { do: finish, by: "同期", denied: "進行中のときだけ" },
    { do: reactivate, by: "同期", expect: { status: "進行中" } },
    { do: reactivate, by: "同期", denied: "終わったときだけ" },
  ],
  "まとまる Task が 1 つだけなら、Epic は作らない（未分類のまま）": [{ do: initial, by: "AI", input: "1 つだけ", denied: "まとまる Task が 2 つ以上あるときだけ" }],
  "ユーザーが名前を決めたら、AI は書き換えない": [
    { do: initial, by: "AI", input: "2 つ以上" },
    { do: rename, by: "AI", denied: "ユーザーだけ" },
    { do: rename, by: "ユーザー", expect: { naming: "ユーザーが決めた" } },
    { do: rewrite, by: "AI", denied: "AI が書いた名前のときだけ（ユーザーが決めた名前は書き換えない）" },
  ],
  "ほかの Epic に統合する": [
    { do: initial, by: "AI", input: "2 つ以上" },
    { do: merge, by: "ユーザー", input: "自分", denied: "ほかの Epic にだけ" },
    { do: merge, by: "AI", input: "ほかの", denied: "ユーザーだけ" },
    { do: merge, by: "ユーザー", input: "ほかの", expect: { status: "統合した" } },
    { do: rename, by: "ユーザー", denied: "統合していないときだけ" },
    { do: rewrite, by: "AI", denied: "統合していないときだけ" },
    { do: merge, by: "ユーザー", input: "ほかの", denied: "統合していないときだけ" },
  ],
  "Epic を作るのは AI だけ": [{ do: initial, by: "ユーザー", input: "2 つ以上", denied: "AI だけ" }],
  "終わった・やり直しを伝えるのは同期だけ": [
    { do: initial, by: "AI", input: "2 つ以上" },
    { do: finish, by: "AI", denied: "同期だけ" },
    { do: finish, by: "同期" },
    { do: reactivate, by: "ユーザー", denied: "同期だけ" },
  ],
  "名前を書き直すのは AI だけ": [
    { do: initial, by: "AI", input: "2 つ以上" },
    { do: rewrite, by: "ユーザー", denied: "AI だけ" },
  ],
};

export const questions = [
  {
    ask: "Task が移されて、Epic に入っている Task が 1 つ以下になったら、Epic をどうするか？ 案: 残す（ユーザーが手で整理する）",
    about: { status: "進行中" },
  },
  {
    ask: "ユーザーが手で別の Epic に移した・未分類にした Task を、AI があとで別の Epic に入れ直してよいか？ 案: 入れ直さない（ユーザーが決めた置き場所を変えない）",
    about: initial,
  },
  {
    ask: "ユーザーが Epic を手で作れるようにするか？（ADR-0004 は自動で作るだけで、手では名前の変更・統合・移動だけ）",
    about: initial,
  },
  {
    ask: "Epic の名前と概要を書く chat の LLM は、Task のアカウントの LLM Profile を使うか？ 会社と私用の Task が同じ Epic にまとまりうるので、まとめる判定と名前を書くときに、会社のデータを許可のない Profile に送らないようにする必要がある。案: 会社と私用の Task は同じ Epic にまとめない",
    about: initial,
  },
];
