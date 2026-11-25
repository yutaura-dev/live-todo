import type { ConfigDocument, LlmProvider } from "../../shared/api.js";

/** 画面で見せる判定の設定。設定ファイルの「プロファイル」は、アカウントごとに 1 つ持たせて画面には出さない */
export type JudgeSetting = { provider: LlmProvider; model: string; probabilities: boolean };

type Profile = ConfigDocument["llmProfiles"][string];

const DECISIONS = { provider: "openai", model: "gpt-6-luna" } as const;
// provider が none のときもモデルを空にできない（設定ファイルの検証で NonEmptyString を求めている）
const NO_MODEL = "-";

export const MODEL_CHOICES: Partial<Record<LlmProvider, { value: string; label: string }[]>> = {
  anthropic: [
    { value: "claude-haiku-5-5", label: "Haiku 5.5（速くて安い。まずはこれ）" },
    { value: "claude-sonnet-5-5", label: "Sonnet 5.5（判定の精度を上げたいとき）" },
    { value: "claude-opus-5-5", label: "Opus 5.5（高い。判定には過剰なことが多い）" },
  ],
};

// アカウント名と同じ名前にしない理由: 既定のプロファイルがアカウント名と同じ名前のことがあり、上書きしてしまうため
const profileNameOf = (accountId: string) => `account:${accountId}`;

export function judgeSettingOf(config: ConfigDocument, accountId: string): JudgeSetting {
  const account = config.accounts.find((candidate) => candidate.id === accountId);
  const profile = config.llmProfiles[account?.llmProfile ?? config.defaultLlmProfile];
  if (profile === undefined) return { provider: "none", model: NO_MODEL, probabilities: false };
  return { provider: profile.provider, model: profile.model, probabilities: profile.decisions !== undefined };
}

export function withJudgeSetting(config: ConfigDocument, accountId: string, setting: JudgeSetting): ConfigDocument {
  const name = profileNameOf(accountId);
  const profile: Profile = {
    provider: setting.provider,
    model: setting.provider === "none" || setting.model.trim() === "" ? NO_MODEL : setting.model.trim(),
    ...(setting.probabilities ? { decisions: { ...DECISIONS } } : {}),
  };
  const accounts = config.accounts.map((account) => (account.id === accountId ? { ...account, llmProfile: name } : account));
  const used = new Set([config.defaultLlmProfile, ...accounts.map((account) => account.llmProfile ?? config.defaultLlmProfile)]);
  const llmProfiles = Object.fromEntries(
    Object.entries({ ...config.llmProfiles, [name]: profile }).filter(([profileName]) => used.has(profileName)),
  );
  return { ...config, llmProfiles, accounts };
}
