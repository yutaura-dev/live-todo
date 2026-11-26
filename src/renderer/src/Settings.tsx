import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  AccountFilterPreview,
  ConfigDocument,
  FilterReason,
  RuleDraft,
  GitHubTokenSummary,
  SecretStatus,
  SettingsSnapshot,
} from "../../shared/api.js";
import { api } from "./api.js";
import { RecurringSettings } from "./Recurring.js";
import { describeActions, existingTargetsOf, isInterpreted, newRule } from "./gmail-rules.js";
import { hasAccountOverrides, type JudgeSetting, judgeSettingOf, MODEL_CHOICES, withJudgeSetting } from "./judge-settings.js";

type Account = ConfigDocument["accounts"][number];
type SlackAccountDraft = NonNullable<ConfigDocument["slackAccounts"]>[number];
type GmailAccountDraft = NonNullable<ConfigDocument["gmailAccounts"]>[number];
type NotionAccountDraft = NonNullable<ConfigDocument["notionAccounts"]>[number];
type MicrosoftAccountDraft = NonNullable<ConfigDocument["microsoftAccounts"]>[number];

const PREVIEW_DELAY_MS = 400;

const EMPTY_CONFIG: ConfigDocument = {
  llmProfiles: { default: { provider: "none", model: "-" } },
  defaultLlmProfile: "default",
  accounts: [],
};

const SECRET_LABELS: Record<SecretStatus, string> = {
  saved: "保存済み（キーチェーンで暗号化）",
  env: "環境変数から読んでいる",
  missing: "未登録",
};

/** 設定ファイルの中身を画面で編集できる形にする。読めない項目は既定値で埋める（保存時に main で検証する） */
function toDocument(config: unknown): ConfigDocument {
  if (typeof config !== "object" || config === null) return EMPTY_CONFIG;
  const draft = config as Partial<ConfigDocument>;
  return {
    llmProfiles: draft.llmProfiles ?? EMPTY_CONFIG.llmProfiles,
    defaultLlmProfile: draft.defaultLlmProfile ?? EMPTY_CONFIG.defaultLlmProfile,
    accounts: Array.isArray(draft.accounts) ? draft.accounts : [],
    slackAccounts: Array.isArray(draft.slackAccounts) ? draft.slackAccounts : [],
    // 画面で扱わない項目も落とさない（ここで落とすと、保存したときに設定ファイルから消える）
    gmailAccounts: Array.isArray(draft.gmailAccounts) ? draft.gmailAccounts : [],
    notionAccounts: Array.isArray(draft.notionAccounts) ? draft.notionAccounts : [],
    microsoftAccounts: Array.isArray(draft.microsoftAccounts) ? draft.microsoftAccounts : [],
    rules: Array.isArray(draft.rules) ? draft.rules : [],
  };
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

export function Settings() {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<ConfigDocument>(EMPTY_CONFIG);
  const [saveState, setSaveState] = useState<{ kind: "idle" } | { kind: "saved" } | { kind: "failed"; message: string }>({ kind: "idle" });

  const reload = useCallback(async () => {
    const next = await api.settings();
    setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    void reload().then((next) => setDraft(toDocument(next.config)));
  }, [reload]);

  const updateAccount = (index: number, next: Account) =>
    setDraft((current) => ({ ...current, accounts: current.accounts.map((account, at) => (at === index ? next : account)) }));

  const save = async () => {
    const outcome = await api.saveConfig(draft);
    setSaveState(outcome.ok ? { kind: "saved" } : { kind: "failed", message: outcome.message });
    await reload();
  };

  if (snapshot === null) return <p className="settings-loading">設定を読み込んでいます</p>;

  return (
    <div className="settings">
      <div className="settings-body">
        <h2 className="settings-title">設定</h2>
        <p className="settings-path">設定ファイル: {snapshot.configPath}</p>
        {snapshot.problems.map((problem) => (
          <p key={problem} className="problem" role="alert">
            {problem}
          </p>
        ))}
        {!snapshot.encryptionAvailable && (
          <p className="problem" role="alert">
            macOS のキーチェーンが使えないため、トークンや API キーを保存できません。
          </p>
        )}

        <section className="settings-section" aria-labelledby="accounts-heading">
          <h3 id="accounts-heading" className="section-title">
            GitHub アカウント
          </h3>
          {draft.accounts.map((account, index) => (
            <AccountEditor
              key={account.id || index}
              account={account}
              tokenStatus={snapshot.secrets[`github.${account.id}.token`] ?? "missing"}
              tokenSummary={snapshot.githubTokens[account.id]}
              onChange={(next) => updateAccount(index, next)}
              onRemove={() => setDraft((current) => ({ ...current, accounts: current.accounts.filter((_, at) => at !== index) }))}
              onSecretChanged={reload}
            />
          ))}
          <AddAccount
            existing={draft.accounts.map((account) => account.id)}
            onAdd={(id) => setDraft((current) => ({ ...current, accounts: [...current.accounts, { kind: "github", id }] }))}
          />
        </section>

        <section className="settings-section" aria-labelledby="slack-heading">
          <h3 id="slack-heading" className="section-title">
            Slack ワークスペース
          </h3>
          <p className="field-hint">
            To-do・Saved（後で）にしたメッセージを Task にします。ブラウザのセッションを使うので、私用のワークスペースか、管理者に確かめたワークスペースだけで使ってください
          </p>
          {(draft.slackAccounts ?? []).map((account, index) => (
            <SlackAccountEditor
              key={account.id || index}
              account={account}
              secrets={snapshot.secrets}
              onChange={(next) =>
                setDraft((current) => ({ ...current, slackAccounts: (current.slackAccounts ?? []).map((entry, at) => (at === index ? next : entry)) }))
              }
              onRemove={() => setDraft((current) => ({ ...current, slackAccounts: (current.slackAccounts ?? []).filter((_, at) => at !== index) }))}
              onSecretChanged={reload}
              onConnected={async () => setDraft(toDocument((await reload()).config))}
            />
          ))}
          <AddAccount
            label="ワークスペースを追加"
            placeholder="home"
            existing={[...draft.accounts.map((account) => account.id), ...(draft.slackAccounts ?? []).map((account) => account.id)]}
            onAdd={(id) =>
              setDraft((current) => ({
                ...current,
                slackAccounts: [...(current.slackAccounts ?? []), { kind: "slack", id, workspace: "", userAgent: "" }],
              }))
            }
          />
        </section>

        <section className="settings-section" aria-labelledby="microsoft-heading">
          <h3 id="microsoft-heading" className="section-title">
            Microsoft（Outlook・Teams）
          </h3>
          <p className="field-hint">
            職場のアカウントに device code 認証でサインインします。Entra ID に登録したアプリの client ID とテナント ID が要ります（手順は docs/setup/microsoft.md）。職場のデータを扱うので、使う LLM Profile を選んでください
          </p>
          {(draft.microsoftAccounts ?? []).map((account, index) => (
            <MicrosoftAccountEditor
              key={account.id || index}
              account={account}
              profiles={Object.keys(draft.llmProfiles)}
              secrets={snapshot.secrets}
              onChange={(next) =>
                setDraft((current) => ({ ...current, microsoftAccounts: (current.microsoftAccounts ?? []).map((entry, at) => (at === index ? next : entry)) }))
              }
              onRemove={() => setDraft((current) => ({ ...current, microsoftAccounts: (current.microsoftAccounts ?? []).filter((_, at) => at !== index) }))}
              onSignedIn={reload}
            />
          ))}
          <AddAccount
            label="Microsoft のアカウントを追加"
            placeholder="corp"
            existing={[
              ...draft.accounts.map((account) => account.id),
              ...(draft.slackAccounts ?? []).map((account) => account.id),
              ...(draft.gmailAccounts ?? []).map((account) => account.id),
              ...(draft.notionAccounts ?? []).map((account) => account.id),
              ...(draft.microsoftAccounts ?? []).map((account) => account.id),
            ]}
            onAdd={(id) => setDraft((current) => ({ ...current, microsoftAccounts: [...(current.microsoftAccounts ?? []), { kind: "microsoft", id, tenantId: "", clientId: "" }] }))}
          />
        </section>

        <section className="settings-section" aria-labelledby="notion-heading">
          <h3 id="notion-heading" className="section-title">
            Notion
          </h3>
          <p className="field-hint">
            受信トレイに届いたメンション・コメント・リマインダーを Task にします。ブラウザのセッションを使うので、私用のワークスペースか、管理者に確かめたワークスペースだけで使ってください
          </p>
          {(draft.notionAccounts ?? []).map((account, index) => (
            <NotionAccountEditor
              key={account.id || index}
              account={account}
              secrets={snapshot.secrets}
              onChange={(next) =>
                setDraft((current) => ({ ...current, notionAccounts: (current.notionAccounts ?? []).map((entry, at) => (at === index ? next : entry)) }))
              }
              onRemove={() => setDraft((current) => ({ ...current, notionAccounts: (current.notionAccounts ?? []).filter((_, at) => at !== index) }))}
              onSecretChanged={reload}
              onConnected={async () => setDraft(toDocument((await reload()).config))}
            />
          ))}
          <AddAccount
            label="Notion のアカウントを追加"
            placeholder="notes"
            existing={[
              ...draft.accounts.map((account) => account.id),
              ...(draft.slackAccounts ?? []).map((account) => account.id),
              ...(draft.gmailAccounts ?? []).map((account) => account.id),
              ...(draft.notionAccounts ?? []).map((account) => account.id),
            ]}
            onAdd={(id) => setDraft((current) => ({ ...current, notionAccounts: [...(current.notionAccounts ?? []), { kind: "notion", id, userId: "", userAgent: "" }] }))}
          />
        </section>

        <section className="settings-section" aria-labelledby="gmail-heading">
          <h3 id="gmail-heading" className="section-title">
            Gmail
          </h3>
          <p className="field-hint">メールを取り込み、メルマガ・お知らせは送り主と用件ごとに、人からのメールはやることがあれば Task にします。認証は gws に任せます</p>
          {(draft.gmailAccounts ?? []).map((account, index) => (
            <GmailAccountEditor
              key={account.id || index}
              account={account}
              onChange={(next) =>
                setDraft((current) => ({ ...current, gmailAccounts: (current.gmailAccounts ?? []).map((entry, at) => (at === index ? next : entry)) }))
              }
              onRemove={() => setDraft((current) => ({ ...current, gmailAccounts: (current.gmailAccounts ?? []).filter((_, at) => at !== index) }))}
            />
          ))}
          <AddAccount
            label="Gmail のアカウントを追加"
            placeholder="mail"
            existing={[...draft.accounts.map((account) => account.id), ...(draft.slackAccounts ?? []).map((account) => account.id), ...(draft.gmailAccounts ?? []).map((account) => account.id)]}
            onAdd={(id) => setDraft((current) => ({ ...current, gmailAccounts: [...(current.gmailAccounts ?? []), { kind: "gmail", id }] }))}
          />
        </section>

        <section className="settings-section" aria-labelledby="rules-heading">
          <h3 id="rules-heading" className="section-title">
            ルール
          </h3>
          <p className="field-hint">
            条件に当てはまるものが届いたら、決めた操作を自動で行います。当てはまるかは条件の文から判定し、確かなときだけ当てます。ルールを作る前に届いたものには当てません
          </p>
          {(draft.rules ?? []).map((rule, index) => (
            <RuleEditor
              key={rule.id}
              rule={rule}
              onChange={(next) => setDraft((current) => ({ ...current, rules: (current.rules ?? []).map((entry, at) => (at === index ? next : entry)) }))}
              onRemove={() => setDraft((current) => ({ ...current, rules: (current.rules ?? []).filter((_, at) => at !== index) }))}
            />
          ))}
          <button
            type="button"
            className="quiet-button"
            onClick={() => setDraft((current) => ({ ...current, rules: [...(current.rules ?? []), newRule(new Date().toISOString(), crypto.randomUUID())] }))}
          >
            ルールを追加
          </button>
        </section>

        <RecurringSettings />

        <section className="settings-section" aria-labelledby="judge-heading">
          <h3 id="judge-heading" className="section-title">
            判定に使う LLM
          </h3>
          {hasAccountOverrides(draft) && (
            <p className="preview-warning">
              設定ファイルでアカウントごとに別の LLM を指定しています。ここで保存すると、すべてのアカウントがこの設定を使います。
            </p>
          )}
          <JudgeEditor
            setting={judgeSettingOf(draft)}
            onChange={(setting) => setDraft((current) => withJudgeSetting(current, setting))}
            secrets={snapshot.secrets}
            onSecretChanged={reload}
          />
        </section>
      </div>

      <footer className="settings-footer">
        <button type="button" className="primary-button" onClick={() => void save()}>
          設定を保存
        </button>
        <p className="save-state" role="status">
          {saveState.kind === "saved" && "保存しました。新しい設定で同期をやり直しています。"}
          {saveState.kind === "failed" && `保存できませんでした: ${saveState.message}`}
        </p>
      </footer>
    </div>
  );
}

function AccountEditor(props: {
  account: Account;
  tokenStatus: SecretStatus;
  tokenSummary: GitHubTokenSummary | undefined;
  onChange: (next: Account) => void;
  onRemove: () => void;
  onSecretChanged: () => Promise<unknown>;
}) {
  const { account } = props;
  const id = useId();
  const [include, setInclude] = useState((account.repositories?.include ?? []).join("\n"));
  const [exclude, setExclude] = useState((account.repositories?.exclude ?? []).join("\n"));
  const [targets, setTargets] = useState("");
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AccountFilterPreview | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const latestRequest = useRef(0);

  const updateFilter = (nextInclude: string, nextExclude: string) => {
    setInclude(nextInclude);
    setExclude(nextExclude);
    props.onChange({ ...account, repositories: { include: lines(nextInclude), exclude: lines(nextExclude) } });
  };

  // 入力のたびに送らず、手を止めてから判定する。GitHub の一覧は main が数分間覚えているので、ここで送るのは手元の判定だけ
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const request = ++latestRequest.current;
      setPreviewing(true);
      void api
        .previewFilter({ accountId: account.id, filter: { include: lines(include), exclude: lines(exclude) }, targets: lines(targets) })
        .then((result) => {
          // 後から届いた古い応答で、新しい結果を上書きしない
          if (request !== latestRequest.current) return;
          if ("error" in result) {
            setPreviewProblem(result.error);
          } else {
            setPreview(result);
            setPreviewProblem(null);
          }
        })
        .finally(() => {
          if (request === latestRequest.current) setPreviewing(false);
        });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, account.id, include, exclude, targets, props.tokenStatus]);

  return (
    <details className="account" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="account-header">
        <h4 className="account-name">{account.id}</h4>
        <span className="field-hint">{props.tokenSummary ? `${props.tokenSummary.login}・` : ""}トークン: {SECRET_LABELS[props.tokenStatus]}</span>
      </summary>
      <div className="account-body">

      <SecretField label="トークン" secretKey={`github.${account.id}.token`} status={props.tokenStatus} onChanged={props.onSecretChanged} />
      {props.tokenStatus === "saved" && props.tokenSummary && <TokenSummary summary={props.tokenSummary} />}
      {props.tokenStatus === "env" && (
        <p className="token-summary">環境変数のトークンは確かめていません。ここに貼り付けて保存すると、権限と有効期限を確かめます。</p>
      )}

      <label className="checkbox judge-probabilities">
        <input
          type="checkbox"
          checked={account.reviewDependencyPrs ?? false}
          onChange={(event) => props.onChange({ ...account, reviewDependencyPrs: event.target.checked })}
        />
        <span>
          <span className="judge-option-label">依存更新の PR を Claude Code で自動で調べる</span>
          <span className="field-hint">
            renovate / dependabot の PR を見つけたら、merge してよいかと影響範囲を調べます。PR とリポジトリのコードを Claude に送るので、送ってよいアカウントだけで有効にしてください
          </span>
        </span>
      </label>

      <label className="checkbox judge-probabilities">
        <input
          type="checkbox"
          checked={account.planNextActions ?? false}
          onChange={(event) => props.onChange({ ...account, planNextActions: event.target.checked })}
        />
        <span>
          <span className="judge-option-label">次にやることを Claude Code で考える</span>
          <span className="field-hint">次にやることがない Task について、手順と手間を考えます。Task の内容（通知の本文の抜粋など）を Claude に送ります</span>
        </span>
      </label>

      <div className="filter-grid">
        <label className="field" htmlFor={`${id}-include`}>
          <span className="field-label">含めるリポジトリ</span>
          <span className="field-hint">1 行に 1 つ。owner/repo か owner/*。空なら全部を含める</span>
        </label>
        <label className="field" htmlFor={`${id}-exclude`}>
          <span className="field-label">除くリポジトリ</span>
          <span className="field-hint">含めるリストより優先する</span>
        </label>
        <textarea id={`${id}-include`} rows={3} value={include} onChange={(event) => updateFilter(event.target.value, exclude)} placeholder="acme/*" />
        <textarea id={`${id}-exclude`} rows={3} value={exclude} onChange={(event) => updateFilter(include, event.target.value)} placeholder="acme/legacy" />
      </div>

      <label className="field">
        <span className="field-label">含まれるか確かめたい PR・issue・リポジトリ</span>
        <span className="field-hint">1 行に 1 つ。URL か owner/repo#番号</span>
        <textarea rows={1} value={targets} onChange={(event) => setTargets(event.target.value)} placeholder="https://github.com/acme/app/pull/42" />
      </label>
      <p className="preview-status" role="status">
        {previewing ? "判定しています" : previewProblem ?? ""}
      </p>
      {preview !== null && <FilterPreview preview={preview} />}

      <button type="button" className="dismiss-button account-remove" onClick={props.onRemove}>
        このアカウントを外す
      </button>
      </div>
    </details>
  );
}

const dateOf = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });

function TokenSummary({ summary }: { summary: GitHubTokenSummary }) {
  return (
    <div className="token-summary">
      <p>
        {summary.login} のトークン。権限: {summary.scopes.join(", ")}。有効期限: {summary.expiresAt === undefined ? "なし" : dateOf(summary.expiresAt)}
      </p>
      {summary.missingRecommendedScopes.includes("workflow") && (
        <p className="expiry-warning">
          workflow の権限がないため、.github/workflows を変える PR（GitHub Actions の更新など）は merge できません。`gh auth refresh -s
          workflow` で権限を足し、ここでトークンを保存し直してください。
        </p>
      )}
      {summary.expiryWarning && (
        <p className="expiry-warning" role="alert">
          {summary.expiryWarning.daysLeft === 0
            ? "有効期限が切れています。同期が止まるので、新しいトークンを貼り付けて保存してください。"
            : `あと ${summary.expiryWarning.daysLeft} 日で有効期限が切れます。新しいトークンを貼り付けて保存してください。`}
        </p>
      )}
    </div>
  );
}

const REASON_TEXT = (reason: FilterReason): string => {
  switch (reason.kind) {
    case "no_filter":
      return "フィルタなし";
    case "included_by":
      return `${reason.pattern} に一致`;
    case "not_in_include":
      return "含めるリストのどれにも一致しない";
    case "excluded_by":
      return `除くリストの ${reason.pattern} に一致`;
    case "not_excluded":
      return "除くリストに一致しない";
  }
};

const TARGET_KIND: Record<string, string> = { pull: "PR", issue: "issue", number: "番号", repository: "リポジトリ" };

function FilterPreview({ preview }: { preview: AccountFilterPreview }) {
  return (
    <div className="preview" aria-live="polite">
      {preview.targets.length > 0 && (
        <ul className="target-results">
          {preview.targets.map((check) => (
            <li key={check.input} className={`target-result ${check.decision === undefined ? "target-result--unknown" : check.decision.included ? "target-result--in" : "target-result--out"}`}>
              <span className="target-verdict">
                {check.decision === undefined ? "読み取れない" : check.decision.included ? "含まれる" : "除かれる"}
              </span>
              <span className="target-input">{check.input}</span>
              {check.target && check.decision && (
                <span className="target-reason">
                  {TARGET_KIND[check.target.kind]}（{check.target.repository}）: {REASON_TEXT(check.decision.reason)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* 除いたリポジトリは手元に届かないので、GitHub の一覧がないと「一致しない」を正しく判断できない */}
      {preview.remote.status === "loaded" && preview.unusedPatterns.length > 0 && (
        <p className="preview-warning">
          どのリポジトリにも一致しないパターン: {preview.unusedPatterns.join("、")}。打ち間違いがないか確かめてください。
        </p>
      )}
      <p className="preview-note">
        {preview.remote.status === "loaded"
          ? `GitHub で見られるリポジトリと、これまでに届いた項目のリポジトリで試しました${preview.remote.truncated ? "（多すぎるため一部だけ）" : ""}。`
          : `GitHub から一覧を取れなかったため、これまでに届いた項目のリポジトリだけで試しました（${preview.remote.message}）。`}
      </p>
      <div className="preview-columns">
        <RepositoryList title="含まれる" entries={preview.included} />
        <RepositoryList title="除かれる" entries={preview.excluded} />
      </div>
    </div>
  );
}

function RepositoryList(props: { title: string; entries: AccountFilterPreview["included"] }) {
  return (
    <div className="repository-list">
      <h5 className="repository-list-title">
        {props.title} <span className="count">{props.entries.length}</span>
      </h5>
      <ul>
        {props.entries.map((entry) => (
          <li key={entry.repository}>
            <span className="repository-name">{entry.repository}</span>
            <span className="repository-reason">{REASON_TEXT(entry.reason)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SlackAccountEditor(props: {
  account: SlackAccountDraft;
  secrets: Record<string, SecretStatus>;
  onChange: (next: SlackAccountDraft) => void;
  onRemove: () => void;
  onSecretChanged: () => Promise<unknown>;
  onConnected: () => Promise<void>;
}) {
  const { account } = props;
  const [open, setOpen] = useState(account.workspace === "");
  const [connecting, setConnecting] = useState(false);
  const connect = async () => {
    setConnecting(true);
    setCheck("開いたウィンドウで Slack にログインしてください（Google ではなく、メールアドレスと確認コードで）。ログインが済むと自動で閉じます");
    const result = await api.connectSlack(account.id, account.workspace);
    setConnecting(false);
    if ("error" in result) {
      setCheck(`取り込めませんでした: ${result.error}`);
      return;
    }
    await props.onConnected();
    const me = await api.testSlack(account.id);
    setCheck("error" in me ? `取り込みましたが、つながりません: ${me.error}` : `${me.team} の ${me.user} としてつながりました`);
  };
  const [check, setCheck] = useState<string | null>(null);
  const tokenStatus = props.secrets[`slack.${account.id}.token`] ?? "missing";
  const cookieStatus = props.secrets[`slack.${account.id}.cookie`] ?? "missing";
  const test = async () => {
    setCheck("確かめています");
    const result = await api.testSlack(account.id);
    setCheck("error" in result ? `つながりません: ${result.error}` : `${result.team} の ${result.user} としてつながりました`);
  };

  return (
    <details className="account" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="account-header">
        <h4 className="account-name">{account.id}</h4>
        <span className="field-hint">
          {account.workspace || "ワークスペース未設定"}・トークン: {SECRET_LABELS[tokenStatus]}・Cookie: {SECRET_LABELS[cookieStatus]}
        </span>
      </summary>
      <div className="account-body">
        <label className="field">
          <span className="field-label">ワークスペースのドメイン</span>
          <span className="field-hint">例: yutaura.slack.com。空のままでも、ログインしたワークスペースを使います</span>
          <input value={account.workspace} onChange={(event) => props.onChange({ ...account, workspace: event.target.value.trim() })} placeholder="yutaura.slack.com" />
        </label>
        <div className="request-review">
          <button type="button" className="primary-button" disabled={connecting} onClick={() => void connect()}>
            ブラウザでログインして取り込む
          </button>
          <span className="field-hint">
            {check ??
              "Slack のログイン画面を開き、ログインが済んだらセッションを読み取って保存します。このアプリ専用のログインになり、ほかのブラウザのログインには影響しません。Google でのログインはアプリの中では使えないので、メールアドレスと確認コードでログインしてください"}
          </span>
        </div>
        <details className="manual-secrets">
          <summary className="field-hint">手で入れる</summary>
        <label className="field">
          <span className="field-label">ブラウザの User-Agent</span>
          <span className="field-hint">
            トークンと Cookie を取ったブラウザで、開発者ツールのコンソールに navigator.userAgent と打って出た値をそのまま貼ります。違う値だと、Slack が全端末をログアウトさせることがあります
          </span>
          <textarea rows={2} value={account.userAgent} onChange={(event) => props.onChange({ ...account, userAgent: event.target.value.trim() })} />
        </label>
        <SecretField label="トークン（xoxc-）" secretKey={`slack.${account.id}.token`} status={tokenStatus} onChanged={props.onSecretChanged} />
        <SecretField label="Cookie の d（xoxd-）" secretKey={`slack.${account.id}.cookie`} status={cookieStatus} onChanged={props.onSecretChanged} />
        </details>
        <div className="request-review">
          <button type="button" className="quiet-button" onClick={() => void test()}>
            接続を確かめる
          </button>
        </div>
        <label className="checkbox judge-probabilities">
          <input type="checkbox" checked={account.planNextActions ?? false} onChange={(event) => props.onChange({ ...account, planNextActions: event.target.checked })} />
          <span>
            <span className="judge-option-label">次にやることを Claude Code で考える</span>
            <span className="field-hint">Task の内容（メッセージの 1 行目など）を Claude に送ります</span>
          </span>
        </label>
        <button type="button" className="dismiss-button account-remove" onClick={props.onRemove}>
          このワークスペースを外す
        </button>
      </div>
    </details>
  );
}

function MicrosoftAccountEditor(props: {
  account: MicrosoftAccountDraft;
  profiles: string[];
  secrets: Record<string, SecretStatus>;
  onChange: (next: MicrosoftAccountDraft) => void;
  onRemove: () => void;
  onSignedIn: () => Promise<unknown>;
}) {
  const { account } = props;
  const [open, setOpen] = useState(account.clientId === "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const tokenStatus = props.secrets[`microsoft.${account.id}.refresh_token`] ?? "missing";
  const signIn = async () => {
    setBusy(true);
    setMessage(null);
    const started = await api.startMicrosoftSignIn(account.id);
    if ("error" in started) {
      setBusy(false);
      setMessage(`サインインを始められませんでした: ${started.error}`);
      return;
    }
    setCode(started);
    const finished = await api.finishMicrosoftSignIn(account.id);
    setBusy(false);
    setCode(null);
    if ("error" in finished) {
      setMessage(`サインインできませんでした: ${finished.error}`);
      return;
    }
    await props.onSignedIn();
    setMessage(`${finished.user} としてサインインしました`);
  };
  const test = async () => {
    setMessage("確かめています");
    const result = await api.testMicrosoft(account.id);
    setMessage("error" in result ? `つながりません: ${result.error}` : `${result.user} としてつながりました`);
  };

  return (
    <details className="account" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="account-header">
        <h4 className="account-name">{account.id}</h4>
        <span className="field-hint">サインイン: {tokenStatus === "missing" ? "まだ" : "済み"}</span>
      </summary>
      <div className="account-body">
        <label className="field">
          <span className="field-label">テナント ID</span>
          <span className="field-hint">Entra ID の「概要」にあるディレクトリ（テナント）ID か、contoso.onmicrosoft.com の形のドメイン</span>
          <input value={account.tenantId} onChange={(event) => props.onChange({ ...account, tenantId: event.target.value.trim() })} />
        </label>
        <label className="field">
          <span className="field-label">アプリケーション（クライアント）ID</span>
          <input value={account.clientId} onChange={(event) => props.onChange({ ...account, clientId: event.target.value.trim() })} />
        </label>
        <label className="field">
          <span className="field-label">LLM Profile</span>
          <span className="field-hint">職場のデータを送ってよい LLM Profile を選んでください</span>
          <select value={account.llmProfile ?? ""} onChange={(event) => props.onChange({ ...account, llmProfile: event.target.value === "" ? undefined : event.target.value } as MicrosoftAccountDraft)}>
            <option value="">選んでください</option>
            {props.profiles.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-field">
          <input type="checkbox" checked={account.calendar === true} onChange={(event) => props.onChange({ ...account, calendar: event.target.checked })} />
          Outlook の予定を見る（出欠が未回答の招待・準備が要る予定・自分で入れた todo の予定を Task にします。準備が要るかの判定で、予定の名前と説明がこの LLM Profile に送られます）
        </label>
        <div className="request-review">
          <button type="button" className="primary-button" disabled={busy} onClick={() => void signIn()}>
            サインインする
          </button>
          <span className="field-hint">
            {code !== null
              ? `開いたブラウザ（${code.verificationUri}）で、コード ${code.userCode} を入れてサインインしてください`
              : (message ?? "設定を保存してから押してください。見る機能を変えたら、サインインし直してください")}
          </span>
        </div>
        <div className="request-review">
          <button type="button" className="quiet-button" onClick={() => void test()}>
            接続を確かめる
          </button>
        </div>
        <button type="button" className="dismiss-button account-remove" onClick={props.onRemove}>
          このアカウントを外す
        </button>
      </div>
    </details>
  );
}

function NotionAccountEditor(props: {
  account: NotionAccountDraft;
  secrets: Record<string, SecretStatus>;
  onChange: (next: NotionAccountDraft) => void;
  onRemove: () => void;
  onSecretChanged: () => Promise<unknown>;
  onConnected: () => Promise<void>;
}) {
  const { account } = props;
  const [open, setOpen] = useState(account.userId === "");
  const [connecting, setConnecting] = useState(false);
  const [check, setCheck] = useState<string | null>(null);
  const tokenStatus = props.secrets[`notion.${account.id}.token`] ?? "missing";
  const describe = (result: { user: string; spaces: string[] } | { error: string }) =>
    "error" in result ? `つながりません: ${result.error}` : `${result.user || "(名前なし)"} としてつながりました（ワークスペース: ${result.spaces.join("、") || "なし"}）`;
  const connect = async () => {
    setConnecting(true);
    setCheck("開いたウィンドウで Notion にログインしてください。ログインが済むと自動で閉じます");
    const result = await api.connectNotion(account.id);
    setConnecting(false);
    if ("error" in result) {
      setCheck(`取り込めませんでした: ${result.error}`);
      return;
    }
    await props.onConnected();
    setCheck(describe(await api.testNotion(account.id)));
  };
  const test = async () => {
    setCheck("確かめています");
    setCheck(describe(await api.testNotion(account.id)));
  };

  return (
    <details className="account" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="account-header">
        <h4 className="account-name">{account.id}</h4>
        <span className="field-hint">
          {account.userId === "" ? "未接続" : "接続済み"}・token_v2: {SECRET_LABELS[tokenStatus]}
        </span>
      </summary>
      <div className="account-body">
        <div className="request-review">
          <button type="button" className="primary-button" disabled={connecting} onClick={() => void connect()}>
            ブラウザでログインして取り込む
          </button>
          <span className="field-hint">
            {check ??
              "Notion のログイン画面を開き、ログインが済んだらセッションを読み取って保存します。このアプリ専用のログインになり、ほかのブラウザのログインには影響しません"}
          </span>
        </div>
        <details className="manual-secrets">
          <summary className="field-hint">手で入れる</summary>
          <label className="field">
            <span className="field-label">ユーザー ID</span>
            <span className="field-hint">Cookie の notion_user_id の値です</span>
            <input value={account.userId} onChange={(event) => props.onChange({ ...account, userId: event.target.value.trim() })} />
          </label>
          <label className="field">
            <span className="field-label">ブラウザの User-Agent</span>
            <span className="field-hint">token_v2 を取ったブラウザで、開発者ツールのコンソールに navigator.userAgent と打って出た値をそのまま貼ります</span>
            <textarea rows={2} value={account.userAgent} onChange={(event) => props.onChange({ ...account, userAgent: event.target.value.trim() })} />
          </label>
          <SecretField label="Cookie の token_v2" secretKey={`notion.${account.id}.token`} status={tokenStatus} onChanged={props.onSecretChanged} />
        </details>
        <div className="request-review">
          <button type="button" className="quiet-button" onClick={() => void test()}>
            接続を確かめる
          </button>
        </div>
        <button type="button" className="dismiss-button account-remove" onClick={props.onRemove}>
          このアカウントを外す
        </button>
      </div>
    </details>
  );
}

function AddAccount(props: { existing: string[]; onAdd: (id: string) => void; label?: string; placeholder?: string }) {
  const [id, setId] = useState("");
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(id) && !props.existing.includes(id);
  return (
    <form
      className="add-account"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        props.onAdd(id);
        setId("");
      }}
    >
      <label className="field">
        <span className="field-label">{props.label ?? "アカウントを追加"}</span>
        <span className="field-hint">名前は英小文字・数字・ハイフン（例: {props.placeholder ?? "work"}）</span>
        <input value={id} onChange={(event) => setId(event.target.value)} placeholder={props.placeholder ?? "work"} />
      </label>
      <button type="submit" className="quiet-button" disabled={!valid}>
        追加する
      </button>
    </form>
  );
}

const JUDGE_OPTIONS: { value: "none" | "anthropic" | "openai"; label: string; hint: string }[] = [
  { value: "none", label: "LLM を使わない", hint: "規則で決まらない通知は、すべて要確認に入ります。費用はかかりません" },
  { value: "anthropic", label: "Claude", hint: "通知ごとに Anthropic の API を呼びます" },
  { value: "openai", label: "OpenAI", hint: "通知ごとに OpenAI の API を呼びます" },
];

function JudgeEditor(props: {
  setting: JudgeSetting;
  onChange: (setting: JudgeSetting) => void;
  secrets: Record<string, SecretStatus>;
  onSecretChanged: () => Promise<unknown>;
}) {
  const { setting } = props;
  const name = useId();
  const models = MODEL_CHOICES[setting.provider];
  const known = JUDGE_OPTIONS.some((option) => option.value === setting.provider);
  const choose = (provider: JudgeSetting["provider"]) =>
    props.onChange({ ...setting, provider, model: MODEL_CHOICES[provider]?.[0]?.value ?? (provider === "none" ? "-" : "") });

  return (
    <div className="judge">
      <p className="field-hint">届いた通知が、自分の対応が要るものかを決める方法です。すべてのアカウントで使います。</p>
      <div className="judge-options">
        {JUDGE_OPTIONS.map((option) => (
          <label key={option.value} className={`judge-option${setting.provider === option.value ? " judge-option--selected" : ""}`}>
            <input type="radio" name={name} checked={setting.provider === option.value} onChange={() => choose(option.value)} />
            <span className="judge-option-label">{option.label}</span>
            <span className="field-hint">{option.hint}</span>
          </label>
        ))}
        {!known && <p className="field-hint">設定ファイルで {setting.provider} を指定しています。画面からは変えられません。</p>}
      </div>

      {setting.provider === "anthropic" && models && (
        <label className="field">
          <span className="field-label">モデル</span>
          <select value={setting.model} onChange={(event) => props.onChange({ ...setting, model: event.target.value })}>
            {models.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
            {!models.some((model) => model.value === setting.model) && <option value={setting.model}>{setting.model}</option>}
          </select>
        </label>
      )}
      {setting.provider === "openai" && (
        <label className="field">
          <span className="field-label">モデル</span>
          <input value={setting.model} placeholder="例: gpt-5.2" onChange={(event) => props.onChange({ ...setting, model: event.target.value })} />
        </label>
      )}
      {setting.provider === "anthropic" && (
        <SecretField label="Anthropic の API キー" secretKey="llm.anthropic.api_key" status={props.secrets["llm.anthropic.api_key"] ?? "missing"} onChanged={props.onSecretChanged} />
      )}

      {setting.provider !== "none" && (
        <label className="checkbox judge-probabilities">
          <input type="checkbox" checked={setting.probabilities} onChange={(event) => props.onChange({ ...setting, probabilities: event.target.checked })} />
          <span>
            <span className="judge-option-label">確率も出す</span>
            <span className="field-hint">
              OpenAI Decisions で「自分の対応が要る確率」を出し、カードに表示します。OpenAI の API キーが要ります
            </span>
          </span>
        </label>
      )}
      {(setting.provider === "openai" || setting.probabilities) && (
        <SecretField label="OpenAI の API キー" secretKey="llm.openai.api_key" status={props.secrets["llm.openai.api_key"] ?? "missing"} onChanged={props.onSecretChanged} />
      )}
    </div>
  );
}

function SecretField(props: { label: string; secretKey: string; status: SecretStatus; onChanged: () => Promise<unknown> }) {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const verifies = props.secretKey.startsWith("github.");

  const save = async () => {
    setSaving(true);
    setMessage(verifies ? "GitHub で確かめています" : null);
    try {
      const outcome = await api.setSecret(props.secretKey, value);
      if (outcome.ok) {
        setValue("");
        setMessage(outcome.detail === undefined ? "保存しました" : `${outcome.detail}。保存しました`);
      } else {
        // 失敗したときは入力を残す（打ち直さずに権限を直したトークンと見比べられるように）
        setMessage(`保存しませんでした: ${outcome.message}`);
      }
      await props.onChanged();
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    const outcome = await api.removeSecret(props.secretKey);
    setMessage(outcome.ok ? "削除しました" : `削除できませんでした: ${outcome.message}`);
    await props.onChanged();
  };

  return (
    <div className="secret-field">
      <label className="field-label" htmlFor={id}>
        {props.label}
      </label>
      <span className={`secret-status secret-status--${props.status}`}>{SECRET_LABELS[props.status]}</span>
      <input
        id={id}
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={props.status === "missing" ? "貼り付けて保存" : "新しい値で置き換える"}
      />
      <button type="button" className="quiet-button" disabled={value.trim() === "" || saving} onClick={() => void save()}>
        {verifies ? "確かめて保存" : "保存"}
      </button>
      {props.status === "saved" && (
        <button type="button" className="dismiss-button" onClick={() => void remove()}>
          削除
        </button>
      )}
      {message && (
        <span className="secret-message" role="status">
          {message}
        </span>
      )}
    </div>
  );
}

function GmailAccountEditor(props: { account: GmailAccountDraft; onChange: (next: GmailAccountDraft) => void; onRemove: () => void }) {
  const { account } = props;
  return (
    <details className="account">
      <summary className="account-header">
        <h4 className="account-name">{account.id}</h4>
      </summary>
      <label className="checkbox-field">
        <input type="checkbox" checked={account.planNextActions === true} onChange={(event) => props.onChange({ ...account, planNextActions: event.target.checked })} />
        人からのメールを Claude Code に読ませて Task にする（本文が Claude に送られます）
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={account.calendar === true} onChange={(event) => props.onChange({ ...account, calendar: event.target.checked })} />
        同じ Google アカウントの Calendar も見る（出欠が未回答の招待・準備が要る予定・自分で入れた todo の予定を Task にします。招待のメールは Calendar の側で扱います。準備が要るかの判定で、予定の名前と説明がこのアカウントの LLM に送られます）
      </label>
      <div className="step-actions">
        <button type="button" className="dismiss-button" onClick={props.onRemove}>
          このアカウントを外す
        </button>
      </div>
    </details>
  );
}

function RuleEditor(props: { rule: RuleDraft; onChange: (next: RuleDraft) => void; onRemove: () => void }) {
  const { rule } = props;
  const id = useId();
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "failed"; reason: string }>({ kind: "idle" });
  const interpret = async () => {
    if (rule.then.trim() === "" || isInterpreted(rule)) return;
    setState({ kind: "busy" });
    const result = await api.interpretRule(rule.then);
    if (result.ok) {
      props.onChange({ ...rule, actions: result.actions, interpretedFrom: rule.then });
      setState({ kind: "idle" });
    } else setState({ kind: "failed", reason: result.reason });
  };
  return (
    <fieldset className="gmail-rule">
      <legend className="gmail-rule-legend">
        <input aria-label="ルールの名前" value={rule.name} onChange={(event) => props.onChange({ ...rule, name: event.target.value })} />
        <label className="checkbox-field">
          <input type="checkbox" checked={rule.enabled !== false} onChange={(event) => props.onChange({ ...rule, enabled: event.target.checked })} />
          有効
        </label>
      </legend>
      <label className="field" htmlFor={`${id}-when`}>
        どういう時
        <textarea id={`${id}-when`} rows={2} value={rule.when} placeholder="請求書や領収書に関するメールが届いた時" onChange={(event) => props.onChange({ ...rule, when: event.target.value })} />
      </label>
      <label className="field" htmlFor={`${id}-then`}>
        何をする
        <textarea
          id={`${id}-then`}
          rows={2}
          value={rule.then}
          placeholder="レシート ラベルをつけて既読にする"
          onChange={(event) => props.onChange({ ...rule, then: event.target.value })}
          onBlur={() => void interpret()}
        />
      </label>
      <div className="step-actions">
        {isInterpreted(rule) ? (
          <p className="field-hint">読み取った操作: {describeActions(rule.actions)}</p>
        ) : (
          <button type="button" className="quiet-button" disabled={state.kind === "busy" || rule.then.trim() === ""} onClick={() => void interpret()}>
            {state.kind === "busy" ? "読み取っています…" : "何をするかを読み取る"}
          </button>
        )}
      </div>
      {state.kind === "failed" && <p className="problem">{state.reason}</p>}
      <ApplyToExisting rule={rule} />
      <button type="button" className="dismiss-button" onClick={props.onRemove}>
        このルールを消す
      </button>
    </fieldset>
  );
}

/** ルールを作る前に届いた、今あるものにも当てる。外部への書き込みなので、確かめてから実行する */
function ApplyToExisting({ rule }: { rule: RuleDraft }) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "confirm" } | { kind: "busy" } | { kind: "done"; applied: number; alreadyApplied: number; notMatched: number } | { kind: "failed"; reason: string }
  >({ kind: "idle" });
  const targets = existingTargetsOf(rule.actions);
  if (!isInterpreted(rule) || targets.length === 0) return null;
  const run = async () => {
    setState({ kind: "busy" });
    const result = await api.applyRuleToExisting(rule.id);
    setState(result.ok ? { kind: "done", applied: result.applied, alreadyApplied: result.alreadyApplied, notMatched: result.notMatched } : { kind: "failed", reason: result.reason });
  };
  return (
    <div className="step-actions">
      {state.kind === "confirm" ? (
        <>
          <span className="field-hint">
            {targets.join("・")}を「{rule.when.trim()}」で判定し、当てはまるものに {describeActions(rule.actions)}。保存したルールで行います
          </span>
          <button type="button" className="primary-button" onClick={() => void run()}>
            当てる
          </button>
          <button type="button" className="quiet-button" onClick={() => setState({ kind: "idle" })}>
            やめる
          </button>
        </>
      ) : (
        <button type="button" className="quiet-button" disabled={state.kind === "busy"} onClick={() => setState({ kind: "confirm" })}>
          {state.kind === "busy" ? "当てています…" : "今あるものにも当てる"}
        </button>
      )}
      {state.kind === "done" && (
        <span className="field-hint">
          新しく当てたもの {state.applied} 件・すでに当ててあるもの {state.alreadyApplied} 件・当てはまらなかったもの {state.notMatched} 件
        </span>
      )}
      {state.kind === "failed" && <span className="problem">{state.reason}</span>}
    </div>
  );
}
