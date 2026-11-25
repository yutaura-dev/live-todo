import { useCallback, useEffect, useId, useState } from "react";
import type {
  AccountFilterPreview,
  ConfigDocument,
  FilterReason,
  LlmProvider,
  SecretStatus,
  SettingsSnapshot,
} from "../../shared/api.js";
import { api } from "./api.js";

type Account = ConfigDocument["accounts"][number];

const EMPTY_CONFIG: ConfigDocument = {
  llmProfiles: { default: { provider: "none", model: "-" } },
  defaultLlmProfile: "default",
  accounts: [],
};

const PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: "none", label: "使わない（すべて要確認に入れる）" },
  { value: "anthropic", label: "Claude（Anthropic）" },
  { value: "openai", label: "OpenAI" },
];

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
              profiles={Object.keys(draft.llmProfiles)}
              defaultProfile={draft.defaultLlmProfile}
              tokenStatus={snapshot.secrets[`github.${account.id}.token`] ?? "missing"}
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

        <section className="settings-section" aria-labelledby="llm-heading">
          <h3 id="llm-heading" className="section-title">
            判定に使う LLM
          </h3>
          <LlmEditor draft={draft} onChange={setDraft} />
          <div className="secret-list">
            <SecretField label="Anthropic の API キー" secretKey="llm.anthropic.api_key" status={snapshot.secrets["llm.anthropic.api_key"] ?? "missing"} onChanged={reload} />
            <SecretField label="OpenAI の API キー" secretKey="llm.openai.api_key" status={snapshot.secrets["llm.openai.api_key"] ?? "missing"} onChanged={reload} />
          </div>
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
  profiles: string[];
  defaultProfile: string;
  tokenStatus: SecretStatus;
  onChange: (next: Account) => void;
  onRemove: () => void;
  onSecretChanged: () => Promise<unknown>;
}) {
  const { account } = props;
  const id = useId();
  const [include, setInclude] = useState((account.repositories?.include ?? []).join("\n"));
  const [exclude, setExclude] = useState((account.repositories?.exclude ?? []).join("\n"));
  const [targets, setTargets] = useState("");
  const [preview, setPreview] = useState<AccountFilterPreview | { error: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const filter = { include: lines(include), exclude: lines(exclude) };
  const commitFilter = () => props.onChange({ ...account, repositories: filter });

  const runPreview = async () => {
    commitFilter();
    setPreviewing(true);
    try {
      setPreview(await api.previewFilter({ accountId: account.id, filter, targets: lines(targets) }));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <article className="account">
      <header className="account-header">
        <h4 className="account-name">{account.id}</h4>
        <button type="button" className="dismiss-button" onClick={props.onRemove}>
          このアカウントを外す
        </button>
      </header>

      <SecretField label="トークン" secretKey={`github.${account.id}.token`} status={props.tokenStatus} onChanged={props.onSecretChanged} />

      <div className="field-row">
        <label className="field">
          <span className="field-label">判定に使う LLM</span>
          <select
            value={account.llmProfile ?? ""}
            onChange={(event) => {
              const { llmProfile: _omitted, ...rest } = account;
              props.onChange(event.target.value === "" ? rest : { ...rest, llmProfile: event.target.value });
            }}
          >
            <option value="">既定（{props.defaultProfile}）</option>
            {props.profiles.map((profile) => (
              <option key={profile} value={profile}>
                {profile}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">初回にさかのぼる日数</span>
          <input
            type="number"
            min={1}
            max={90}
            value={account.initialLookbackDays ?? 14}
            onChange={(event) => props.onChange({ ...account, initialLookbackDays: Number(event.target.value) })}
          />
        </label>
      </div>

      <div className="filter-grid">
        <label className="field" htmlFor={`${id}-include`}>
          <span className="field-label">含めるリポジトリ</span>
          <span className="field-hint">1 行に 1 つ。owner/repo か owner/*。空なら全部を含める</span>
        </label>
        <label className="field" htmlFor={`${id}-exclude`}>
          <span className="field-label">除くリポジトリ</span>
          <span className="field-hint">含めるリストより優先する</span>
        </label>
        <textarea id={`${id}-include`} rows={4} value={include} onChange={(event) => setInclude(event.target.value)} onBlur={commitFilter} placeholder="acme/*" />
        <textarea id={`${id}-exclude`} rows={4} value={exclude} onChange={(event) => setExclude(event.target.value)} onBlur={commitFilter} placeholder="acme/legacy" />
      </div>

      <label className="field">
        <span className="field-label">含まれるか確かめたい PR・issue・リポジトリ</span>
        <span className="field-hint">1 行に 1 つ。URL か owner/repo#番号</span>
        <textarea rows={2} value={targets} onChange={(event) => setTargets(event.target.value)} placeholder="https://github.com/acme/app/pull/42" />
      </label>
      <button type="button" className="quiet-button preview-button" onClick={() => void runPreview()} disabled={previewing}>
        {previewing ? "GitHub から一覧を取っています" : "このフィルタで試す"}
      </button>

      {preview !== null && <FilterPreview preview={preview} />}
    </article>
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

function FilterPreview({ preview }: { preview: AccountFilterPreview | { error: string } }) {
  if ("error" in preview) {
    return (
      <p className="problem" role="alert">
        試せませんでした: {preview.error}
      </p>
    );
  }
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

function AddAccount(props: { existing: string[]; onAdd: (id: string) => void }) {
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
        <span className="field-label">アカウントを追加</span>
        <span className="field-hint">名前は英小文字・数字・ハイフン（例: work）</span>
        <input value={id} onChange={(event) => setId(event.target.value)} placeholder="work" />
      </label>
      <button type="submit" className="quiet-button" disabled={!valid}>
        追加する
      </button>
    </form>
  );
}

function LlmEditor(props: { draft: ConfigDocument; onChange: (next: ConfigDocument) => void }) {
  const { draft } = props;
  const [newName, setNewName] = useState("");
  const setProfile = (name: string, profile: ConfigDocument["llmProfiles"][string]) =>
    props.onChange({ ...draft, llmProfiles: { ...draft.llmProfiles, [name]: profile } });

  return (
    <div className="llm-editor">
      <table className="profile-table">
        <thead>
          <tr>
            <th scope="col">名前</th>
            <th scope="col">プロバイダ</th>
            <th scope="col">モデル</th>
            <th scope="col">確率付きの判定（OpenAI Decisions）</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(draft.llmProfiles).map(([name, profile]) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>
                <select value={profile.provider} onChange={(event) => setProfile(name, { ...profile, provider: event.target.value as LlmProvider })}>
                  {PROVIDERS.map((provider) => (
                    <option key={provider.value} value={provider.value}>
                      {provider.label}
                    </option>
                  ))}
                  {!PROVIDERS.some((provider) => provider.value === profile.provider) && <option value={profile.provider}>{profile.provider}</option>}
                </select>
              </td>
              <td>
                <input value={profile.model} onChange={(event) => setProfile(name, { ...profile, model: event.target.value })} />
              </td>
              <td>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={profile.decisions !== undefined}
                    onChange={(event) => {
                      const { decisions: _omitted, ...rest } = profile;
                      setProfile(name, event.target.checked ? { ...rest, decisions: { provider: "openai", model: "gpt-6-luna" } } : rest);
                    }}
                  />
                  使う
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="field-row">
        <label className="field">
          <span className="field-label">既定の LLM</span>
          <select value={draft.defaultLlmProfile} onChange={(event) => props.onChange({ ...draft, defaultLlmProfile: event.target.value })}>
            {Object.keys(draft.llmProfiles).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <form
          className="add-account"
          onSubmit={(event) => {
            event.preventDefault();
            if (newName.trim() === "" || newName in draft.llmProfiles) return;
            setProfile(newName.trim(), { provider: "none", model: "-" });
            setNewName("");
          }}
        >
          <label className="field">
            <span className="field-label">LLM の設定を追加</span>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="work-llm" />
          </label>
          <button type="submit" className="quiet-button">
            追加する
          </button>
        </form>
      </div>
    </div>
  );
}

function SecretField(props: { label: string; secretKey: string; status: SecretStatus; onChanged: () => Promise<unknown> }) {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const id = useId();

  const save = async () => {
    const outcome = await api.setSecret(props.secretKey, value);
    setValue("");
    setMessage(outcome.ok ? "保存しました" : `保存できませんでした: ${outcome.message}`);
    await props.onChanged();
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
      <button type="button" className="quiet-button" disabled={value.trim() === ""} onClick={() => void save()}>
        保存
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
