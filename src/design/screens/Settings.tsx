import { useState } from "react";
import { AppShell, ScreenHead, type View } from "../AppShell.js";
import { Button, Icon, Pill, Problem, SourceMarks } from "../components.js";

const LEVELS = ["調べる", "ローカルの書き込み", "外への書き込み（下書き）", "外への書き込み（本番）"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_HEADINGS: Record<Level, string> = {
  調べる: "調べる",
  ローカルの書き込み: "ローカルに書く",
  "外への書き込み（下書き）": "外に下書き",
  "外への書き込み（本番）": "外に本番",
};

const OPERATIONS: Array<{ name: string; source: string | null; limit: Level | null }> = [
  { name: "Claude Code に調べさせる（読むだけ）", source: null, limit: null },
  { name: "Claude Code に直させる（作業場所で直す）", source: null, limit: null },
  { name: "draft の PR を作る", source: "github", limit: "外への書き込み（下書き）" },
  { name: "issue・PR にコメントする", source: "github", limit: "外への書き込み（本番）" },
  { name: "PR を merge する", source: "github", limit: null },
  { name: "スレッドに返信する", source: "slack", limit: "外への書き込み（下書き）" },
  { name: "メールに返信する", source: "gmail", limit: null },
];

export type AiRole = { name: "Decisions" | "Generation" | "Agent"; use: string; choice: string | null; problem: string | null };

const ROLES: AiRole[] = [
  { name: "Decisions", use: "分類・確率付きの判定", choice: "OpenAI Decisions", problem: null },
  { name: "Generation", use: "Task の説明・計画を書く", choice: "Claude Sonnet", problem: null },
  { name: "Agent", use: "調査や修正などの込み入った作業", choice: "Claude Code", problem: null },
];

export const SETUP_ROLES: AiRole[] = ROLES.map((role) => (role.name === "Decisions" ? role : { ...role, choice: null }));
export const SUSPENDED_ROLES: AiRole[] = ROLES.map((role) => (role.name === "Generation" ? { ...role, problem: "API キーが切れた" } : role));

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

const RECURRING = [
  { title: "経費の領収書をまとめる", rule: "毎月 5 日", advance: "3 日前に作る", status: "使っている" as const },
  { title: "週報を書く", rule: "毎週 金曜日", advance: "当日に作る", status: "止めている" as const },
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
    <AppShell current="設定" locked={locked} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}>
      <ScreenHead title="設定" />
      {missing && (
        <div className="ui-notice" role="alert">
          <p>AI の 3 つの使い道をすべて設定して確かめるまで、アプリは使えません</p>
        </div>
      )}
      {!missing && broken && (
        <Problem title={`${broken.name} の認証が通りません（${broken.problem}）`}>
          <p>直すまで、取り込み・判定・AI の作業を止めています</p>
        </Problem>
      )}
      <div className="ui-settings">
        <nav className="ui-settings-nav" aria-label="設定の項目">
          {SECTIONS.map((section) => (
            <a key={section} href={`#ui-settings-${section}`}>
              {section}
            </a>
          ))}
        </nav>
        <div className="ui-settings-body">
          <section id="ui-settings-AI" className="ui-settings-section" aria-labelledby="ui-s-ai">
            <h2 id="ui-s-ai" className="ui-settings-title">
              AI
            </h2>
            <p className="ui-sub">会社の PC には、会社が許可した AI だけを設定してください</p>
            <ul className="ui-roles">
              {roles.map((role) => {
                const state = role.choice === null ? "missing" : role.problem ? "broken" : "ok";
                return (
                  <li key={role.name} className={`ui-role ui-role--${state}`}>
                    <div className="ui-role-head">
                      <h3>{role.name}</h3>
                      {state === "ok" && (
                        <span className="ui-role-ok">
                          <Icon name="check" size={14} />
                          使える
                        </span>
                      )}
                      {state === "missing" && <Pill tone="ruri">まだ設定していない</Pill>}
                      {state === "broken" && <Pill tone="bengara">認証が通らない</Pill>}
                    </div>
                    <p className="ui-sub">{role.use}</p>
                    <label className="ui-select">
                      <span className="ui-visually-hidden">{role.name} に使う AI</span>
                      <select defaultValue={role.choice ?? ""}>
                        <option value="" disabled>
                          選んでください
                        </option>
                        <option>{role.choice ?? "OpenAI Decisions"}</option>
                      </select>
                    </label>
                    {role.problem && <p className="ui-role-problem">{role.problem}</p>}
                    <Button tone={state === "ok" ? "quiet" : "primary"} size="sm" className="ui-self-start">
                      {state === "ok" ? "確かめ直す" : "確かめて使う"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>

          <AutonomyPolicy />

          <section id="ui-settings-アカウント" className="ui-settings-section" aria-labelledby="ui-s-accounts">
            <h2 id="ui-s-accounts" className="ui-settings-title">
              アカウント
            </h2>
            <p className="ui-sub">外しても、取り込んだ事実と Task は消しません</p>
            <ul className="ui-list">
              {ACCOUNTS.map((account) => (
                <li key={account.label} className={`ui-list-item${account.status === "外した" ? " ui-list-item--off" : ""}`}>
                  <SourceMarks sources={[account.source]} />
                  <span className="ui-stack-4">
                    <span className="ui-list-title">{account.label}</span>
                    {account.status === "つなぎ直しが要る" ? (
                      <span className="ui-queue-problem">
                        つなぎ直しが要る{account.problem && `（${account.problem}）`}
                      </span>
                    ) : (
                      <span className="ui-sub">{account.status}</span>
                    )}
                  </span>
                  <span className="ui-row ui-row--end">
                    {ACCOUNT_ACTIONS[account.status].map((action, index) => (
                      <Button key={action} size="sm" tone={index === 0 && account.status === "つなぎ直しが要る" ? "primary" : index === 0 ? "secondary" : "quiet"}>
                        {action}
                      </Button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <Button size="sm" className="ui-self-start">
              <Icon name="plus" size={14} />
              アカウントを足す
            </Button>
          </section>

          <section id="ui-settings-定期の Task" className="ui-settings-section" aria-labelledby="ui-s-recurring">
            <h2 id="ui-s-recurring" className="ui-settings-title">
              定期の Task
            </h2>
            <ul className="ui-list">
              {RECURRING.map((rule) => (
                <li key={rule.title} className={`ui-list-item${rule.status === "止めている" ? " ui-list-item--off" : ""}`}>
                  <span className="ui-recurring-rule ui-num">{rule.rule}</span>
                  <span className="ui-stack-4">
                    <span className="ui-list-title">{rule.title}</span>
                    <span className="ui-sub">
                      {rule.advance}
                      {rule.status === "止めている" && "（止めている）"}
                    </span>
                  </span>
                  <span className="ui-row ui-row--end">
                    <Button size="sm" tone="quiet">
                      直す
                    </Button>
                    <Button size="sm" tone="quiet">
                      {rule.status === "使っている" ? "止める" : "また使う"}
                    </Button>
                    <Button size="sm" tone="quiet">
                      消す
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            <Button size="sm" className="ui-self-start">
              <Icon name="plus" size={14} />
              定期の Task を足す
            </Button>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * 自動でやってよい範囲。操作ごとに、どの段まで自動にするかを選ぶ。
 * 段を表の列にする理由: 段には順があり（調べる < ローカル < 下書き < 本番）、「ここまで」を 1 つ選ぶ形が伝わりやすい。
 * 選んだ段より手前の段にも薄く色を付け、「ここまでが自動」という範囲を目で追えるようにする。
 */
function AutonomyPolicy() {
  const [limits, setLimits] = useState(() => OPERATIONS.map((operation) => operation.limit));
  return (
    <section id="ui-settings-自動でやってよい範囲" className="ui-settings-section" aria-labelledby="ui-s-autonomy">
      <h2 id="ui-s-autonomy" className="ui-settings-title">
        自動でやってよい範囲
      </h2>
      <p className="ui-sub">承認なしで AI が進めてよいところまでを、操作ごとに選びます。決めない操作は、ローカルに書くまでを自動でやります</p>
      <table className="ui-policy">
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
          {OPERATIONS.map((operation, row) => {
            const limit = limits[row] ?? null;
            // 決めない操作は、ローカルに書くまでを自動でやる。その範囲も淡く見せる
            const unset = limit === null;
            const limitIndex = unset ? LEVELS.indexOf("ローカルの書き込み") : LEVELS.indexOf(limit);
            return (
              <tr key={operation.name}>
                <th scope="row">
                  <span className="ui-row">
                    {operation.source && <SourceMarks sources={[operation.source]} />}
                    {operation.name}
                  </span>
                </th>
                {[...LEVELS, null].map((level, column) => (
                  <td key={level ?? "unset"} className={level !== null && column <= limitIndex ? (unset ? "ui-policy-in ui-policy-in--default" : "ui-policy-in") : undefined}>
                    <input
                      type="radio"
                      name={`ui-limit-${row}`}
                      aria-label={`${operation.name}: ${level === null ? "決めない" : `${level}まで`}`}
                      checked={limits[row] === level}
                      onChange={() => setLimits((current) => current.map((value, i) => (i === row ? level : value)))}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
