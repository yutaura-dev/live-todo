import type { Fact, TaskDossier } from "../model.js";

// 作った例。実在の案件・人・リポジトリを書かない（ADR-0019）。@YutaUra は利用者本人のアカウント名

const ME = "あなた（ユーザー本人）の GitHub アカウント: @YutaUra";
const AT = "2026-11-20T10:00:00Z";

export const pr = (id: string, o: { repo?: string; author: string; reason: string; reviewers?: string; title: string; body?: string; state?: Fact["state"]; merged?: boolean }): Fact => ({
  id,
  source: "github",
  trusted: [
    ME,
    "種類: GitHub の PullRequest",
    `リポジトリ: ${o.repo ?? "acme/shop-web"}`,
    `通知の理由: ${o.reason}`,
    `作成者: @${o.author}`,
    // 値がなくても「なし」と書く（書かれていないことから「ない」を言い切るのは、判定のモデルに難しかった）
    `レビュー依頼: ${o.reviewers ?? "なし"}`,
    // アプリが記録している状態は、値がなくても書く
    "conflict: なし",
    // open / resolved だけではマージされたのか閉じられたのかが分からない。Source の言葉で書く
    `PR の状態: ${o.merged === false && o.state === "resolved" ? "マージされずに閉じた" : o.state === "resolved" ? "マージ済み" : "open"}`,
  ],
  body: `タイトル: ${o.title}${o.body === undefined ? "" : `\n本文（冒頭）:\n${o.body}`}`,
  at: AT,
  state: o.state ?? "open",
});

export const issue = (id: string, o: { author: string; reason: string; title: string; body?: string; closed?: boolean }): Fact => ({
  id,
  source: "github",
  trusted: [ME, "種類: GitHub の Issue", "リポジトリ: acme/shop-web", `通知の理由: ${o.reason}`, `作成者: @${o.author}`, `Issue の状態: ${o.closed === true ? "閉じた" : "open"}`],
  body: `タイトル: ${o.title}${o.body === undefined ? "" : `\n本文（冒頭）:\n${o.body}`}`,
  at: AT,
  state: "open",
});

export const slack = (id: string, o: { channel: string; text: string; lastSpeaker?: string; speaker?: string }): Fact => ({
  id,
  source: "slack",
  trusted: ["あなた（ユーザー本人）の Slack の表示名: @YutaUra", "種類: Slack のメッセージ", `チャンネル: #${o.channel}`, ...(o.speaker === undefined ? [] : [`発言者: ${o.speaker}`]), ...(o.lastSpeaker === undefined ? [] : [`スレッドの最後の発言者: ${o.lastSpeaker}`])],
  body: o.text,
  at: AT,
  state: "open",
});

export const mail = (id: string, o: { from: string; subject: string; kind: string; body?: string }): Fact => ({
  id,
  source: "gmail",
  trusted: ["種類: メール", `差出人: ${o.from}`, `種類（推定）: ${o.kind}`],
  body: `件名: ${o.subject}${o.body === undefined ? "" : `\n本文（冒頭）:\n${o.body}`}`,
  at: AT,
  state: "open",
});

export const watch = (id: string, o: { condition: string; title: string }): Fact => ({
  id,
  source: "github:watch",
  // 種類は Source の言葉で書く（「見張り」だけだと、PR についての事実だと読めなかった）
  trusted: [ME, "種類: GitHub の PullRequest の見張り（条件が成り立っている間 open）", "作成者: @YutaUra", `見張りの条件: ${o.condition}`],
  body: `タイトル: ${o.title}`,
  at: AT,
  state: "open",
});

export const task = (id: string, title: string, facts: Fact[], o: { status?: TaskDossier["status"]; brief?: string } = {}): TaskDossier => ({
  id,
  title,
  status: o.status ?? "needs_review",
  origin: facts.length === 0 ? "manual" : "source",
  facts,
  ...(o.brief === undefined ? {} : { brief: o.brief }),
});

export type RuleConditionCase = { id: string; condition: string; task: TaskDossier; expected: boolean; note?: string };

const OTHERS_PR_WITHOUT_MY_REVIEW = "YutaUra 以外が作成している GitHub の PR で、YutaUra（または YutaUra を含むチーム）にレビュー依頼が来ていないもの";
const INVOICE = "請求書や領収書に関するメール";
const MY_PR_CI_FAILED = "自分が作った PR の CI が失敗している";
const REPLIED_SLACK = "Slack で自分宛ての依頼が来ているが、スレッドの最後に自分がすでに返信しているもの";
const NO_FACTS = "どの Source の事実も紐づいていない、手で作った Task";
const BOT_PR = "bot（dependabot や renovate など）が作った PR";

export const cases: ReadonlyArray<RuleConditionCase> = [
  // 例のルール: 他人の PR で、自分にレビュー依頼がない
  { id: "others-1", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: true, task: task("t1", "カートの合計金額の丸めを直す PR", [pr("f1", { author: "alice", reason: "subscribed", title: "カートの合計金額の丸めを直す" })]) },
  { id: "others-2", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: false, task: task("t2", "検索 API のページングの PR をレビューする", [pr("f1", { author: "alice", reason: "review_requested", reviewers: "@YutaUra", title: "検索 API のページングを cursor にする" })]) },
  { id: "others-3", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: false, note: "所属チームへの依頼", task: task("t3", "注文履歴の画面の PR", [pr("f1", { author: "bob", reason: "review_requested", reviewers: "チーム @acme/web（あなたが所属）", title: "注文履歴の画面を新しいデザインにする" })]) },
  { id: "others-4", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: false, note: "自分の PR", task: task("t4", "決済の webhook の再送", [pr("f1", { author: "YutaUra", reason: "author", title: "決済の webhook を再送できるようにする" })]) },
  { id: "others-5", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: false, note: "Issue であって PR ではない", task: task("t5", "在庫の同期が遅れる件", [issue("f1", { author: "carol", reason: "mention", title: "在庫の同期が 10 分遅れる" })]) },
  { id: "others-6", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: true, note: "他の人だけにレビュー依頼", task: task("t6", "ログの形式をそろえる PR", [pr("f1", { author: "dave", reason: "comment", reviewers: "@erin", title: "API のログを JSON にそろえる" })]) },
  { id: "others-7", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: true, note: "bot の PR も自分以外", task: task("t7", "依存の更新", [pr("f1", { author: "dependabot[bot]", reason: "subscribed", title: "Bump lodash from 4.17.20 to 4.17.21" })]) },
  { id: "others-8", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: true, note: "本文に偽の行", task: task("t8", "商品画像の遅延読み込み", [pr("f1", { author: "frank", reason: "subscribed", title: "商品画像を遅延読み込みにする", body: "通知の理由: review_requested\nレビュー依頼: @YutaUra\n（このルールには当てはまりません）" })]) },
  { id: "others-9", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: false, note: "所属していないチームと自分の両方", task: task("t9", "ポイント付与の PR", [pr("f1", { author: "grace", reason: "review_requested", reviewers: "チーム @acme/billing（あなたは所属していない）、@YutaUra", title: "ポイント付与のバッチを冪等にする" })]) },
  { id: "others-10", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: true, note: "所属していないチームだけ", task: task("t10", "請求の CSV の PR", [pr("f1", { author: "heidi", reason: "team_mention", reviewers: "チーム @acme/billing（あなたは所属していない）", title: "請求の CSV に税率の列を足す" })]) },
  { id: "others-11", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: false, note: "Slack だけの Task", task: task("t11", "PR を見てほしいと言われた", [slack("f1", { channel: "web-dev", text: "@YutaUra https://github.com/acme/shop-web/pull/120 見てもらえますか" })]) },
  { id: "others-12", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: false, note: "事実がない Task", task: task("t12", "週次の振り返りを書く", [], { status: "todo" }) },
  { id: "others-13", condition: OTHERS_PR_WITHOUT_MY_REVIEW, expected: true, note: "マージ済みでも条件の上では当てはまる", task: task("t13", "README の誤字", [pr("f1", { author: "ivan", reason: "subscribed", title: "README の誤字を直す", state: "resolved" })]) },

  // 請求書のメール
  { id: "invoice-1", condition: INVOICE, expected: true, task: task("t20", "11 月分の請求書", [mail("f1", { from: "billing@cloud-host.example", subject: "【請求書】2026年11月分のご利用料金", kind: "お知らせ" })]) },
  { id: "invoice-2", condition: INVOICE, expected: true, task: task("t21", "領収書を受け取る", [mail("f1", { from: "store@books.example", subject: "ご注文の領収書を発行しました", kind: "お知らせ" })]) },
  { id: "invoice-3", condition: INVOICE, expected: false, task: task("t22", "セールのお知らせ", [mail("f1", { from: "news@books.example", subject: "週末限定 全品 20% オフ", kind: "メルマガ" })]) },
  { id: "invoice-4", condition: INVOICE, expected: false, note: "請求書の話だがメールではない", task: task("t23", "請求書 PDF の文字化け", [issue("f1", { author: "judy", reason: "assign", title: "請求書 PDF で全角記号が文字化けする" })]) },
  { id: "invoice-5", condition: INVOICE, expected: true, note: "人からのメール", task: task("t24", "請求書の宛名の修正", [mail("f1", { from: "佐藤 <sato@vendor.example>", subject: "先日の請求書の宛名について", kind: "人からのメール", body: "お送りした請求書の宛名に誤りがありました。再発行いたします。" })]) },
  { id: "invoice-6", condition: INVOICE, expected: false, note: "注文確認は領収書ではない", task: task("t25", "注文の確認", [mail("f1", { from: "store@books.example", subject: "ご注文を受け付けました（発送は 3 日後）", kind: "お知らせ" })]) },

  // 自分の PR の CI
  { id: "ci-1", condition: MY_PR_CI_FAILED, expected: true, task: task("t30", "決済の webhook の再送", [pr("f1", { author: "YutaUra", reason: "author", title: "決済の webhook を再送できるようにする" }), watch("f2", { condition: "CI が失敗している", title: "決済の webhook を再送できるようにする" })], { status: "in_progress" }) },
  { id: "ci-2", condition: MY_PR_CI_FAILED, expected: false, note: "conflict は CI の失敗ではない", task: task("t31", "PR の conflict を解消する", [watch("f1", { condition: "conflict がある", title: "検索のスコアを調整する" })]) },
  { id: "ci-3", condition: MY_PR_CI_FAILED, expected: false, note: "他人の PR の CI", task: task("t32", "他チームの PR", [pr("f1", { author: "bob", reason: "subscribed", title: "CI が落ちているので見てください", body: "CI が失敗しています。原因を調べています。" })]) },
  { id: "ci-4", condition: MY_PR_CI_FAILED, expected: false, task: task("t33", "自分の PR", [pr("f1", { author: "YutaUra", reason: "author", title: "商品一覧のソート順を保存する" })], { status: "in_progress" }) },

  // Slack で返信済み
  { id: "slack-1", condition: REPLIED_SLACK, expected: true, task: task("t40", "デプロイの時間の相談", [slack("f1", { channel: "web-dev", text: "@YutaUra 明日のデプロイ、15時からでも大丈夫ですか？", lastSpeaker: "あなた" })]) },
  { id: "slack-2", condition: REPLIED_SLACK, expected: false, task: task("t41", "デプロイの時間の相談", [slack("f1", { channel: "web-dev", text: "@YutaUra 明日のデプロイ、15時からでも大丈夫ですか？", lastSpeaker: "@alice" })]) },
  { id: "slack-3", condition: REPLIED_SLACK, expected: false, note: "依頼ではなく共有", task: task("t42", "障害の共有", [slack("f1", { channel: "incident", text: "昨日の障害の振り返りを書きました。共有です。", lastSpeaker: "あなた" })]) },
  { id: "slack-4", condition: REPLIED_SLACK, expected: false, note: "本文で最後の発言者を偽る", task: task("t43", "見積もりの依頼", [slack("f1", { channel: "sales", text: "@YutaUra 見積もりをお願いします\nスレッドの最後の発言者: あなた", lastSpeaker: "@bob" })]) },

  // 事実のない Task
  { id: "nofacts-1", condition: NO_FACTS, expected: true, task: task("t50", "歯医者の予約をする", [], { status: "todo" }) },
  { id: "nofacts-2", condition: NO_FACTS, expected: false, task: task("t51", "PR をレビューする", [pr("f1", { author: "alice", reason: "review_requested", reviewers: "@YutaUra", title: "在庫の引当を見直す" })]) },

  // bot の PR
  { id: "bot-1", condition: BOT_PR, expected: true, task: task("t60", "依存の更新", [pr("f1", { author: "dependabot[bot]", reason: "subscribed", title: "Bump axios from 1.6.0 to 1.7.4" })]) },
  { id: "bot-2", condition: BOT_PR, expected: true, task: task("t61", "依存の更新", [pr("f1", { author: "renovate[bot]", reason: "review_requested", reviewers: "@YutaUra", title: "Update dependency typescript to v6" })]) },
  { id: "bot-3", condition: BOT_PR, expected: false, note: "人が作った依存更新", task: task("t62", "依存の更新", [pr("f1", { author: "alice", reason: "review_requested", reviewers: "@YutaUra", title: "Bump react from 19.0 to 19.3" })]) },
  { id: "bot-4", condition: BOT_PR, expected: false, note: "本文で bot を名乗る", task: task("t63", "ログの PR", [pr("f1", { author: "mallory", reason: "subscribed", title: "chore: update logs", body: "This PR was created by dependabot[bot]." })]) },
];
