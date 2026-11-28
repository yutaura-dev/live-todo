import { ensure } from "@yutaura/live-spec";

/**
 * Task Change（Task の項目の変化 1 つ）。どの項目が、何から何に、だれによって変わったかを残す。
 * 更新マークは、未読の Task Change がある Task に付く（Task ごとに、未読があるかを数えて出す）。Source 側の変化（事実が変わった・増えた）には付かず、それを受け取って Task の項目が変わったときだけ付く。
 * 自分で変えたことは知っているので、ユーザーが変えた変化は初めから既読にする。
 * 新しく出た Task の仕分け（列が決まった）は変化に数えない。新しく出た Task は「新着」の印で見せ、初めて開いたら消える（更新マークは、知っている Task が変わったときの印）。
 * 同じ項目の未読の変化は 1 つにまとめ、最初の前と最後の後を見せる（見る前に元の値に戻っても、変化があったことは残す）。
 * 終わった Task（ボードに出ない）の未読は、「最近片付いたもの」の一覧で見せ、見たら既読にする（AI や同期が片付けたことに気づけるように）。
 * Task の数える項目を変えるときは、同じときに Task Change も残す（あとから反応で作ると、取りこぼして更新マークが付かないことがあるため）。
 */
export type TaskChange = {
  /** 見たか */
  status: Status;
  /** Task Change を見分ける ID */
  id: string;
  /** @ref task */
  taskId: string;
  /** どの項目が変わったか（spec の例では、代表の「今の状況と次の一手」だけを持つ） */
  field: ChangedField;
  /** 変わる前と後（見せるための文） */
  before: string | null;
  after: string | null;
  /** だれが変えたか */
  by: Changer;
  /** 変わった時刻 */
  changedAt: string;
};

export const Status = {
  /** まだ見ていない（更新マークが付く） */
  unread: "未読",
  /** 見た */
  read: "既読",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

/**
 * 変化に数える項目。Task の言葉で持つ項目だけ
 * - 数えない: 事実（Source Item）が増えた・変わった・外れた（Source 側の変化。受け取って、ここの項目が変わったときだけ数える）、AI が作業中か（作業中の印で見せる）、最後に変えた日時
 */
export type ChangedField = "列" | "どう終わったか" | "何をするか" | "今の状況と次の一手" | "計画" | "Action Item の進み" | "完了条件" | "完了したときにすること";

/** だれが変えたか */
export type Changer = "ユーザー" | "AI" | "同期" | "アプリ";

/** 変化の例（数える項目と、数えない項目） */
type Field = ChangedField | "事実" | "AI が作業中か" | "最後に変えた日時" | "仕分け";

const COUNTED: Field[] = ["列", "どう終わったか", "何をするか", "今の状況と次の一手", "計画", "Action Item の進み", "完了条件", "完了したときにすること"];

type Actor = { kind: "user" } | { kind: "agent" } | { kind: "sync" } | { kind: "app" };

/** Task を変えた人。AI: 事実の変化を受け取って Task を導き直す・計画を考える・Claude Code が Action Item を果たす。同期: 待つ条件で Action Item が果たされる。アプリ: 承認した書き込みで Action Item が果たされる・定期の Task を作る */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  AI: { kind: "agent" },
  同期: { kind: "sync" },
  アプリ: { kind: "app" },
};

/**
 * Task の項目が変わった
 *
 * ユーザーが変えたなら既読、ほかの人（AI・同期・ルール）が変えたなら未読にする。数えない項目の変化では作らない。
 */
export function initial(actor: Actor, field: Field): TaskChange {
  ensure(COUNTED.includes(field), "Task の言葉で持つ項目の変化だけ（事実の変化・AI が作業中か・最後に変えた日時・新しく出た Task の仕分けは数えない）");
  return {
    status: actor.kind === "user" ? "既読" : "未読",
    id: "c1",
    taskId: "t1",
    field: "今の状況と次の一手",
    before: "レビュー待ち",
    after: "レビューで指摘が 2 件。直す",
    by: actor.kind === "user" ? "ユーザー" : "AI",
    changedAt: "2026-11-28T00:00:00Z",
  };
}

/** 変化を 1 つ見た（カードで変化を開いた） */
export function read(change: TaskChange, actor: Actor): TaskChange {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(change.status === "未読", "未読のときだけ");
  return { ...change, status: "既読" };
}

/**
 * Task を開いた
 *
 * その Task の未読の変化を、まとめて既読にする（ADR-0003）。もう既読の変化はそのまま。
 */
export function openTask(change: TaskChange, actor: Actor): TaskChange {
  ensure(actor.kind === "user", "ユーザーだけ");
  return { ...change, status: "既読" };
}

/**
 * 見る前に、同じ項目がまた変わった
 *
 * 未読の変化に重ねて、最後の後に書き換える（最初の前はそのまま）。元の値に戻っても、未読のまま残す。
 */
export function amend(change: TaskChange, actor: Actor): TaskChange {
  ensure(actor.kind !== "user", "ユーザー以外（ユーザーが変えたら、既読にする）");
  ensure(change.status === "未読", "未読のときだけ");
  return { ...change, after: "レビュー待ち（元に戻った）" };
}

/** 未読の変化がある項目を、ユーザーが自分で直した（その項目を見ているので、既読にする） */
export function editedByUser(change: TaskChange, actor: Actor): TaskChange {
  ensure(actor.kind === "user", "ユーザーだけ");
  ensure(change.status === "未読", "未読のときだけ");
  return { ...change, status: "既読" };
}

export const inputs = {
  initial: {
    今の状況が変わった: ["今の状況と次の一手"],
    列が変わった: ["列"],
    "Action Item が済んだ": ["Action Item の進み"],
    完了したときにすることを書き込めなかった: ["完了したときにすること"],
    事実が変わった: ["事実"],
    作業中になった: ["AI が作業中か"],
    日時だけ変わった: ["最後に変えた日時"],
    仕分けた: ["仕分け"],
  },
};

export const invariants = {
  "見た変化は、未読に戻らない": (before: TaskChange, after: TaskChange) => before.status === "未読" || after.status === "既読",
};

export const scenarios = {
  "AI が今の状況を書き換えたら更新マークが付き、見たら消える": [
    { do: initial, by: "AI", input: "今の状況が変わった", expect: { status: "未読" } },
    { do: read, by: "AI", denied: "ユーザーだけ" },
    { do: read, by: "ユーザー", expect: { status: "既読" } },
    { do: read, by: "ユーザー", denied: "未読のときだけ" },
  ],
  "Task を開いたら、その Task の未読はまとめて消える": [
    { do: initial, by: "AI", input: "列が変わった", expect: { status: "未読" } },
    { do: openTask, by: "AI", denied: "ユーザーだけ" },
    { do: openTask, by: "ユーザー", expect: { status: "既読" } },
    { do: openTask, by: "ユーザー", expect: { status: "既読" } },
  ],
  "承認した書き込みで Action Item が果たされたら、更新マークが付く": [{ do: initial, by: "アプリ", input: "Action Item が済んだ", expect: { status: "未読" } }],
  "Claude Code が Action Item を果たしたら、更新マークが付く": [{ do: initial, by: "AI", input: "Action Item が済んだ", expect: { status: "未読" } }],
  "待つ条件が成り立って Action Item が果たされたら、更新マークが付く": [{ do: initial, by: "同期", input: "Action Item が済んだ", expect: { status: "未読" } }],
  "完了したときにすることを書き込めなかったら、更新マークが付く": [{ do: initial, by: "アプリ", input: "完了したときにすることを書き込めなかった", expect: { status: "未読" } }],
  "自分で列を動かしても、更新マークは付かない": [{ do: initial, by: "ユーザー", input: "列が変わった", expect: { status: "既読" } }],
  "事実が変わっただけでは、更新マークは付かない": [
    { do: initial, by: "同期", input: "事実が変わった", denied: "Task の言葉で持つ項目の変化だけ（事実の変化・AI が作業中か・最後に変えた日時・新しく出た Task の仕分けは数えない）" },
  ],
  "AI が作業中になっただけでは、更新マークは付かない": [
    { do: initial, by: "AI", input: "作業中になった", denied: "Task の言葉で持つ項目の変化だけ（事実の変化・AI が作業中か・最後に変えた日時・新しく出た Task の仕分けは数えない）" },
  ],
  "新しく出た Task の仕分けでは、更新マークは付かない（新着で見せる）": [
    { do: initial, by: "同期", input: "仕分けた", denied: "Task の言葉で持つ項目の変化だけ（事実の変化・AI が作業中か・最後に変えた日時・新しく出た Task の仕分けは数えない）" },
  ],
  "見る前に同じ項目がまた変わったら、1 つにまとめる（元に戻っても残す）": [
    { do: initial, by: "AI", input: "今の状況が変わった" },
    { do: amend, by: "ユーザー", denied: "ユーザー以外（ユーザーが変えたら、既読にする）" },
    { do: amend, by: "AI", expect: { status: "未読" } },
    { do: read, by: "ユーザー" },
    { do: amend, by: "AI", denied: "未読のときだけ" },
    { do: amend, by: "同期", denied: "未読のときだけ" },
  ],
  "未読の変化がある項目をユーザーが自分で直したら、既読になる": [
    { do: initial, by: "AI", input: "今の状況が変わった" },
    { do: editedByUser, by: "AI", denied: "ユーザーだけ" },
    { do: editedByUser, by: "ユーザー", expect: { status: "既読" } },
    { do: editedByUser, by: "ユーザー", denied: "未読のときだけ" },
  ],
  "最後に変えた日時だけでは、更新マークは付かない": [
    { do: initial, by: "AI", input: "日時だけ変わった", denied: "Task の言葉で持つ項目の変化だけ（事実の変化・AI が作業中か・最後に変えた日時・新しく出た Task の仕分けは数えない）" },
  ],
};


export const reviewed = {
  "anytime:openTask": "Task を開いたら、その Task の変化をまとめて既読にする。既読の変化は既読のまま変わらないので、どの状態でも通してよい",
  "indistinguishable-actor:AI,同期,アプリ": "ユーザー以外のだれが変えても、未読になる（自分で変えたことだけ知っている）。だれが変えたかは見せるための記録",
  "equivalent-states:既読/既読": "ユーザーが変えて初めから既読の変化と、未読を見て既読になった変化は、どちらももう変わらない。だれが変えたかが違うだけ",
};

export const questions = [
  {
    ask: "項目の変化ではないが気づいてほしい出来事（AI が作業をやめた理由・書き込めなかったこと）を、今の状況と次の一手（brief）の書き換えとして表すか？（案: そうする。「知らせ」という別の項目は作らない）",
    about: initial,
  },
];
