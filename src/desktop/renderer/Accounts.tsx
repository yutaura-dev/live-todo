import { useState } from "react";
import { Button, SourceMarks } from "../../design/components.js";
import type { AccountView, InboxCommand } from "../shared/api.js";

const secretOf = (key: string) => `LIVE_TODO_SECRET_GITHUB_${key.replaceAll("-", "_").toUpperCase()}_TOKEN`;

/** アカウント（今は GitHub だけ）。トークンは .env.local に書き、アプリの画面には出さない */
export function Accounts(props: { accounts: ReadonlyArray<AccountView>; onCommand: (command: InboxCommand) => Promise<string | null> }) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const add = async () => {
    const result = await props.onCommand({ _tag: "AddGitHubAccount", key, label: label.trim() === "" ? key : label.trim() });
    setProblem(result);
    if (result === null) {
      setKey("");
      setLabel("");
    }
  };
  return (
    <section className="ui-settings-section" aria-labelledby="settings-accounts">
      <h2 id="settings-accounts" className="ui-settings-title">
        アカウント
      </h2>
      <p className="ui-sub">外しても、取り込んだ事実と Task は消しません</p>
      <ul className="ui-list">
        {props.accounts.map((account) => (
          <li key={account.id} className={`ui-list-item${account.status === "外した" ? " ui-list-item--off" : ""}`}>
            <SourceMarks sources={["github"]} />
            <span className="ui-stack-4">
              <span className="ui-list-title">{account.label}</span>
              <span className={account.status === "つなぎ直しが要る" ? "ui-queue-problem" : "ui-sub"}>
                {account.status}
                {account.problem && `（${account.problem}。.env.local の ${account.secret} を確かめてください）`}
              </span>
            </span>
            {account.status !== "外した" && (
              <Button size="sm" tone="quiet" onClick={() => void props.onCommand({ _tag: "RemoveAccount", id: account.id })}>
                外す
              </Button>
            )}
          </li>
        ))}
      </ul>
      {props.accounts.some((account) => account.status === "つないでいる") && (
        <Button size="sm" className="ui-self-start" onClick={() => void props.onCommand({ _tag: "SyncNow" })}>
          今すぐ取り込む
        </Button>
      )}
      <form
        className="ui-stack-4"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <h3>GitHub のアカウントを足す</h3>
        <label className="ui-field">
          名前（英小文字・数字・ハイフン）
          <input className="ui-input" value={key} onChange={(event) => setKey(event.target.value.trim())} />
        </label>
        <label className="ui-field">
          画面に出す名前
          <input className="ui-input" value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        {key !== "" && <p className="ui-sub">トークンを .env.local の {secretOf(key)} に書いてから、足してください（アプリを起動し直すと読み込みます）</p>}
        {problem && (
          <p className="ui-role-problem" role="alert">
            {problem}
          </p>
        )}
        <Button tone="primary" size="sm" type="submit" className="ui-self-start" disabled={key === ""}>
          足してつなぐ
        </Button>
      </form>
    </section>
  );
}
