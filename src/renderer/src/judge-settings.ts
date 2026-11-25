import type { ConfigDocument, LlmProvider } from "../../shared/api.js";

/** 画面で見せる判定の設定。当面は PC 全体で 1 つにし、設定ファイルの「プロファイル」は画面に出さない */
export type JudgeSetting = { provider: LlmProvider; model: string; probabilities: boolean };

type Profile = ConfigDocument["llmProfiles"][string];

const PROFILE_NAME = "default";
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

const profilesInUse = (config: ConfigDocument) =>
  new Set(config.accounts.map((account) => account.llmProfile ?? config.defaultLlmProfile));

/** アカウントによって使う LLM が違う（設定ファイルで個別に指定している） */
export const hasAccountOverrides = (config: ConfigDocument) => profilesInUse(config).size > 1;

export function judgeSettingOf(config: ConfigDocument): JudgeSetting {
  const inUse = [...profilesInUse(config)];
  const name = inUse.length === 1 ? inUse[0]! : config.defaultLlmProfile;
  const profile = config.llmProfiles[name];
  if (profile === undefined) return { provider: "none", model: NO_MODEL, probabilities: false };
  return { provider: profile.provider, model: profile.model, probabilities: profile.decisions !== undefined };
}

export function withJudgeSetting(config: ConfigDocument, setting: JudgeSetting): ConfigDocument {
  const profile: Profile = {
    provider: setting.provider,
    model: setting.provider === "none" || setting.model.trim() === "" ? NO_MODEL : setting.model.trim(),
    ...(setting.probabilities ? { decisions: { ...DECISIONS } } : {}),
  };
  return {
    ...config,
    llmProfiles: { [PROFILE_NAME]: profile },
    defaultLlmProfile: PROFILE_NAME,
    accounts: config.accounts.map(({ llmProfile: _perAccount, ...account }) => account),
  };
}
