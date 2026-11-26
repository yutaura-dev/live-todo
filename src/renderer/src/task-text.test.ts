import { assert, describe, it } from "@effect/vitest";
import { conclusionLabel, describeChange, effortLabel, judgmentText, openLabel, statusLabel, taskNumber, tracksGmail, tracksSlackSaved } from "./task-text.js";

const change = (overrides: Partial<Parameters<typeof describeChange>[0]>) => ({
  kind: "field_changed",
  field: null,
  before: null,
  after: null,
  actor: "sync",
  occurredAt: "2026-11-25T00:00:00.000Z",
  unread: false,
  ...overrides,
});

describe("describeChange", () => {
  it("ステータスの変更は、画面の列の名前で前後を書く", () => {
    assert.strictEqual(
      describeChange(change({ field: "status", before: "todo", after: "in_progress", actor: "user" })),
      "あなたが ステータスを「Todo」から「進行中」に変えた",
    );
  });

  it("タイトルの変更は前後の文字を書く", () => {
    assert.strictEqual(describeChange(change({ field: "title", before: "a", after: "b" })), "同期で タイトルを「a」から「b」に変えた");
  });

  it("作成と項目の追加は、種類だけを書く", () => {
    assert.strictEqual(describeChange(change({ kind: "created" })), "同期で 作られた");
    assert.strictEqual(describeChange(change({ kind: "link_added" })), "同期で 元の項目が追加された");
  });

  it("知らない項目の変更も、項目名をそのまま出して書く", () => {
    assert.strictEqual(describeChange(change({ field: "labels", before: null, after: "urgent" })), "同期で labelsを「（なし）」から「urgent」に変えた");
  });
});

describe("judgmentText", () => {
  it("規則で決まったものは、規則で決まったと書く", () => {
    assert.strictEqual(judgmentText({ method: "rule" }), "規則で決まった");
  });

  it("確率があれば、方法と確率を書く", () => {
    assert.strictEqual(judgmentText({ method: "decisions", probability: 0.704 }), "OpenAI Decisions・自分の対応が要る確率 70%");
  });

  it("理由があれば、方法と理由を書く", () => {
    assert.strictEqual(judgmentText({ method: "structured", reason: "本人へのレビュー依頼" }), "LLM・本人へのレビュー依頼");
  });

  it("知らない方法は、名前をそのまま出す", () => {
    assert.strictEqual(judgmentText({ method: "jev" }), "jev");
  });
});

describe("AI による変更", () => {
  it("AI が変えたことと、AI が調査中の状態を名前で書く", () => {
    assert.strictEqual(
      describeChange(change({ field: "status", before: "todo", after: "agent_running", actor: "agent" })),
      "AI が ステータスを「Todo」から「AI が調査中」に変えた",
    );
  });

  it("brief は「今の状況」として書く", () => {
    assert.strictEqual(describeChange(change({ field: "brief", before: null, after: "依存更新の調査: merge 可能", actor: "agent" })), "AI が 今の状況を「（なし）」から「依存更新の調査: merge 可能」に変えた");
  });
});

describe("conclusionLabel", () => {
  it("依存更新の調査の結論を、画面の言葉で返す", () => {
    assert.strictEqual(conclusionLabel("mergeable"), "merge 可能");
    assert.strictEqual(conclusionLabel("mergeable_after_fix"), "修正すれば merge 可能");
    assert.strictEqual(conclusionLabel("not_mergeable"), "merge できない");
  });
});

describe("effortLabel", () => {
  it("手間を、簡単・普通・難しい・めんどくさいで書く", () => {
    assert.deepStrictEqual(["easy", "normal", "hard", "tedious"].map(effortLabel), ["簡単", "普通", "難しい", "めんどくさい"]);
  });
});

describe("taskNumber", () => {
  it("Task の番号を GitHub の issue のように # を付けて書く", () => {
    assert.strictEqual(taskNumber(42), "#42");
  });
});

describe("statusLabel", () => {
  it("削除した Task と、元の項目が消えた Task も名前で返す", () => {
    assert.strictEqual(statusLabel("dismissed"), "削除済み");
    assert.strictEqual(statusLabel("archived"), "元の項目が消えた");
  });
});

describe("tracksGmail", () => {
  it("Gmail の送り主ごと・スレッドごとのまとまりを追う Task なら、ゴミ箱に入れる操作を出せる", () => {
    assert.isTrue(tracksGmail([{ role: "tracks", source: "gmail:mail:senders" }]));
    assert.isTrue(tracksGmail([{ role: "tracks", source: "gmail:mail:threads" }]));
    assert.isFalse(tracksGmail([{ role: "context", source: "gmail:mail:threads" }, { role: "tracks", source: "slack:home" }]));
  });
});

describe("openLabel の Gmail", () => {
  it("Gmail のリンクは「Gmail で開く」", () => {
    assert.strictEqual(openLabel("https://mail.google.com/mail/u/0/#all/abc"), "Gmail で開く");
  });
});

describe("tracksSlackSaved", () => {
  it("Slack の To-do・Saved を追う Task だけ true（メンション・DM から取り込んだ Task は、To-do の操作ができない）", () => {
    assert.isTrue(tracksSlackSaved([{ role: "tracks", source: "slack:home" }]));
    assert.isFalse(tracksSlackSaved([{ role: "tracks", source: "slack:home:inbox" }]));
    assert.isFalse(tracksSlackSaved([{ role: "context", source: "slack:home" }, { role: "tracks", source: "github:personal" }]));
  });
});

describe("openLabel", () => {
  it("元の項目の URL に合わせて、どこで開くかを出す", () => {
    assert.strictEqual(openLabel("https://github.com/acme/app/pull/1"), "GitHub で開く");
    assert.strictEqual(openLabel("https://yutaura.slack.com/archives/C1/p1"), "Slack で開く");
    assert.strictEqual(openLabel("https://example.com/x"), "開く");
  });
});
