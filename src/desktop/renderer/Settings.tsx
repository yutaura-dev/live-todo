import { useState } from "react";
import { ScreenHead } from "../../design/AppShell.js";
import { Button, Icon, Pill, Problem } from "../../design/components.js";
import type { AccountView, AiCommand, AiSettingsView, InboxCommand } from "../shared/api.js";
import { Accounts } from "./Accounts.js";

const ROLES = [
  { use: "decisions", name: "Decisions", description: "分類・確率付きの判定" },
  { use: "generation", name: "Generation", description: "Task の説明・計画を書く" },
  { use: "agent", name: "Agent", description: "調査や修正などの込み入った作業" },
] as const;

/** 設定（AI とアカウント）。AI 設定が使えるまでは、この画面だけを出す */
export function Settings(props: {
  settings: AiSettingsView;
  onConfigure: (command: AiCommand) => Promise<string | null>;
  accounts: ReadonlyArray<AccountView>;
  onInbox: (command: InboxCommand) => Promise<string | null>;
}) {
  const { settings } = props;
  return (
    <>
      <ScreenHead title="設定" />
      {settings.status === "初期設定中" && (
        <div className="ui-notice" role="alert">
          <p>AI の 3 つの使い道をすべて設定して確かめるまで、アプリは使えません</p>
        </div>
      )}
      {settings.problem && (
        <Problem title={`${settings.problem.use} の認証が通りません（${settings.problem.reason}）`}>
          <p>直すまで、取り込み・判定・AI の作業を止めています。API キーを確かめて、確かめ直してください</p>
        </Problem>
      )}
      <section className="ui-settings-section" aria-labelledby="settings-ai">
        <h2 id="settings-ai" className="ui-settings-title">
          AI
        </h2>
        <p className="ui-sub">会社の PC には、会社が許可した AI だけを設定してください。API キーは .env.local に書きます（アプリの画面には出しません）</p>
        <ul className="ui-roles">
          {ROLES.map((role) => (
            <Role key={role.use} role={role} view={settings.uses[role.use]} broken={settings.problem?.use === role.name} onConfigure={props.onConfigure} />
          ))}
        </ul>
      </section>
      {settings.status === "使える" && <Accounts accounts={props.accounts} onCommand={props.onInbox} />}
    </>
  );
}

function Role(props: {
  role: (typeof ROLES)[number];
  view: AiSettingsView["uses"]["decisions"];
  broken: boolean;
  onConfigure: (command: AiCommand) => Promise<string | null>;
}) {
  const { role, view } = props;
  const [choice, setChoice] = useState(view.selected ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const state = view.selected === null ? "missing" : props.broken ? "broken" : "ok";
  const secret = view.options.find((option) => option.id === choice)?.secret ?? null;
  const selectId = `ai-${role.use}`;

  const check = async () => {
    setChecking(true);
    setProblem(await props.onConfigure({ _tag: "ConfigureAi", use: role.use, option: choice }));
    setChecking(false);
  };

  return (
    <li className={`ui-role ui-role--${state}`} aria-label={role.name}>
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
      <p className="ui-sub">{role.description}</p>
      <label className="ui-select" htmlFor={selectId}>
        <span className="ui-visually-hidden">{role.name} に使う AI</span>
        <select id={selectId} value={choice} onChange={(event) => setChoice(event.target.value)}>
          <option value="" disabled>
            選んでください
          </option>
          {view.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {secret && <p className="ui-sub">API キーを .env.local の {secret} に書いてから確かめてください</p>}
      {problem && (
        <p className="ui-role-problem" role="alert">
          {problem}
        </p>
      )}
      <Button tone={state === "ok" ? "quiet" : "primary"} size="sm" className="ui-self-start" disabled={choice === "" || checking} onClick={() => void check()}>
        {checking ? "確かめています" : state === "ok" ? "確かめ直す" : "確かめて使う"}
      </Button>
    </li>
  );
}
