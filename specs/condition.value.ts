/**
 * 待つ条件（何が起きるのを待つか）。条件で果たされる Action Item が持ち、Watcher が確かめる。
 * 何を確かめるか・どんな条件があるかは Source ごとに違うので、各 Source の provider（Adapter・WatchProvider）が決めて実装する（ADR-0008）。ドメインは、どの対象のどの条件を待つかだけを持ち、中身を解釈しない。
 * 待つ条件は、一度起きたら取り消されない出来事で決める（merge された・レビューが付いた・返信が来た）。「CI が通っている」のように、成り立っても崩れうる状態は待つ条件にしない（provider はこれを守る）。
 * 一覧からは分からない状態（conflict しているか・CI の結果・レビューの状態など）は、待つ条件ではない。対象の Source Item の事実の行（「conflict: あり」）として届き、それが自分に行動を求めるかは、振り分けと Task が判断する。
 */
export type Condition = {
  /** 何について待つか */
  subject: Subject;
  /** どの条件か。provider が決めた名前（github.merged・github.review_submitted・gmail.reply_received など） */
  name: string;
  /** 待ち始めたより後に起きたことだけを見るか（「待ち始める前のレビューでは済ませない」）。待ち始めた時刻は、Action Item の進み具合が持つ */
  afterStart: boolean;
  /** 何を待つかの説明（画面に出す。「PR #42 が merge される」など） */
  label: string;
};

/**
 * 見張る対象（アカウントと、Source の中で見分ける識別子）。
 * 1 つの項目（PR・メールのスレッド）だけでなく、検索やワークフローの実行も、provider が決めた識別子で表す（github:search/acme/deploy?q=… など）。
 */
export type Subject = {
  /** 対象を見分ける識別子。アカウントの origin（scheme と authority）にパスを続けたもの（github://yutaura@github.com/acme/app/pull/42）。どのアカウントで見るかは、origin で分かる */
  uri: string;
};

export const invariants = {
  "見張る対象は、アカウントの origin を頭に持つ識別子を持つ": (condition: Condition) => /^[a-z][a-z0-9-]*:\/\/[^/]+\/./.test(condition.subject.uri),
  "条件の名前は、provider の名前から始まる（provider が実装する条件だけを使う）": (condition: Condition) => /^[a-z][a-z0-9-]*\.[a-z_]+$/.test(condition.name),
  "何を待つかの説明がある": (condition: Condition) => condition.label.trim() !== "",
};

const pr: Subject = { uri: "github://yutaura@github.com/acme/app/pull/42" };

export const examples = {
  valid: {
    "merge を待つ": { subject: pr, name: "github.merged", afterStart: false, label: "PR #42 が merge される" },
    "待ち始めたあとのレビューを待つ": { subject: pr, name: "github.review_submitted", afterStart: true, label: "PR #42 にレビューが付く" },
    "deploy の PR に入るのを待つ（検索の対象）": {
      subject: { uri: "github://yutaura@github.com/search/acme/deploy?q=is:open+label:release" },
      name: "github.includes_merge_commit",
      afterStart: false,
      label: "PR #42 の変更が deploy の PR に入る",
    },
    "送ったメールに返信が来る": { subject: { uri: "gmail://me@gmail.com/thread/18c2f" }, name: "gmail.reply_received", afterStart: true, label: "見積もりの返信が来る" },
  },
  invalid: {
    "対象の識別子が空": { subject: { uri: "" }, name: "github.merged", afterStart: false, label: "merge される" },
    "provider のない条件の名前": { subject: pr, name: "merged", afterStart: false, label: "merge される" },
    "説明がない": { subject: pr, name: "github.merged", afterStart: false, label: " " },
  },
} satisfies { valid: Record<string, Condition>; invalid: Record<string, Condition> };
