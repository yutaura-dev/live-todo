import { ensure } from "@yutaura/live-spec";

/**
 * Task Change（Task の項目の変化 1 つ）。どの項目が、何から何に、だれによって変わったかを残す。
 * 更新マークは、未読の Task Change がある Task に付く（Task ごとに、未読があるかを数えて出す）。Source 側の変化（事実が変わった・増えた）には付かず、それを受け取って Task の項目が変わったときだけ付く。
 * 自分で変えたことは知っているので、ユーザーが変えた変化は初めから既読にする。
 * Task の数える項目を変えるときは、同じときに Task Change も残す（あとから反応で作ると、取りこぼして更新マークが付かないことがあるため）。
 */
export type TaskChange = {
  /** 見たか */
  status: Status;
  /** Task Change を見分ける ID */
  id: string;
  /** @ref task */
  taskId: string;
  /** どの項目が変わったか */
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
export type ChangedField = "列" | "どう終わったか" | "何をするか" | "今の状況と次の一手" | "計画" | "Action Item の進み" | "完了条件";

/** だれが変えたか */
export type Changer = "ユーザー" | "AI" | "同期" | "ルール" | "アプリ";

/** 変化の例（数える項目と、数えない項目） */
type Field = ChangedField | "事実" | "AI が作業中か" | "最後に変えた日時";

const COUNTED: Field[] = ["列", "どう終わったか", "何をするか", "今の状況と次の一手", "計画", "Action Item の進み", "完了条件"];

type Actor = { kind: "user" } | { kind: "agent" } | { kind: "sync" } | { kind: "rule" } | { kind: "app" };

/** Task を変えた人。AI: 事実の変化を受け取って Task を導き直す・計画を考える・Claude Code が Action Item を果たす。同期: 待つ条件で Action Item が果たされる。ルール: ルールで Task を変える。アプリ: 承認した書き込みで Action Item が果たされる・定期の Task を作る */
export const actors: Record<string, Actor> = {
  ユーザー: { kind: "user" },
  AI: { kind: "agent" },
  同期: { kind: "sync" },
  ルール: { kind: "rule" },
  アプリ: { kind: "app" },
};

const CHANGER: Record<Actor["kind"], Changer> = { user: "ユーザー", agent: "AI", sync: "同期", rule: "ルール", app: "アプリ" };

/**
 * Task の項目が変わった
 *
 * ユーザーが変えたなら既読、ほかの人（AI・同期・ルール）が変えたなら未読にする。数えない項目の変化では作らない。
 */
export function initial(actor: Actor, field: Field): TaskChange {
  ensure(COUNTED.includes(field), "Task の言葉で持つ項目の変化だけ（事実の変化・AI が作業中か・最後に変えた日時は数えない）");
  return {
    status: actor.kind === "user" ? "既読" : "未読",
    id: "c1",
    taskId: "t1",
    field: field as ChangedField,
    before: "レビュー待ち",
    after: "レビューで指摘が 2 件。直す",
    by: CHANGER[actor.kind],
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

export const inputs = {
  initial: {
    今の状況が変わった: ["今の状況と次の一手"],
    列が変わった: ["列"],
    "Action Item が済んだ": ["Action Item の進み"],
    事実が変わった: ["事実"],
    作業中になった: ["AI が作業中か"],
    日時だけ変わった: ["最後に変えた日時"],
  },
};

export const invariants = {
  "見た変化は、未読に戻らない": (before: TaskChange, after: TaskChange) => before.status === "未読" || after.status === "既読",
};

export const scenarios = {
  "AI が今の状況を書き換えたら更新マークが付き、見たら消える": [
    { do: initial, by: "AI", input: "今の状況が変わった", expect: { status: "未読", by: "AI" } },
    { do: read, by: "AI", denied: "ユーザーだけ" },
    { do: read, by: "ユーザー", expect: { status: "既読" } },
    { do: read, by: "ユーザー", denied: "未読のときだけ" },
  ],
  "Task を開いたら、その Task の未読はまとめて消える": [
    { do: initial, by: "ルール", input: "列が変わった", expect: { status: "未読" } },
    { do: openTask, by: "AI", denied: "ユーザーだけ" },
    { do: openTask, by: "ユーザー", expect: { status: "既読" } },
    { do: openTask, by: "ユーザー", expect: { status: "既読" } },
  ],
  "承認した書き込みで Action Item が果たされたら、更新マークが付く": [{ do: initial, by: "アプリ", input: "Action Item が済んだ", expect: { status: "未読", by: "アプリ" } }],
  "Claude Code が Action Item を果たしたら、更新マークが付く": [{ do: initial, by: "AI", input: "Action Item が済んだ", expect: { status: "未読" } }],
  "待つ条件が成り立って Action Item が果たされたら、更新マークが付く": [{ do: initial, by: "同期", input: "Action Item が済んだ", expect: { status: "未読", by: "同期" } }],
  "ルールで Task を完了にしたら、更新マークが付く": [{ do: initial, by: "ルール", input: "列が変わった", expect: { status: "未読", by: "ルール" } }],
  "自分で列を動かしても、更新マークは付かない": [{ do: initial, by: "ユーザー", input: "列が変わった", expect: { status: "既読", by: "ユーザー" } }],
  "事実が変わっただけでは、更新マークは付かない": [
    { do: initial, by: "同期", input: "事実が変わった", denied: "Task の言葉で持つ項目の変化だけ（事実の変化・AI が作業中か・最後に変えた日時は数えない）" },
  ],
  "AI が作業中になっただけでは、更新マークは付かない": [
    { do: initial, by: "AI", input: "作業中になった", denied: "Task の言葉で持つ項目の変化だけ（事実の変化・AI が作業中か・最後に変えた日時は数えない）" },
  ],
  "最後に変えた日時だけでは、更新マークは付かない": [
    { do: initial, by: "AI", input: "日時だけ変わった", denied: "Task の言葉で持つ項目の変化だけ（事実の変化・AI が作業中か・最後に変えた日時は数えない）" },
  ],
};

export const reviewed = {
  "equivalent-states:既読/既読/既読/既読/既読/既読/既読/既読/既読/既読/既読/既読/既読/既読/既読": "どの項目が・だれが変えたかは、見せるための記録で、見たかの振る舞いは変えない（入力の例ごとに値が違うので、別の状態に見えている）",
  "anytime:openTask": "Task を開いたら、その Task の変化をまとめて既読にする。既読の変化は既読のまま変わらないので、どの状態でも通してよい",
};

export const questions = [
  {
    ask: "どの項目にも入らない「知らせ」をどう扱うか？（書き込めなかった理由・ADR-0016 の AI の作業をやめた理由 など） 案 A: 今の状況と次の一手（brief）の書き換えとして扱う。案 B: 「知らせ」という項目を足す",
    about: initial,
  },
  {
    ask: "新しく出た Task（同期が列を決めた）にも、更新マークを付けるか？ 新しいことは別の印（新着）で見せるほうがよいか？",
    about: { status: "未読" },
  },
  {
    ask: "同期が絞り込みの外として片付けた Task はボードに出ないので、その変化はずっと未読のまま残る。終わった Task の変化は初めから既読にしてよいか？ それとも、終わった Task も見られるところに未読を出すか？",
    about: { status: "未読" },
  },
  {
    ask: "ユーザーが決めたルールで変えた変化・承認した書き込みで果たされた変化は、ユーザーが決めた・承認したことの結果だが、未読にしてよいか？（案: 未読にする。起きたタイミングは見ていないので）",
    about: initial,
  },
  {
    ask: "未読の変化がある項目を、ユーザーが自分で直したら、その項目の未読を既読にするか？",
    about: read,
  },

  {
    ask: "見る前に、同じ項目が元の値に戻ったら（AI が今の状況を書き換え、すぐ元に戻した など）、更新マークを消すか？ 案: 消さない（変化があったことは残す）。ただし、同じ項目の未読の変化は 1 つにまとめて、最初の前と最後の後を見せる",
    about: initial,
  },
];
