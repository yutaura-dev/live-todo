import { assert, describe, it } from "@effect/vitest";
import type { ConfigDocument } from "../../shared/api.js";
import { judgeSettingOf, withJudgeSetting } from "./judge-settings.js";

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
  it("アカウントが指すプロファイルから、判定の設定を読む", () => {
    assert.deepStrictEqual(judgeSettingOf(config, "personal"), { provider: "anthropic", model: "claude-haiku-5-5", probabilities: false });
  });

  it("アカウントがプロファイルを指していなければ、既定のプロファイルを読む", () => {
    assert.deepStrictEqual(judgeSettingOf(config, "work"), { provider: "none", model: "-", probabilities: false });
  });

  it("Decisions を使うプロファイルなら、確率も出す設定として読む", () => {
    const withDecisions: ConfigDocument = {
      ...config,
      llmProfiles: { ...config.llmProfiles, "personal-llm": { provider: "anthropic", model: "claude-haiku-5-5", decisions: { provider: "openai" } } },
    };
    assert.isTrue(judgeSettingOf(withDecisions, "personal").probabilities);
  });
});

describe("withJudgeSetting", () => {
  it("アカウント専用のプロファイルに書き、アカウントをそれに向ける", () => {
    const next = withJudgeSetting(config, "work", { provider: "openai", model: "gpt-5.2", probabilities: false });

    assert.deepStrictEqual(next.llmProfiles["account:work"], { provider: "openai", model: "gpt-5.2" });
    assert.strictEqual(next.accounts[1]?.llmProfile, "account:work");
  });

  it("ほかのアカウントの設定と、既定のプロファイルは変えない", () => {
    const next = withJudgeSetting(config, "work", { provider: "openai", model: "gpt-5.2", probabilities: false });

    assert.strictEqual(next.accounts[0]?.llmProfile, "personal-llm");
    assert.deepStrictEqual(next.llmProfiles["personal-llm"], config.llmProfiles["personal-llm"]);
    assert.deepStrictEqual(next.llmProfiles["personal"], config.llmProfiles["personal"]);
    assert.strictEqual(next.defaultLlmProfile, "personal");
  });

  it("どのアカウントも使わなくなったプロファイルは消す（既定のプロファイルは残す）", () => {
    const next = withJudgeSetting(config, "personal", { provider: "anthropic", model: "claude-sonnet-5-5", probabilities: false });

    assert.deepStrictEqual(Object.keys(next.llmProfiles).sort(), ["account:personal", "personal"]);
  });

  it("確率も出すなら OpenAI Decisions を付け、出さないなら外す", () => {
    const on = withJudgeSetting(config, "personal", { provider: "anthropic", model: "claude-haiku-5-5", probabilities: true });
    assert.deepStrictEqual(on.llmProfiles["account:personal"]?.decisions, { provider: "openai", model: "gpt-6-luna" });

    const off = withJudgeSetting(on, "personal", { provider: "anthropic", model: "claude-haiku-5-5", probabilities: false });
    assert.isUndefined(off.llmProfiles["account:personal"]?.decisions);
  });

  it("LLM を使わないなら、モデルは空でないダミーにする（設定ファイルの検証を通すため）", () => {
    const next = withJudgeSetting(config, "personal", { provider: "none", model: "", probabilities: false });

    assert.deepStrictEqual(next.llmProfiles["account:personal"], { provider: "none", model: "-" });
  });
});
