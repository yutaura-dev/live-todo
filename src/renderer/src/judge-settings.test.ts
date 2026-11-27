import { assert, describe, it } from "@effect/vitest";
import type { ConfigDocument } from "../../shared/api.js";
import { hasAccountOverrides, judgeSettingOf, withJudgeSetting } from "./judge-settings.js";

const config: ConfigDocument = {
  llmProfiles: {
    personal: { provider: "none", model: "-" },
    "personal-llm": { provider: "anthropic", model: "claude-haiku-5-5" },
  },
  defaultLlmProfile: "personal",
  accounts: [
    { kind: "github", id: "personal", llmProfile: "personal-llm" },
    { kind: "github", id: "work" },
  ],
};

describe("judgeSettingOf", () => {
  it("既定のプロファイルから、PC 全体の判定の設定を読む", () => {
    assert.deepStrictEqual(judgeSettingOf(config), { provider: "none", model: "-", probabilities: false });
  });

  it("どのアカウントも同じプロファイルを指していれば、それを PC 全体の設定として読む（既定でなくても）", () => {
    const allSame: ConfigDocument = { ...config, accounts: [{ kind: "github", id: "personal", llmProfile: "personal-llm" }] };
    assert.deepStrictEqual(judgeSettingOf(allSame), { provider: "anthropic", model: "claude-haiku-5-5", probabilities: false });
  });

  it("Decisions を使うプロファイルなら、確率も出す設定として読む", () => {
    const withDecisions: ConfigDocument = {
      ...config,
      llmProfiles: { ...config.llmProfiles, personal: { provider: "anthropic", model: "claude-haiku-5-5", decisions: { provider: "openai" } } },
    };
    assert.isTrue(judgeSettingOf(withDecisions).probabilities);
  });
});

describe("judgeSettingOf（Azure OpenAI）", () => {
  it("Azure OpenAI のプロファイルなら、エンドポイントも読む", () => {
    const azure: ConfigDocument = {
      ...config,
      accounts: [],
      llmProfiles: { personal: { provider: "azure-openai", model: "my-gpt", azure: { endpoint: "https://acme.openai.azure.com" }, decisions: { provider: "azure-openai" } } },
    };

    assert.deepStrictEqual(judgeSettingOf(azure), { provider: "azure-openai", model: "my-gpt", azureEndpoint: "https://acme.openai.azure.com", probabilities: true });
  });
});

describe("hasAccountOverrides", () => {
  it("アカウントによって使うプロファイルが違えば true", () => {
    assert.isTrue(hasAccountOverrides(config));
  });

  it("どのアカウントも同じプロファイルを使っていれば false", () => {
    assert.isFalse(hasAccountOverrides({ ...config, accounts: [{ kind: "github", id: "work" }] }));
  });
});

describe("withJudgeSetting", () => {
  it("PC 全体のプロファイル 1 つに書き、すべてのアカウントがそれを使うようにする", () => {
    const next = withJudgeSetting(config, { provider: "anthropic", model: "claude-sonnet-5-5", probabilities: false });

    assert.deepStrictEqual(next.llmProfiles, { default: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    assert.strictEqual(next.defaultLlmProfile, "default");
    assert.isTrue(next.accounts.every((account) => account.llmProfile === undefined));
  });

  it("アカウントのほかの設定は変えない", () => {
    const withFilter: ConfigDocument = {
      ...config,
      accounts: [{ kind: "github", id: "work", initialLookbackDays: 7, repositories: { exclude: ["acme/legacy"] } }],
    };

    const next = withJudgeSetting(withFilter, { provider: "none", model: "", probabilities: false });

    assert.deepStrictEqual(next.accounts[0], { kind: "github", id: "work", initialLookbackDays: 7, repositories: { exclude: ["acme/legacy"] } });
  });

  it("確率も出すなら OpenAI Decisions を付け、出さないなら外す", () => {
    const on = withJudgeSetting(config, { provider: "anthropic", model: "claude-haiku-5-5", probabilities: true });
    assert.deepStrictEqual(on.llmProfiles["default"]?.decisions, { provider: "openai", model: "gpt-6-luna" });

    const off = withJudgeSetting(on, { provider: "anthropic", model: "claude-haiku-5-5", probabilities: false });
    assert.isUndefined(off.llmProfiles["default"]?.decisions);
  });

  it("Azure OpenAI なら、エンドポイントを書き、確率は同じ Azure のリソースの Microsoft-Decision で出す", () => {
    const next = withJudgeSetting(config, { provider: "azure-openai", model: "my-gpt", azureEndpoint: "https://acme.openai.azure.com", probabilities: true });

    assert.deepStrictEqual(next.llmProfiles["default"], {
      provider: "azure-openai",
      model: "my-gpt",
      azure: { endpoint: "https://acme.openai.azure.com" },
      decisions: { provider: "microsoft-decision", model: "Decision-1.1" },
    });
  });

  it("Azure ポータルからコピーした末尾のスラッシュは外して書く", () => {
    const next = withJudgeSetting(config, { provider: "azure-openai", model: "my-gpt", azureEndpoint: " https://acme.openai.azure.com/ ", probabilities: false });

    assert.deepStrictEqual(next.llmProfiles["default"]?.azure, { endpoint: "https://acme.openai.azure.com" });
  });

  it("Azure OpenAI をやめたら、エンドポイントは残さない", () => {
    const azure = withJudgeSetting(config, { provider: "azure-openai", model: "my-gpt", azureEndpoint: "https://acme.openai.azure.com", probabilities: false });

    const next = withJudgeSetting(azure, { provider: "anthropic", model: "claude-haiku-5-5", probabilities: false });

    assert.isUndefined(next.llmProfiles["default"]?.azure);
  });

  it("LLM を使わないなら、モデルは空でないダミーにする（設定ファイルの検証を通すため）", () => {
    const next = withJudgeSetting(config, { provider: "none", model: "", probabilities: false });

    assert.deepStrictEqual(next.llmProfiles["default"], { provider: "none", model: "-" });
  });
});
