import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestDatabase } from "../db/test-database.js";
import { SourceItemRepository } from "../source/source-item-repository.js";
import { dossierInput, dossierOf, loadDossier } from "./dossier.js";
import { TaskRepository } from "./task-repository.js";

const task = { id: 1, title: "PR をレビューする", brief: null, status: "todo" as const, recurringTaskId: null };
const item = {
  source: "github:work",
  title: "Add retry（acme/app）",
  url: "https://github.com/acme/app/pull/42",
  state: "open" as const,
  author: "alice",
  fact: null,
};

describe("dossierOf", () => {
  it("事実のある Item は、アプリが書いた情報と本文をそのまま使い、紐づき方を書き足す", () => {
    const dossier = dossierOf(task, [{ role: "tracks", item: { ...item, fact: { trusted: ["種類: GitHub の PullRequest"], body: "タイトル: Add retry" } } }]);

    assert.deepStrictEqual(dossier.facts[0], {
      source: "github:work",
      url: "https://github.com/acme/app/pull/42",
      state: "open",
      trusted: ["種類: GitHub の PullRequest", "紐づき方: この事実の完了が Task の完了を決める"],
      body: "タイトル: Add retry",
    });
  });

  it("事実を残していない Item は、Source の名前と作成者をアプリの情報、タイトルを本文の代わりにする", () => {
    const dossier = dossierOf(task, [{ role: "context", item }]);

    assert.deepStrictEqual(dossier.facts[0]?.trusted, ["Source: github:work", "作成者: @alice", "紐づき方: 関連する情報"]);
    assert.strictEqual(dossier.facts[0]?.body, "タイトル: Add retry（acme/app）");
  });

  it.each([
    [{ recurringTaskId: 3 }, [] as const, "定期の Task"],
    [{}, [] as const, "利用者が手で作った"],
    [{}, [{ role: "tracks" as const, item }], "届いた事実から作った"],
  ])("Task の作られ方を、アプリが書いた情報にする（%#）", (overrides, links, expected) => {
    const dossier = dossierOf({ ...task, ...overrides }, links);

    assert.include(dossier.trusted, `作られ方: ${expected}`);
  });

  it("Task の状態と、紐づく事実の数をアプリが書いた情報にする", () => {
    const dossier = dossierOf(task, [{ role: "tracks", item }]);

    assert.includeMembers([...dossier.trusted], ["状態: todo", "紐づく事実の数: 1"]);
  });
});

describe("dossierInput", () => {
  const dossier = dossierOf({ ...task, brief: "alice から依頼" }, [{ role: "tracks", item: { ...item, fact: { trusted: ["作成者: @alice"], body: "タイトル: Add retry" } } }]);

  it("内容を読む判定には、Task の title・brief と事実の本文を渡す", () => {
    const input = dossierInput(dossier, { text: true });

    assert.deepInclude(input.task, { title: "PR をレビューする", brief: "alice から依頼" });
    assert.strictEqual(input.facts[0]?.body, "タイトル: Add retry");
  });

  it("アプリの情報だけで答える判定には、外の人や AI が書いた文（title・brief・本文）を渡さない", () => {
    const input = dossierInput(dossier, { text: false });

    assert.notInclude(JSON.stringify(input), "Add retry");
    assert.notInclude(JSON.stringify(input), "alice から依頼");
    assert.notInclude(JSON.stringify(input), "PR をレビューする");
    assert.include(JSON.stringify(input), "作成者: @alice");
  });
});

describe("loadDossier", () => {
  it.effect("Task と、紐づく Item の事実を DB から読む", () =>
    Effect.gen(function* () {
      const items = yield* SourceItemRepository;
      const tasks = yield* TaskRepository;
      const saved = yield* items.upsertItem({ source: "github:work", externalId: "pr-42", title: "Add retry", url: "https://github.com/acme/app/pull/42", state: "open", fingerprint: "1", fact: { trusted: ["作成者: @alice"], body: "タイトル: Add retry" } });
      const created = yield* tasks.createTask({ title: "PR をレビューする", status: "todo" });
      yield* tasks.linkItem(created.id, saved.id, "tracks");

      const dossier = yield* loadDossier(created.id);

      assert.strictEqual(dossier?.title, "PR をレビューする");
      assert.deepStrictEqual(dossier?.facts.map((fact) => fact.body), ["タイトル: Add retry"]);
    }).pipe(Effect.provide(TestDatabase)));

  it.effect("ない Task は undefined", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* loadDossier(999));
    }).pipe(Effect.provide(TestDatabase)));
});
