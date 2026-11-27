/**
 * 待つ条件（何が起きるのを待つか）。条件で果たされる Action Item が持ち、Watcher が確かめる。
 * 種類（kind）ごとに、要るものが違う。どの種類も、見張る対象をアカウントと uri の組で指す（URL とは限らない）。
 * 確かめ方は Source ごとに違うので、各 Source の Adapter が持つ（ADR-0008）。ここでは、何を待つかだけを書く。
 * 困った状態（conflict・CI の失敗・返信が決まった時間ないなど）は、待つ条件ではない。その対象の Source Item の事実の行（「conflict: あり」「返信: 48 時間なし」）として届く。
 */
export type Condition =
  /** PR が merge される */
  | { kind: "merged"; subject: Subject }
  /** since より後に、レビューが付く */
  | { kind: "review_submitted"; subject: Subject; since: string }
  /** since より後に、対象に動きがある（何を待つかが分からない待ち。返信待ちなど） */
  | { kind: "item_changed"; subject: Subject; since: string }
  /** since より後に、返信が来る */
  | { kind: "reply_received"; subject: Subject; since: string }
  /** 検索に当たる PR が開かれる（依存先の PR が出る など） */
  | { kind: "pull_request_opened"; accountId: string; repository: string; query: string }
  /** 自分の PR の merge commit が、検索に当たる開いた PR（deploy の PR など）に入る */
  | { kind: "included_in_pull_request"; subject: Subject; repository: string; query: string }
  /** 自分の PR の merge commit を含む commit で、ワークフロー（ファイル名）が成功する */
  | { kind: "workflow_succeeded"; subject: Subject; repository: string; workflow: string };

/** 見張る対象（アカウントと、Source の中で見分ける識別子） */
export type Subject = {
  /** どのアカウントで見るか */
  accountId: string;
  /** Source の中で、対象を見分ける識別子（github:acme/app/pull/42 など） */
  uri: string;
};

const subjectsOf = (condition: Condition): Subject[] => ("subject" in condition ? [condition.subject] : []);

export const invariants = {
  "見張る対象は、アカウントと識別子を持つ": (condition: Condition) => subjectsOf(condition).every((s) => s.accountId.trim() !== "" && s.uri.trim() !== ""),
  "検索・ワークフローで待つ条件は、アカウントとリポジトリを持つ": (condition: Condition) =>
    (condition.kind !== "pull_request_opened" || (condition.accountId.trim() !== "" && condition.repository.trim() !== "")) &&
    ((condition.kind !== "included_in_pull_request" && condition.kind !== "workflow_succeeded") || condition.repository.trim() !== ""),
  "ワークフローで待つ条件は、ワークフローを持つ": (condition: Condition) => condition.kind !== "workflow_succeeded" || condition.workflow.trim() !== "",
  "検索で待つ条件は、検索の条件を持つ": (condition: Condition) =>
    (condition.kind !== "pull_request_opened" && condition.kind !== "included_in_pull_request") || condition.query.trim() !== "",
};

const pr: Subject = { accountId: "github-work", uri: "github:acme/app/pull/42" };

export const examples = {
  valid: {
    "merge を待つ": { kind: "merged", subject: pr },
    "待ち始めたあとのレビューを待つ": { kind: "review_submitted", subject: pr, since: "2026-11-28T00:00:00Z" },
    "送ったメールに返信が来る": { kind: "reply_received", subject: { accountId: "gmail-private", uri: "gmail:thread/18c2f" }, since: "2026-11-28T00:00:00Z" },
    "deploy の PR に入るのを待つ": { kind: "included_in_pull_request", subject: pr, repository: "acme/deploy", query: "is:open label:release" },
  },
  invalid: {
    "対象の識別子が空": { kind: "merged", subject: { accountId: "github-work", uri: "" } },
    "リポジトリのない検索": { kind: "pull_request_opened", accountId: "github-work", repository: "", query: "is:open" },
    "ワークフローの名前がない": { kind: "workflow_succeeded", subject: pr, repository: "acme/app", workflow: " " },
    "検索の条件がない": { kind: "pull_request_opened", accountId: "github-work", repository: "acme/app", query: " " },
  },
} satisfies { valid: Record<string, Condition>; invalid: Record<string, Condition> };
