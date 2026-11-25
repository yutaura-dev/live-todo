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

  it("LLM を使わないなら、モデルは空でないダミーにする（設定ファイルの検証を通すため）", () => {
    const next = withJudgeSetting(config, { provider: "none", model: "", probabilities: false });

    assert.deepStrictEqual(next.llmProfiles["default"], { provider: "none", model: "-" });
  });
});
