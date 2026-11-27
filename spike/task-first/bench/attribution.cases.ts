import type { Fact, TaskDossier } from "../model.js";
import { issue, mail, pr, slack, task } from "./rule-condition.cases.js";

// 作った例。実在の案件・人・リポジトリを書かない。開いている Task に、新しい事実が届く

const withUrl = (fact: Fact, url: string): Fact => ({ ...fact, url });
const event = (id: string, title: string): Fact => ({ id, source: "calendar", trusted: ["種類: カレンダーの予定", "主催者: @carol", "あなたの出欠: 未回答"], body: `件名: ${title}`, at: "2026-11-20T10:00:00Z", state: "open" });

export const world: ReadonlyArray<TaskDossier> = [
  task("coupon", "クーポンの二重適用を防ぐ PR を出す", [withUrl(pr("w1", { author: "YutaUra", reason: "author", title: "クーポンの二重適用を防ぐ" }), "https://github.com/acme/shop-web/pull/101")], { status: "in_progress" }),
  task("stock", "在庫の引当の PR をレビューする", [withUrl(pr("w2", { author: "carol", reason: "review_requested", reviewers: "@YutaUra", title: "在庫の引当をトランザクションにする" }), "https://github.com/acme/shop-web/pull/205")], { status: "todo" }),
  task("search", "検索の並び順の PR をレビューする", [withUrl(pr("w3", { repo: "acme/search", author: "alice", reason: "review_requested", reviewers: "@YutaUra", title: "検索の並び順に人気度を足す" }), "https://github.com/acme/search/pull/33")], { status: "todo" }),
  task("invoice", "11 月分のクラウドの請求書を経理に回す", [mail("w4", { from: "billing@cloud-host.example", subject: "【請求書】2026年11月分のご利用料金（INV-2026-11）", kind: "お知らせ" })], { status: "todo" }),
  task("nenmatsu", "年末調整の書類を出す", [mail("w5", { from: "hr@company.example", subject: "年末調整の書類提出のお願い", kind: "お知らせ", body: "12 月 5 日（金）までに提出してください。" })], { status: "todo" }),
  task("staging", "検証環境のデータを入れ替える", [slack("w6", { channel: "web-dev", speaker: "@bob", text: "@YutaUra 検証環境のデータを本番の先週の状態に入れ替えてもらえますか？" })], { status: "todo" }),
  task("postmortem", "決済の 5xx の障害の振り返りを書く", [slack("w7", { channel: "incident", speaker: "@carol", text: "@YutaUra 昨日の決済の 5xx の件、振り返りを書いてもらえますか" })], { status: "todo" }),
  task("dentist", "歯医者の予約をする", [], { status: "todo" }),
];

export type AttributionCase = { id: string; fact: Fact; expected: string | null; role?: "tracks" | "context"; note?: string };

export const attributionCases: ReadonlyArray<AttributionCase> = [
  { id: "url-1", expected: "stock", role: "context", note: "PR の URL", fact: slack("a1", { channel: "web-dev", speaker: "@carol", text: "@YutaUra https://github.com/acme/shop-web/pull/205 見てもらえますか" }) },
  { id: "url-2", expected: "search", role: "context", note: "PR の URL", fact: slack("a2", { channel: "search-dev", speaker: "@alice", text: "https://github.com/acme/search/pull/33 マージしました、ありがとうございます" }) },
  { id: "sem-1", expected: "stock", role: "context", note: "URL なしの催促", fact: slack("a3", { channel: "web-dev", speaker: "@carol", text: "@YutaUra 在庫の PR、今日中に見てもらえると助かります" }) },
  { id: "sem-2", expected: "coupon", role: "context", note: "自分の PR への質問", fact: slack("a4", { channel: "web-dev", speaker: "@bob", text: "@YutaUra クーポンの件、既存の注文にも効きますか？" }) },
  { id: "sem-3", expected: "invoice", role: "context", note: "請求書の再送", fact: mail("a5", { from: "billing@cloud-host.example", subject: "【再送】2026年11月分の請求書（INV-2026-11）", kind: "お知らせ" }) },
  { id: "sem-4", expected: "invoice", role: "context", note: "経理からの受領", fact: mail("a6", { from: "経理 <accounting@company.example>", subject: "Re: クラウドの請求書", kind: "人からのメール", body: "クラウドの 11 月分の請求書、受け取りました。ありがとうございます。" }) },
  { id: "sem-5", expected: "staging", role: "context", note: "同じ依頼の続き", fact: slack("a8", { channel: "web-dev", speaker: "@bob", text: "@YutaUra 検証環境のデータ、入れ替え終わったら教えてください" }) },
  { id: "sem-6", expected: "postmortem", role: "context", note: "予定", fact: event("a10", "決済障害の振り返り会") },
  { id: "sem-7", expected: "nenmatsu", role: "context", note: "リマインド", fact: mail("a11", { from: "hr@company.example", subject: "【リマインド】年末調整の書類は 12/5 締切です", kind: "お知らせ" }) },
  { id: "sem-8", expected: "stock", role: "context", note: "PR の番号だけ", fact: slack("a15", { channel: "web-dev", speaker: "@carol", text: "#205 の件、指摘のところ修正入れました" }) },
  { id: "sem-9", expected: "dentist", role: "context", note: "事実のない Task", fact: mail("a16", { from: "予約センター <reserve@dental.example>", subject: "ご予約の確認（12 月 3 日 10:00）", kind: "お知らせ" }) },
  { id: "sem-10", expected: "search", role: "context", note: "再レビューの依頼", fact: slack("a17", { channel: "search-dev", speaker: "@alice", text: "@YutaUra 検索の PR、並び順のロジック変えたので再レビューお願いします" }) },
  { id: "sem-11", expected: "postmortem", role: "context", note: "進み具合の確認", fact: slack("a19", { channel: "incident", speaker: "@carol", text: "@YutaUra 振り返りのドキュメント、どこまで書けました？" }) },
  { id: "sem-12", expected: "coupon", role: "context", note: "QA の結果", fact: slack("a22", { channel: "qa", speaker: "@erin", text: "クーポンの二重適用の件、QA で再現しなくなりました" }) },

  { id: "neg-1", expected: null, note: "同じ人・同じリポジトリの別の PR", fact: withUrl(pr("a7", { repo: "acme/search", author: "alice", reason: "review_requested", reviewers: "@YutaUra", title: "検索のハイライトを太字にする" }), "https://github.com/acme/search/pull/34") },
  { id: "neg-2", expected: null, note: "同じ人からの別の依頼", fact: slack("a9", { channel: "web-dev", speaker: "@bob", text: "@YutaUra 本番の DB のバックアップの取り方を教えてもらえますか" }) },
  { id: "neg-3", expected: null, note: "似た言葉の別の Issue", fact: issue("a13", { author: "dave", reason: "mention", title: "在庫の数が画面とずれることがある" }) },
  { id: "neg-4", expected: null, note: "自分の別のクーポンの PR", fact: withUrl(pr("a14", { author: "YutaUra", reason: "author", title: "クーポンの有効期限を表示する" }), "https://github.com/acme/shop-web/pull/110") },
  { id: "neg-5", expected: null, note: "雑談", fact: slack("a12", { channel: "random", speaker: "@dave", text: "今日のランチどこ行きます？" }) },
  { id: "neg-6", expected: null, note: "別の請求", fact: mail("a20", { from: "card@bank.example", subject: "カードご利用のお知らせ", kind: "お知らせ" }) },
  { id: "neg-7", expected: null, note: "別の障害", fact: slack("a21", { channel: "incident", speaker: "@frank", text: "検索 API のレイテンシが上がっています。調査します" }) },
  { id: "neg-8", expected: null, note: "別の予定", fact: event("a23", "検索チームの定例") },
];
