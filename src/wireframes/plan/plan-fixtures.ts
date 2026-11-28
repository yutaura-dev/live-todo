import { choose, rechoose, complete, type PlanGroup, type PlanItem } from "./plan.js";

const serial = (...items: PlanGroup["items"]): PlanGroup => ({ type: "group", arrangement: "serial", items });
const parallel = (...items: PlanGroup["items"]): PlanGroup => ({ type: "group", arrangement: "parallel", items });
const item = (id: string, title: string, how: PlanItem["how"], rest: Partial<PlanItem> = {}): PlanItem => ({ type: "item", id, title, how, status: "todo", ...rest });

/** 一本道。最後が書き込みで、完了したら後片付けをする */
export const straightPlan = serial(
  item("read", "変更点と CHANGELOG を読む", "claude", { status: "done", trigger: "auto", effort: "すぐ済む", run: { state: "終わった" } }),
  item("ci", "PR #482 に CI の結果が付く", "condition", { status: "done", condition: { label: "PR #482 の CI が終わる", observed: "成り立った" } }),
  item("merge", "merge する", "write", { effort: "すぐ済む", completes: true, write: { verb: "merge する", summary: "acme/web#482 を squash で merge する（chore(deps): bump vite from 8.3.7 to 8.3.8）" } }),
  { type: "effect", title: "レビュー依頼のメールをアーカイブする" },
);

/** 先頭が済まないと、後ろがすべて番待ちになる。番が来る前に Claude Code に頼める項目もある */
export const blockedPlan = serial(
  item("receipt", "源泉徴収票が届く", "condition", { condition: { label: "人事からのメールに源泉徴収票が付く", expectedWait: "2〜3 営業日", observed: "まだ" } }),
  item("fill", "申告書に書き写す", "human", { effort: "面倒", due: "12 月 5 日まで", place: { label: "年末調整のサイトを開く", certainty: "確かめた" } }),
  item("check", "書き写した内容を照らし合わせる", "claude", { effort: "すぐ済む" }),
  item("submit", "人事に提出のメールを送る", "write", { effort: "すぐ済む", completes: true, due: "12 月 5 日まで", write: { verb: "送る", summary: "人事の年末調整の窓口へ、申告書を添えて送る" } }),
);

/** 並列のまとまりのあとに、まだ番の来ていない分かれ道 */
export const parallelPlan = serial(
  parallel(
    item("logs", "ログから原因を調べる", "claude", { trigger: "auto", effort: "難しい", run: { state: "やっている" } }),
    item("ask", "影響範囲を #incident で聞く", "human", { effort: "すぐ済む" }),
    item("alert", "監視のアラートが収まる", "condition", { condition: { label: "決済の 500 エラーのアラートが解消する", observed: "成り立った" } }),
  ),
  {
    type: "decision",
    id: "fix",
    title: "直し方を決める",
    kind: "選ぶ",
    howToCheck: null,
    question: "決済の 500 エラーの直し方",
    recommendation: null,
    status: "todo",
    options: [
      { label: "すぐ直す", gains: [{ aspect: "期日", detail: "1 時間ほどで決済が戻る" }], costs: [{ aspect: "確実さ", detail: "原因の見立てが外れていたら、もう一度障害になる" }], unclear: [], then: { type: "planned", plan: serial(item("patch", "修正の PR を作る", "claude", { effort: "ふつう" }), item("deploy", "デプロイする", "human", { effort: "ふつう", completes: true })) } },
      { label: "切り戻す", gains: [{ aspect: "確実さ", detail: "30 分で確実に元の状態に戻る" }], costs: [{ aspect: "取り返し", detail: "昨日入れた請求書の機能も消え、出し直しに半日かかる" }], unclear: ["ほかの人"], then: { type: "planned", plan: serial(item("revert", "前の版に戻す", "human", { effort: "すぐ済む", completes: true })) } },
    ],
    branches: [],
  },
  item("report", "障害報告を書く", "human", { effort: "ふつう", completes: true, addedFrom: "#incident のスレッド「障害報告もお願いします」" }),
);

/** 番が来ている分かれ道。先が決まった選択肢と、選んでから AI が考える選択肢 */
export const decisionPlan = serial(
  item("list", "去年の発表と、今の関心を書き出す", "claude", { status: "done", run: { state: "終わった" } }),
  {
    type: "decision",
    id: "theme",
    title: "発表のテーマを選ぶ",
    kind: "選ぶ",
    howToCheck: null,
    question: "12 月の勉強会で話すテーマ",
    recommendation: { label: "ローカル LLM の評価", reason: "評価の結果が手元にあり準備が 1 時間で済むので、12 月 7 日の締め切りに余裕を持って間に合う" },
    status: "todo",
    options: [
      { label: "Effect 4 への移行", gains: [{ aspect: "出来", detail: "実務で詰まった話なので質問が出やすい" }], costs: [{ aspect: "手間", detail: "社内のコードを伏せる作業に 2 時間ほどかかる" }], unclear: [], then: { type: "planned", plan: serial(item("effect-outline", "移行でつまずいた点を書き出す", "human"), item("effect-slides", "スライドを作る", "human", { completes: true })) } },
      { label: "ローカル LLM の評価", gains: [{ aspect: "手間", detail: "評価の結果がもう手元にあり、1 時間で作れる" }], costs: [{ aspect: "出来", detail: "数字の説明が多く、聞く人を選ぶ" }], unclear: [], then: { type: "planned", plan: serial(item("llm-bench", "評価の結果をまとめる", "claude"), item("llm-slides", "スライドを作る", "human", { completes: true })) } },
      { label: "AI に決めてもらう", gains: [{ aspect: "手間", detail: "テーマを考える時間が要らない" }], costs: [{ aspect: "出来", detail: "去年と同じ傾向に寄りやすい" }], unclear: [], then: { type: "planLater", direction: "去年の傾向から選ぶ" } },
    ],
    branches: [],
  },
  item("post", "Notion の募集ページに概要を出す", "write", { completes: true, due: "12 月 7 日まで", write: { verb: "出す", summary: "勉強会の募集ページに、テーマと概要（300 字）を書き込む" } }),
);

/** 分かれ道で選んで、枝の 1 つ目が済んだところ */
export const chosenPlan = complete(choose(decisionPlan, "theme", "Effect 4 への移行"), "effect-outline");

/** 選び直した（前の枝は取りやめた枝として残り、済んだ項目は済んだのまま） */
export const rechosenPlan = rechoose(chosenPlan, "theme");

/** 選んでから AI が計画を考える選択肢を選んだ */
export const planLaterPlan = choose(decisionPlan, "theme", "AI に決めてもらう");

/** うまくいかなかった・待つ対象がなくなった */
export const troublePlan = serial(
  item("rebase", "conflict を直す", "claude", { status: "todo", effort: "ふつう", run: { state: "止まった", reason: "うまくいかなかった" } }),
  item("wait-review", "レビューが付く", "condition", { condition: { label: "PR #477 にレビューが付く", observed: "達成できない" } }),
  item("push", "直した commit を push する", "write", { completes: true, write: { verb: "push する", summary: "feature/billing に、conflict を直した 1 commit を push する" } }),
);

/** 並列の中に、直列の枝と分かれ道の枝がある。枝ごとに進み具合が違う */
export const nestedParallelPlan = serial(
  parallel(
    serial(
      item("collect", "領収書を集める", "human", { status: "done" }),
      item("scan", "スキャンして取り込む", "human"),
      item("sum", "合計を出す", "claude"),
    ),
    serial(item("ask-rule", "経費の規程を確かめる", "claude", { status: "done", run: { state: "終わった" } }), {
      type: "decision",
      id: "route",
      title: "出し方を選ぶ",
      kind: "選ぶ",
      howToCheck: null,
      question: "11 月分の経費（3 万円）の出し方",
      recommendation: { label: "立替で出す", reason: "付け替えだと締め日を過ぎて翌月回しになるかもしれない。立て替えた 3 万円は翌月 25 日に戻る" },
      status: "todo",
      options: [
        { label: "立替で出す", gains: [{ aspect: "期日", detail: "今日中に出せて、締め日に間に合う" }], costs: [{ aspect: "お金", detail: "3 万円を一度自分で払う（翌月 25 日に戻る）" }], unclear: [], then: { type: "planned", plan: serial(item("form", "立替精算の申請を書く", "human", { completes: true })) } },
        { label: "法人カードに付け替える", gains: [{ aspect: "お金", detail: "自分のお金を使わない" }], costs: [{ aspect: "期日", detail: "経理の返事待ちで 3 日ほどかかり、締め日を過ぎるかもしれない" }], unclear: [], then: { type: "planned", plan: serial(item("card", "経理に付け替えを頼む", "write", { completes: true })) } },
      ],
      branches: [],
    }),
  ),
  item("submit-all", "経理に提出する", "write", { completes: true }),
);

/** 確かめる分かれ道。事実を確かめれば答えが決まるので、確かめ方と選択肢だけを出す */
export const checkPlan = serial(
  {
    type: "decision",
    id: "login",
    title: "心当たりのないログインがないか確かめる",
    kind: "確かめる",
    howToCheck: "Google アカウントの「デバイス」で、11/22 の Mac のログイン 3 件の場所と端末を見る",
    question: "11/22 の Mac のログイン 3 件は、すべて自分の操作か",
    recommendation: null,
    status: "todo",
    options: [
      { label: "すべて自分の操作だった", gains: [], costs: [], unclear: [], then: { type: "planned", plan: serial(item("close", "通知を閉じる", "human", { completes: true })) } },
      { label: "心当たりのないログインがある", gains: [], costs: [], unclear: [], then: { type: "planned", plan: serial(item("password", "パスワードを変える", "human"), item("sessions", "ほかのセッションをすべて切る", "human", { completes: true })) } },
    ],
    branches: [],
  },
);
