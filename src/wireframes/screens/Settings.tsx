import { useState } from "react";
import { Box, Button, Mark, SourceMarks } from "../parts.js";
import { AppFrame, ScreenHead, type View } from "./AppFrame.js";

const LEVELS = ["調べる", "ローカルの書き込み", "外への書き込み（下書き）", "外への書き込み（本番）"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_HEADINGS: Record<Level, string> = {
  調べる: "調べる",
  ローカルの書き込み: "ローカルに書く",
  "外への書き込み（下書き）": "外に下書き",
  "外への書き込み（本番）": "外に本番",
};

/** 操作は provider が決める。Agent の作業は渡す道具で段が決まるので、読むだけ・直すを別の操作にする（specs/autonomy-policy.spec.ts） */
const OPERATIONS: Array<{ name: string; source: string | null; limit: Level | null }> = [
  { name: "Claude Code に調べさせる（読むだけ）", source: null, limit: null },
  { name: "Claude Code に直させる（作業場所で直す）", source: null, limit: null },
  { name: "draft の PR を作る", source: "github", limit: "外への書き込み（下書き）" },
  { name: "issue・PR にコメントする", source: "github", limit: "外への書き込み（本番）" },
  { name: "PR を merge する", source: "github", limit: null },
  { name: "スレッドに返信する", source: "slack", limit: "外への書き込み（下書き）" },
  { name: "メールに返信する", source: "gmail", limit: null },
];

/** AI の使い道（specs/ai-settings.spec.ts）。3 つの違いは役割で、確かさの段ではない */
export type AiRole = { name: "Decisions" | "Generation" | "Agent"; use: string; choice: string | null; problem: string | null };

const ROLES: AiRole[] = [
  { name: "Decisions", use: "分類・確率付きの判定", choice: "OpenAI Decisions", problem: null },
  { name: "Generation", use: "Task の説明・計画を書く", choice: "Claude Sonnet", problem: null },
  { name: "Agent", use: "調査や修正などの込み入った作業", choice: "Claude Code", problem: null },
];

export const SETUP_ROLES: AiRole[] = ROLES.map((role) => (role.name === "Decisions" ? role : { ...role, choice: null }));
export const SUSPENDED_ROLES: AiRole[] = ROLES.map((role) => (role.name === "Generation" ? { ...role, problem: "API キーが切れた" } : role));

/** アカウント（specs/account.spec.ts）。つながっているかと、つなぎ直しが要る理由だけを持つ */
type AccountView = { source: string; label: string; status: "つないでいない" | "つないでいる" | "つなぎ直しが要る" | "外した"; problem?: string };

const ACCOUNTS: AccountView[] = [
  { source: "github", label: "会社の GitHub", status: "つないでいる" },
  { source: "slack", label: "会社の Slack", status: "つなぎ直しが要る", problem: "セッションが切れた" },
  { source: "gmail", label: "会社の Gmail", status: "つないでいる" },
  { source: "outlook", label: "会社の Outlook", status: "つないでいない" },
  { source: "notion", label: "会社の Notion", status: "外した" },
];

const ACCOUNT_ACTIONS: Record<AccountView["status"], string[]> = {
  つないでいない: ["つなぐ", "外す"],
  つないでいる: ["取り込む範囲を変える", "外す"],
  つなぎ直しが要る: ["つなぎ直す", "外す"],
  外した: ["戻す"],
};

/** 定期の Task の決まり（specs/recurring-task.spec.ts） */
const RECURRING = [
  { title: "経費の領収書をまとめる", rule: "毎月 5 日", advance: "3 日前に作る", due: "作った日から 3 日後が期日", status: "使っている" as const, last: "11 月 5 日の回まで作った" },
  { title: "週報を書く", rule: "毎週 金曜日", advance: "当日に作る", due: "期日なし", status: "止めている" as const, last: "11 月 21 日の回まで作った" },
];

const SECTIONS = ["AI", "自動でやってよい範囲", "アカウント", "定期の Task"] as const;

/**
 * 設定。1 つの長い画面に並べ、左の目次で飛ぶ。
 * タブで分けない理由: 設定は「上から順に整える」ことが多く、どこまで済んだかを 1 画面で見渡したいため。
 */
export function Settings(props: { roles?: AiRole[]; onNavigate?: (view: View) => void }) {
  const roles = props.roles ?? ROLES;
  const missing = roles.some((role) => role.choice === null);
  const broken = roles.find((role) => role.problem !== null);
  const locked = missing || broken !== undefined;
  return (
    <AppFrame current="設定" locked={locked} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}>
      <ScreenHead title="設定" />
      {missing && (
        <div className="wf-box wf-box--mine wf-banner" role="alert">
          <p>AI の 3 つの使い道をすべて設定して確かめるまで、アプリは使えません</p>
          <Mark n={1} />
        </div>
      )}
      {!missing && broken && (
        <div className="wf-box wf-box--error wf-banner" role="alert">
          <p>
            <span className="wf-error-text">⚠</span> {broken.name} の認証が通りません（{broken.problem}）。直すまで、同期・判定・AI の作業を止めています
          </p>
          <Mark n={1} />
        </div>
      )}
      <div className="wf-settings">
        <nav className="wf-settings-nav" aria-label="設定の項目">
          {SECTIONS.map((section) => (
            <a key={section} href={`#wf-settings-${section}`}>
              {section}
            </a>
          ))}
        </nav>
        <div className="wf-stack" style={{ gap: 40 }}>
          <section id="wf-settings-AI" className="wf-section" aria-labelledby="wf-s-ai">
            <h2 id="wf-s-ai" className="wf-section-title">
              AI <Mark n={2} />
            </h2>
            <p className="wf-sub">会社の PC には、会社が許可した AI だけを設定してください</p>
            <div className="wf-roles">
              {roles.map((role) => {
                const state = role.choice === null ? "まだ設定していない" : role.problem ? `認証が通らない（${role.problem}）` : "使える";
                return (
                  <Box key={role.name} kind={state === "使える" ? "fact" : role.problem ? "error" : "mine"} className="wf-role">
                    <h3>{role.name}</h3>
                    <p className={state === "使える" ? "wf-task-reason" : undefined}>{role.use}</p>
                    <div className="wf-placeholder-field">
                      <span>{role.choice ?? "選んでください"}</span>
                      <span aria-hidden="true">▾</span>
                    </div>
                    <p>{state}</p>
                    <Button tone={state === "使える" ? "quiet" : "primary"}>{state === "使える" ? "選び直す" : "確かめて使う"}</Button>
                  </Box>
                );
              })}
            </div>
          </section>

          <AutonomyPolicy />

          <section id="wf-settings-アカウント" className="wf-section" aria-labelledby="wf-s-accounts">
            <h2 id="wf-s-accounts" className="wf-section-title">
              アカウント <Mark n={4} />
            </h2>
            <ul className="wf-stack" style={{ gap: 8 }}>
              {ACCOUNTS.map((account) => (
                <li key={account.label} className="wf-fact">
                  <SourceMarks sources={[account.source]} />
                  <span>
                    {account.label}
                    <br />
                    <span className={account.status === "つなぎ直しが要る" ? "wf-pill wf-pill--mine" : "wf-task-reason"}>
                      {account.status}
                      {account.problem && `（${account.problem}）`}
                    </span>
                  </span>
                  <span className="wf-button-row">
                    {ACCOUNT_ACTIONS[account.status].map((action, index) => (
                      <Button key={action} tone={index === 0 && account.status !== "つないでいる" ? "primary" : "quiet"}>
                        {action}
                      </Button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <div className="wf-button-row">
              <Button>アカウントを足す</Button>
            </div>
          </section>

          <section id="wf-settings-定期の Task" className="wf-section" aria-labelledby="wf-s-recurring">
            <h2 id="wf-s-recurring" className="wf-section-title">
              定期の Task <Mark n={5} />
            </h2>
            <ul className="wf-stack" style={{ gap: 8 }}>
              {RECURRING.map((rule) => (
                <li key={rule.title} className="wf-fact">
                  <span className={rule.status === "使っている" ? "wf-pill" : "wf-pill wf-pill--waiting"}>{rule.status}</span>
                  <span>
                    {rule.title}
                    <br />
                    <span className="wf-task-reason">
                      {rule.rule}（{rule.advance}）
                    </span>
                  </span>
                  <span className="wf-button-row">
                    <Button tone="quiet">直す</Button>
                    <Button tone="quiet">{rule.status === "使っている" ? "止める" : "また使う"}</Button>
                    <Button tone="quiet">消す</Button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="wf-button-row">
              <Button>定期の Task を足す</Button>
            </div>
          </section>
        </div>
      </div>
    </AppFrame>
  );
}

/**
 * 自動でやってよい範囲（specs/autonomy-policy.spec.ts）。操作ごとに、どの段まで自動にするかを選ぶ。
 * 段を表の列にする理由: 段には順があり（調べる < ローカル < 下書き < 本番）、「ここまで」を 1 つ選ぶ形が伝わりやすい。
 */
function AutonomyPolicy() {
  const [limits, setLimits] = useState(() => OPERATIONS.map((operation) => operation.limit));
  return (
    <section id="wf-settings-自動でやってよい範囲" className="wf-section" aria-labelledby="wf-s-autonomy">
      <h2 id="wf-s-autonomy" className="wf-section-title">
        自動でやってよい範囲 <Mark n={3} />
      </h2>
      <p className="wf-sub">承認なしで AI が進めてよいところまで</p>
      <table className="wf-policy">
        <thead>
          <tr>
            <th scope="col">操作</th>
            {LEVELS.map((level) => (
              <th key={level} scope="col" title={`${level}まで`}>
                {LEVEL_HEADINGS[level]}
              </th>
            ))}
            <th scope="col">決めない</th>
          </tr>
        </thead>
        <tbody>
          {OPERATIONS.map((operation, row) => (
            <tr key={operation.name}>
              <th scope="row">
                <span className="wf-task-top" style={{ flexWrap: "nowrap" }}>
                  {operation.source && <SourceMarks sources={[operation.source]} />}
                  {operation.name}
                </span>
              </th>
              {[...LEVELS, null].map((level) => (
                <td key={level ?? "unset"}>
                  <input
                    type="radio"
                    name={`wf-limit-${row}`}
                    aria-label={`${operation.name}: ${level === null ? "決めない" : `${level}まで`}`}
                    checked={limits[row] === level}
                    onChange={() => setLimits((current) => current.map((value, i) => (i === row ? level : value)))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export const SETTINGS_NOTES = [
  { n: 1, text: "AI が 3 つそろうまで（または認証が通らない間）は、ほかの画面を開けない。同期・判定・AI の作業も止める" },
  { n: 2, text: "3 つは役割の違いで、確かさの段ではない。それぞれ選んで、認証が通ったときだけ使える" },
  { n: 3, text: "段には順があるので、操作ごとに「ここまで」を 1 つ選ぶ表にする。決めない操作は、ローカルに書くまでを自動でやる" },
  { n: 4, text: "アカウントの状態ごとに出す操作が変わる。外しても、取り込んだ事実と Task は消さない。外したのと同じアカウントを足すと、前のアカウントに戻して続きから取り込む" },
  { n: 5, text: "足す・直す・また使うとき、直近の回の作る日をもう過ぎていたら、その回を作るか見送るかを選ぶ。消しても作った Task は残す" },
];

