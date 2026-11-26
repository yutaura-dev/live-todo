import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import { browserUserAgent, isSlackLoginUrl, teamSessionFrom, withSlackSession } from "./slack-session.js";

const localConfig = JSON.stringify({
  teams: {
    T001: { id: "T001", name: "Home", url: "https://yutaura.slack.com/", domain: "yutaura", token: "xoxc-home-token" },
    T002: { id: "T002", name: "Other", url: "https://other.slack.com/", domain: "other", token: "xoxc-other-token" },
  },
  lastActiveTeamId: "T002",
});

describe("teamSessionFrom", () => {
  it("Slack のページが持つ設定（localConfig_v2）から、指定したワークスペースのトークンを探す", () => {
    assert.deepStrictEqual(teamSessionFrom(localConfig, "yutaura.slack.com"), Option.some({ token: "xoxc-home-token", workspace: "yutaura.slack.com", team: "Home" }));
  });

  it("ワークスペースを決めていなければ、最後に開いていたワークスペースを使う", () => {
    assert.deepStrictEqual(teamSessionFrom(localConfig, ""), Option.some({ token: "xoxc-other-token", workspace: "other.slack.com", team: "Other" }));
  });

  it("まだログインしていない・形が違う・xoxc- でないトークンなら none", () => {
    assert.isTrue(Option.isNone(teamSessionFrom(null, "yutaura.slack.com")));
    assert.isTrue(Option.isNone(teamSessionFrom("not json", "yutaura.slack.com")));
    assert.isTrue(Option.isNone(teamSessionFrom(localConfig, "unknown.slack.com")));
    assert.isTrue(Option.isNone(teamSessionFrom(JSON.stringify({ teams: { T1: { url: "https://a.slack.com/", token: "xoxp-user" } } }), "a.slack.com")));
  });
});

describe("withSlackSession", () => {
  it("読み取ったワークスペースと User-Agent を、設定の Slack のアカウントに書く（ほかの項目と設定はそのまま）", () => {
    const document = {
      defaultLlmProfile: "default",
      accounts: [{ kind: "github", id: "personal" }],
      slackAccounts: [{ kind: "slack", id: "home", workspace: "", userAgent: "", planNextActions: true }],
    };

    assert.deepStrictEqual(withSlackSession(document, { id: "home", workspace: "yutaura.slack.com", userAgent: "UA" }), {
      ...document,
      slackAccounts: [{ kind: "slack", id: "home", workspace: "yutaura.slack.com", userAgent: "UA", planNextActions: true }],
    });
  });

  it("まだ設定にないアカウントなら足す", () => {
    assert.deepStrictEqual(withSlackSession({ accounts: [] }, { id: "home", workspace: "yutaura.slack.com", userAgent: "UA" }), {
      accounts: [],
      slackAccounts: [{ kind: "slack", id: "home", workspace: "yutaura.slack.com", userAgent: "UA" }],
    });
  });
});

describe("browserUserAgent", () => {
  it("Electron とアプリの名前を除いて、Chrome と同じ形にする（Slack が対応していないブラウザと判断しないように）", () => {
    const electron =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) live-todo/0.1.0 Chrome/140.0.7339.80 Electron/45.4.1 Safari/537.36";

    assert.strictEqual(
      browserUserAgent(electron),
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36",
    );
  });
});

describe("isSlackLoginUrl", () => {
  it.each(["https://slack.com/signin", "https://yutaura.slack.com/", "https://app.slack.com/client/T001"])("Slack のページはウィンドウの中で開く: %s", (url) => {
    assert.isTrue(isSlackLoginUrl(url));
  });

  it.each(["http://slack.com/signin", "https://slack.com.evil.example/", "file:///etc/passwd", "javascript:alert(1)"])("それ以外は開かない: %s", (url) => {
    assert.isFalse(isSlackLoginUrl(url));
  });
});
