import { issue, mail, pr, slack, task, watch, type RuleConditionCase } from "./rule-condition.cases.js";

// 最後に 1 回だけ測るための例（直すのに使わない）。実在の案件・人・リポジトリを書かない

const SLACK_ABOUT_MY_PR = "自分の PR について、Slack で質問されている";
const STALE_REVIEW = "レビュー依頼が来ている PR で、Slack でも催促されているもの";
const NOT_MINE_ISSUE = "自分が作成者でもアサインされてもいない Issue";
const BILLING_REPO = "acme/billing-api リポジトリの PR";
const DONE_MAIL = "対応が終わったことを知らせるメール（完了・解決のお知らせ）";
const CONFLICT = "conflict が起きている PR";

export const finalCases: ReadonlyArray<RuleConditionCase> = [
  { id: "x-slackpr-1", condition: SLACK_ABOUT_MY_PR, expected: true, task: task("x1", "クーポンの PR", [pr("f1", { author: "YutaUra", reason: "author", title: "クーポンの二重適用を防ぐ" }), slack("f2", { channel: "web-dev", speaker: "@bob", text: "@YutaUra クーポンの PR、既存の注文にも効きますか？" })]) },
  { id: "x-slackpr-2", condition: SLACK_ABOUT_MY_PR, expected: false, note: "他人の PR について", task: task("x2", "検索の PR", [pr("f1", { author: "alice", reason: "subscribed", title: "検索の並び順を変える" }), slack("f2", { channel: "web-dev", speaker: "@bob", text: "@YutaUra 検索の PR、リリースはいつですか？" })]) },
  { id: "x-slackpr-3", condition: SLACK_ABOUT_MY_PR, expected: false, note: "自分の PR だが Slack がない", task: task("x3", "クーポンの PR", [pr("f1", { author: "YutaUra", reason: "author", title: "クーポンの二重適用を防ぐ" })]) },
  { id: "x-slackpr-4", condition: SLACK_ABOUT_MY_PR, expected: false, note: "Slack は質問ではなくお礼", task: task("x4", "クーポンの PR", [pr("f1", { author: "YutaUra", reason: "author", title: "クーポンの二重適用を防ぐ" }), slack("f2", { channel: "web-dev", speaker: "@bob", text: "クーポンの修正ありがとうございました！" })]) },

  { id: "x-stale-1", condition: STALE_REVIEW, expected: true, task: task("x10", "在庫の PR のレビュー", [pr("f1", { author: "carol", reason: "review_requested", reviewers: "@YutaUra", title: "在庫の引当をトランザクションにする" }), slack("f2", { channel: "web-dev", speaker: "@carol", text: "@YutaUra 在庫の PR、今日中に見てもらえると助かります" })]) },
  { id: "x-stale-2", condition: STALE_REVIEW, expected: false, note: "催促がない", task: task("x11", "在庫の PR のレビュー", [pr("f1", { author: "carol", reason: "review_requested", reviewers: "@YutaUra", title: "在庫の引当をトランザクションにする" })]) },
  { id: "x-stale-3", condition: STALE_REVIEW, expected: false, note: "Slack だけ", task: task("x12", "レビューの催促", [slack("f1", { channel: "web-dev", speaker: "@carol", text: "@YutaUra 在庫の PR、今日中に見てもらえると助かります" })]) },

  { id: "x-notmine-1", condition: NOT_MINE_ISSUE, expected: true, task: task("x20", "ログの保存期間", [issue("f1", { author: "dave", reason: "subscribed", title: "ログの保存期間を 90 日にする" })]) },
  { id: "x-notmine-2", condition: NOT_MINE_ISSUE, expected: false, note: "アサインされている", task: task("x21", "ログの保存期間", [issue("f1", { author: "dave", reason: "assign", title: "ログの保存期間を 90 日にする" })]) },
  { id: "x-notmine-3", condition: NOT_MINE_ISSUE, expected: false, note: "自分が作成", task: task("x22", "ログの保存期間", [issue("f1", { author: "YutaUra", reason: "author", title: "ログの保存期間を 90 日にする" })]) },
  { id: "x-notmine-4", condition: NOT_MINE_ISSUE, expected: false, note: "Issue がない（事実のない Task）", task: task("x23", "ログの保存期間を調べる", [], { status: "todo" }) },
  { id: "x-notmine-5", condition: NOT_MINE_ISSUE, expected: false, note: "PR であって Issue ではない", task: task("x24", "ログの保存期間", [pr("f1", { author: "dave", reason: "subscribed", title: "ログの保存期間を 90 日にする" })]) },

  { id: "x-repo-1", condition: BILLING_REPO, expected: true, task: task("x30", "請求の PR", [pr("f1", { repo: "acme/billing-api", author: "erin", reason: "review_requested", reviewers: "@YutaUra", title: "請求の締め日を月末にそろえる" })]) },
  { id: "x-repo-2", condition: BILLING_REPO, expected: false, task: task("x31", "請求の画面", [pr("f1", { repo: "acme/shop-web", author: "erin", reason: "review_requested", reviewers: "@YutaUra", title: "billing-api の締め日を画面に出す" })]) },
  { id: "x-repo-3", condition: BILLING_REPO, expected: false, note: "Issue", task: task("x32", "請求の不具合", [{ ...issue("f1", { author: "erin", reason: "mention", title: "締め日がずれる" }), trusted: ["あなた（ユーザー本人）の GitHub アカウント: @YutaUra", "種類: GitHub の Issue", "リポジトリ: acme/billing-api", "通知の理由: mention", "作成者: @erin", "Issue の状態: open"] }]) },

  { id: "x-donemail-1", condition: DONE_MAIL, expected: true, task: task("x40", "問い合わせ", [mail("f1", { from: "support@cloud-host.example", subject: "お問い合わせ #1234 は解決済みになりました", kind: "お知らせ" })]) },
  { id: "x-donemail-2", condition: DONE_MAIL, expected: false, task: task("x41", "問い合わせ", [mail("f1", { from: "support@cloud-host.example", subject: "お問い合わせ #1234 について追加の情報をお願いします", kind: "お知らせ" })]) },
  { id: "x-donemail-3", condition: DONE_MAIL, expected: false, note: "Slack で完了の報告", task: task("x42", "デプロイ", [slack("f1", { channel: "release", speaker: "@frank", text: "本番へのデプロイが完了しました" })]) },

  { id: "x-conflict-1", condition: CONFLICT, expected: true, task: task("x50", "PR の conflict を解消する", [watch("f1", { condition: "conflict がある", title: "注文の検索に期間を足す" })]) },
  { id: "x-conflict-2", condition: CONFLICT, expected: false, task: task("x51", "CI を直す", [watch("f1", { condition: "CI が失敗している", title: "注文の検索に期間を足す" })]) },
  { id: "x-conflict-3", condition: CONFLICT, expected: false, note: "本文で conflict と書く", task: task("x52", "依存の更新", [pr("f1", { author: "renovate[bot]", reason: "subscribed", title: "Update dependency vite", body: "This PR has conflicts. Please resolve them." })]) },
];
