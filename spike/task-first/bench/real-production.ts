import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem, Option } from "effect";
import { conditionProbability, decomposeCondition } from "../../../src/core/rules/rule-condition.js";
import { interpretRuleActions, ruleActionsOf } from "../../../src/core/rules/rule-actions.js";
import { dossierOf } from "../../../src/core/task/dossier.js";
import { githubFactOf } from "../../../src/sources/github/github-binding.js";
import { SpikeModels } from "../llm.js";

// 本番のコード（src）で、実データの PR に例のルールを当てる。spike で測った精度が、繋ぎこんだあとも出るかを確かめる
type RealPr = { url: string; repo: string; org: string; reason: string | null; author: string; reviewers: string[]; teams: string[]; state: string; merged: boolean; title: string; body: string; myTeamRequested: boolean; otherTeams: string[] };

const ME = "YutaUra";
const WHEN = "YutaUra 以外が作成している GitHub の PR で、YutaUra（または YutaUra を含むチーム）にレビュー依頼が来ていないもの";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const prs: RealPr[] = JSON.parse(yield* fs.readFileString("spike/task-first/data/real-prs.json"));
  const condition = yield* decomposeCondition(WHEN);
  console.log(JSON.stringify(condition));
  const actions = ruleActionsOf(yield* interpretRuleActions({ then: "そのまま完了にする", labels: [] }));
  const mixed = ruleActionsOf(yield* interpretRuleActions({ then: "YutaUra(または YutaUra を含むグループ宛て) にレビュー依頼がない場合はそのまま完了にする", labels: [] }));
  console.log("何をする:", JSON.stringify(actions), "/ 条件入り:", JSON.stringify(mixed));
  const myTeams = new Set(prs.flatMap((p) => p.teams.filter((t) => !p.otherTeams.includes(t)).map((t) => `${p.org}/${t}`)));
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  yield* Effect.forEach(
    prs,
    (p) =>
      Effect.gen(function* () {
        const fact = githubFactOf(
          {
            externalId: p.url, reason: p.reason ?? "subscribed", subjectType: "PullRequest", title: p.title, repository: p.repo, htmlUrl: p.url,
            state: p.merged ? "merged" : p.state === "closed" ? "closed" : "open", updatedAt: "2026-11-27T00:00:00Z", author: p.author,
            ...(p.body.trim() === "" ? {} : { bodyExcerpt: p.body }),
            requestedReviewers: p.reviewers, requestedTeams: p.teams.map((t) => `${p.org}/${t}`),
          },
          { viewer: Option.some(ME), myTeams: Option.some(myTeams) },
        );
        const dossier = dossierOf({ id: 1, title: p.title, brief: null, status: "needs_review", recurringTaskId: null }, [
          { role: "tracks", item: { source: "github:work", title: p.title, url: p.url, state: p.state === "open" ? "open" : "resolved", author: p.author, fact } },
        ]);
        const probability = yield* conditionProbability(condition, dossier);
        const applied = probability !== undefined && probability >= 0.8;
        const truth = p.author !== ME && !p.reviewers.includes(ME) && !p.myTeamRequested;
        if (applied && truth) m.tp++;
        else if (applied) { m.fp++; console.log("✗ 誤って当てた", p.url, probability); }
        else if (truth) { m.fn++; console.log("✗ 当て損ねた", p.url, probability); }
        else m.tn++;
      }),
    { concurrency: 8 },
  );
  console.log(JSON.stringify(m));
});
NodeRuntime.runMain(program.pipe(Effect.provide(SpikeModels), Effect.provide(NodeFileSystem.layer)));
