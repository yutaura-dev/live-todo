import { NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { SpikeModels } from "../llm.js";
import type { Fact, TaskDossier } from "../model.js";
import { decompose, decomposedProbability, type Decomposition } from "../rule-decompose.js";

// 実データ（spike/task-first/data/real-prs.json。gitignore）で、ルールの条件の判定を測る。正解は GitHub の API の値から決める

type RealPr = {
  url: string; repo: string; org: string; reason: string | null; author: string; reviewers: string[]; teams: string[];
  state: string; merged: boolean; draft: boolean; title: string; body: string; myTeamRequested: boolean; otherTeams: string[];
};

const ME = "YutaUra";
const THRESHOLD = 0.8;

/** 取り込みで書く形の事実（ADR-0019 の spike で効いた書き方: 値がなくても書く・Source の言葉で書く） */
const factOf = (p: RealPr): Fact => {
  // 自分に関わる結論はアプリが決めて 1 行で書く。50 を超える依頼先の一覧から「（あなたが所属）」を探させると見落とした（実データで 3 件誤って当てた）
  const myTeams = p.teams.filter((slug) => !p.otherTeams.includes(slug));
  const toMe = [...(p.reviewers.includes(ME) ? ["あなた個人"] : []), ...myTeams.map((slug) => `チーム @${p.org}/${slug}`)];
  const others = p.reviewers.filter((login) => login !== ME).length + p.otherTeams.length;
  return {
    id: p.url,
    source: "github",
    url: p.url,
    trusted: [
      `あなた（ユーザー本人）の GitHub アカウント: @${ME}`,
      "種類: GitHub の PullRequest",
      `リポジトリ: ${p.repo}`,
      ...(p.reason === null ? [] : [`通知の理由: ${p.reason}`]),
      `作成者: @${p.author}`,
      `あなた（または所属チーム）へのレビュー依頼: ${toMe.length === 0 ? "なし" : `あり（${toMe.join("、")}）`}`,
      `ほかの人・チームへのレビュー依頼: ${others === 0 ? "なし" : `${others} 件`}`,
      `PR の状態: ${p.merged ? "マージ済み" : p.state === "closed" ? "マージされずに閉じた" : p.draft ? "open（draft）" : "open"}`,
    ],
    body: `タイトル: ${p.title}${p.body.trim() === "" ? "" : `\n本文（冒頭）:\n${p.body}`}`,
    at: "2026-11-27T00:00:00Z",
    state: p.state === "open" ? "open" : "resolved",
  };
};

const RULES: ReadonlyArray<{ condition: string; truth: (p: RealPr) => boolean }> = [
  { condition: "YutaUra 以外が作成している GitHub の PR で、YutaUra（または YutaUra を含むチーム）にレビュー依頼が来ていないもの", truth: (p) => p.author !== ME && !p.reviewers.includes(ME) && !p.myTeamRequested },
  { condition: "bot（dependabot や renovate など）が作った PR", truth: (p) => p.author.endsWith("[bot]") },
  { condition: "マージされた PR", truth: (p) => p.merged },
  { condition: "自分が作った PR", truth: (p) => p.author === ME },
  { condition: "自分か自分の所属するチームにレビュー依頼が来ている PR", truth: (p) => p.reviewers.includes(ME) || p.myTeamRequested },
];

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const prs: RealPr[] = JSON.parse(yield* fs.readFileString("spike/task-first/data/real-prs.json"));
  const totals = { tp: 0, fp: 0, fn: 0, tn: 0, unanswered: 0 };
  for (const rule of RULES) {
    const d: Decomposition = yield* decompose(rule.condition);
    console.log(`\n# ${rule.condition}\n  ${d.combine}: ${d.clauses.map((c) => `${c.question} → ${c.expect ? "はい" : "いいえ"}（${c.about}）`).join(" / ")}`);
    const rows = yield* Effect.forEach(
      prs,
      (p) => {
        const task: TaskDossier = { id: p.url, title: p.title, status: "needs_review", origin: "source", facts: [factOf(p)] };
        return decomposedProbability(d, task).pipe(Effect.map((prob) => ({ p, prob, truth: rule.truth(p) })));
      },
      { concurrency: 8 },
    );
    const m = { tp: 0, fp: 0, fn: 0, tn: 0, unanswered: 0 };
    for (const r of rows) {
      const applied = r.prob !== undefined && r.prob >= THRESHOLD;
      if (r.prob === undefined) m.unanswered++;
      if (applied && r.truth) m.tp++;
      else if (applied) m.fp++;
      else if (r.truth) m.fn++;
      else m.tn++;
      if (applied !== r.truth) console.log(`  ${applied ? "✗ 誤って当てた" : "✗ 当て損ねた"} p=${r.prob?.toFixed(2)} ${r.p.url} 作成者=${r.p.author} 依頼=${[...r.p.reviewers, ...r.p.teams].join(",") || "なし"} merged=${r.p.merged}`);
    }
    for (const k of Object.keys(m) as (keyof typeof m)[]) totals[k] += m[k];
    console.log(`  ${JSON.stringify({ ...m, precision: +(m.tp / Math.max(1, m.tp + m.fp)).toFixed(3), recall: +(m.tp / Math.max(1, m.tp + m.fn)).toFixed(3) })}`);
  }
  console.log(`\n合計 ${JSON.stringify({ ...totals, precision: +(totals.tp / Math.max(1, totals.tp + totals.fp)).toFixed(3), recall: +(totals.tp / Math.max(1, totals.tp + totals.fn)).toFixed(3) })}`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(SpikeModels), Effect.provide(NodeFileSystem.layer)));
