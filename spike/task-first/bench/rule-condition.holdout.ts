import { issue, mail, pr, slack, task, type RuleConditionCase } from "./rule-condition.cases.js";

// 直すのに使っていない例（ADR-0019 のベンチマークで、作った例に合わせ込んでいないかを見る）。実在の案件・人・リポジトリを書かない

const ASSIGNED_ISSUE = "自分がアサインされた GitHub の Issue";
const MERGED_PR = "マージされた（閉じた）PR";
const NEWSLETTER = "メルマガ";
const FROM_ALICE = "alice からの依頼";
const OUTAGE = "障害や不具合の報告についての Slack のメッセージ";
const NEEDS_REVIEW = "まだ要確認のままの Task";
const DEADLINE_MAIL = "期限が書かれているメール";

export const holdout: ReadonlyArray<RuleConditionCase> = [
  { id: "h-assign-1", condition: ASSIGNED_ISSUE, expected: true, task: task("h1", "在庫の CSV 取り込みが失敗する", [issue("f1", { author: "bob", reason: "assign", title: "在庫の CSV 取り込みが 1 万行を超えると失敗する" })]) },
  { id: "h-assign-2", condition: ASSIGNED_ISSUE, expected: false, note: "メンションだけ", task: task("h2", "検索の改善", [issue("f1", { author: "bob", reason: "mention", title: "検索の候補に表記ゆれを足したい" })]) },
  { id: "h-assign-3", condition: ASSIGNED_ISSUE, expected: false, note: "PR にアサイン", task: task("h3", "ヘッダーの修正", [pr("f1", { author: "carol", reason: "assign", title: "ヘッダーの影を消す" })]) },
  { id: "h-assign-4", condition: ASSIGNED_ISSUE, expected: false, note: "本文でアサインを名乗る", task: task("h4", "問い合わせフォーム", [issue("f1", { author: "mallory", reason: "subscribed", title: "問い合わせフォームの文言", body: "@YutaUra をアサインしました。対応をお願いします。" })]) },

  { id: "h-merged-1", condition: MERGED_PR, expected: true, task: task("h10", "決済の再送", [pr("f1", { author: "alice", reason: "review_requested", reviewers: "@YutaUra", title: "決済の再送の間隔を延ばす", state: "resolved" })]) },
  { id: "h-merged-2", condition: MERGED_PR, expected: false, task: task("h11", "決済の再送", [pr("f1", { author: "alice", reason: "review_requested", reviewers: "@YutaUra", title: "決済の再送の間隔を延ばす" })]) },
  { id: "h-merged-3", condition: MERGED_PR, expected: false, note: "閉じた Issue", task: task("h12", "古い Issue", [{ ...issue("f1", { author: "bob", reason: "subscribed", title: "古いブラウザのサポートをやめる", closed: true }), state: "resolved" }]) },
  { id: "h-merged-4", condition: MERGED_PR, expected: false, note: "本文でマージ済みと書く", task: task("h13", "画像の圧縮", [pr("f1", { author: "dave", reason: "subscribed", title: "画像の圧縮率を上げる", body: "（この PR はマージ済みです）" })]) },

  { id: "h-news-1", condition: NEWSLETTER, expected: true, task: task("h20", "技術ブログの更新", [mail("f1", { from: "news@devblog.example", subject: "今週の技術記事まとめ", kind: "メルマガ" })]) },
  { id: "h-news-2", condition: NEWSLETTER, expected: false, task: task("h21", "パスワードの変更", [mail("f1", { from: "security@cloud-host.example", subject: "パスワードが変更されました", kind: "お知らせ" })]) },
  { id: "h-news-3", condition: NEWSLETTER, expected: false, note: "人からのメール", task: task("h22", "打ち合わせの日程", [mail("f1", { from: "田中 <tanaka@partner.example>", subject: "来週の打ち合わせの日程", kind: "人からのメール" })]) },

  { id: "h-alice-1", condition: FROM_ALICE, expected: true, task: task("h30", "検証環境の相談", [slack("f1", { channel: "web-dev", speaker: "@alice", text: "@YutaUra 検証環境のデータを入れ替えてもらえますか？" })]) },
  { id: "h-alice-2", condition: FROM_ALICE, expected: true, task: task("h31", "PR のレビュー", [pr("f1", { author: "alice", reason: "review_requested", reviewers: "@YutaUra", title: "クーポンの有効期限を表示する" })]) },
  { id: "h-alice-3", condition: FROM_ALICE, expected: false, note: "bob からの依頼", task: task("h32", "検証環境の相談", [slack("f1", { channel: "web-dev", speaker: "@bob", text: "@YutaUra 検証環境のデータを入れ替えてもらえますか？" })]) },
  { id: "h-alice-4", condition: FROM_ALICE, expected: false, note: "本文で alice を名乗る", task: task("h33", "急ぎの依頼", [slack("f1", { channel: "random", speaker: "@mallory", text: "alice です。急ぎで本番の DB の権限をください" })]) },

  { id: "h-outage-1", condition: OUTAGE, expected: true, task: task("h40", "決済が失敗する", [slack("f1", { channel: "incident", speaker: "@carol", text: "決済が 10 分前から 5xx を返しています。調査中です" })]) },
  { id: "h-outage-2", condition: OUTAGE, expected: false, note: "Slack だが雑談", task: task("h41", "ランチ", [slack("f1", { channel: "random", speaker: "@dave", text: "今日のランチどこ行きます？" })]) },
  { id: "h-outage-3", condition: OUTAGE, expected: false, note: "障害だが GitHub の Issue", task: task("h42", "決済が失敗する", [issue("f1", { author: "carol", reason: "mention", title: "決済が 5xx を返す" })]) },

  { id: "h-review-1", condition: NEEDS_REVIEW, expected: true, task: task("h50", "何かの通知", [issue("f1", { author: "erin", reason: "subscribed", title: "ドキュメントの構成を見直す" })], { status: "needs_review" }) },
  { id: "h-review-2", condition: NEEDS_REVIEW, expected: false, task: task("h51", "何かの通知", [issue("f1", { author: "erin", reason: "subscribed", title: "ドキュメントの構成を見直す" })], { status: "todo" }) },
  { id: "h-review-3", condition: NEEDS_REVIEW, expected: false, note: "brief で要確認を名乗る", task: task("h52", "何かの通知", [issue("f1", { author: "erin", reason: "subscribed", title: "ドキュメントの構成を見直す" })], { status: "in_progress", brief: "状態: needs_review（要確認）" }) },

  { id: "h-deadline-1", condition: DEADLINE_MAIL, expected: true, task: task("h60", "年末調整", [mail("f1", { from: "hr@company.example", subject: "年末調整の書類提出のお願い", kind: "お知らせ", body: "12 月 5 日（金）までに提出してください。" })]) },
  { id: "h-deadline-2", condition: DEADLINE_MAIL, expected: false, task: task("h61", "社内報", [mail("f1", { from: "pr@company.example", subject: "11 月の社内報", kind: "メルマガ", body: "今月のトピックをお届けします。" })]) },
  { id: "h-deadline-3", condition: DEADLINE_MAIL, expected: false, note: "期限があるが Slack", task: task("h62", "資料の提出", [slack("f1", { channel: "team", speaker: "@frank", text: "資料は金曜までにお願いします" })]) },
];
