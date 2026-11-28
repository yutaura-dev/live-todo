// @vitest-environment happy-dom
import { assert, describe, it } from "@effect/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach } from "vitest";
import type { BoardCard, Command, LiveTodoApi, Reply, TaskView } from "../shared/api.js";
import { App } from "./App.js";

afterEach(cleanup);

const view = (card: BoardCard): TaskView => ({
  id: card.id,
  title: card.title,
  brief: null,
  status: card.status,
  completion: "未定",
  closure: card.status === "終わった" ? { outcome: "done", reason: "自分で完了にした" } : null,
  due: null,
  mark: card.mark,
  priority: card.priority,
  history: [{ kind: "できた", by: "ユーザー", occurredAt: "2026-11-28T09:00:00.000Z", changes: [], cause: "手で足した" }],
  createdAt: "2026-11-28T09:00:00.000Z",
});

function fakeApi(cards: BoardCard[], reply?: (command: Command) => Reply<TaskView> | undefined) {
  const sent: Command[] = [];
  const api: LiveTodoApi = {
    command: async (command) => {
      sent.push(command);
      const custom = reply?.(command);
      if (custom) return custom;
      const card = cards.find((c) => "id" in command && c.id === command.id) ?? cards[0]!;
      return { ok: true, value: view(card) };
    },
    board: async () => ({ ok: true, value: cards }),
    task: async (id) => ({ ok: true, value: view(cards.find((card) => card.id === id)!) }),
    onChanged: () => () => {},
  };
  return { api, sent };
}

const cards: BoardCard[] = [
  { id: "t1", title: "請求書を送る", status: "やること", mark: "新着", due: "金曜まで", blocksOthers: false, priority: { status: "アプリが決めた", level: "3 日以内", reason: "期日まで 3 日" } },
  { id: "t2", title: "週報を書く", status: "終わった", mark: "なし", due: null, blocksOthers: false, priority: { status: "決めるのをやめた", level: null, reason: null } },
];

const openKanban = async () => fireEvent.click(await screen.findByRole("button", { name: "カンバン" }));

describe("見通し", () => {
  it("最初に見通しを出し、Task を優先度の段に並べる", async () => {
    render(<App api={fakeApi(cards).api} />);
    const band = await screen.findByRole("region", { name: /3 日以内/ });
    assert.isNotNull(within(band).getByRole("button", { name: /請求書を送る/ }));
  });

  it("ラベル未定の Task は、その場で優先度を決められる", async () => {
    const undecided: BoardCard = { ...cards[0]!, priority: { status: "ラベル未定", level: null, reason: null } };
    const { api, sent } = fakeApi([undecided]);
    render(<App api={api} />);
    const group = await screen.findByRole("group", { name: "「請求書を送る」にいつまでに手を付けるか" });
    fireEvent.click(within(group).getByRole("button", { name: "今日中" }));
    await waitFor(() => assert.deepStrictEqual(sent.at(-1), { _tag: "SetPriority", id: "t1", level: "今日中" }));
  });
});

describe("カンバン", () => {
  it("Task を列（Todo・完了待ち・完了）に分けて並べ、まだ見ていない Task に新着の印を付ける", async () => {
    render(<App api={fakeApi(cards).api} />);
    await openKanban();
    const todo = await screen.findByRole("region", { name: /Todo/ });
    assert.include(within(todo).getByText("請求書を送る").closest("li")?.textContent ?? "", "新着");
    assert.isNotNull(within(screen.getByRole("region", { name: /^完了\s*\d+$/ })).queryByText("週報を書く"));
  });

  it("「Task を足す」で題を書いて足すと、手で足した Task として送る", async () => {
    const { api, sent } = fakeApi(cards);
    render(<App api={api} />);
    await openKanban();
    fireEvent.click(await screen.findByRole("button", { name: "Task を足す" }));
    fireEvent.change(screen.getByLabelText("何をするか"), { target: { value: "  歯医者を予約する " } });
    fireEvent.click(screen.getByRole("button", { name: "足す" }));
    await waitFor(() => assert.deepStrictEqual(sent, [{ _tag: "CreateTask", title: "歯医者を予約する", brief: null }]));
  });

  it("題が空のままでは足せない", async () => {
    const { api, sent } = fakeApi(cards);
    render(<App api={api} />);
    await openKanban();
    fireEvent.click(await screen.findByRole("button", { name: "Task を足す" }));
    assert.isTrue((screen.getByRole("button", { name: "足す" }) as HTMLButtonElement).disabled);
    assert.deepStrictEqual(sent, []);
  });
});

describe("Task の詳細", () => {
  it("カードを開くと、見たことを送り、右に詳細を出す", async () => {
    const { api, sent } = fakeApi(cards);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /請求書を送る/ }));
    const panel = await screen.findByRole("complementary", { name: "Task の詳細" });
    assert.isNotNull(within(panel).getByRole("heading", { name: "請求書を送る" }));
    assert.deepStrictEqual(sent[0], { _tag: "ViewTask", id: "t1" });
  });

  it("やることの Task は「完了にする」で終えられる", async () => {
    const { api, sent } = fakeApi(cards);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /請求書を送る/ }));
    fireEvent.click(await screen.findByRole("button", { name: "完了にする" }));
    await waitFor(() => assert.deepStrictEqual(sent.at(-1), { _tag: "CompleteTask", id: "t1" }));
  });

  it("終わった Task には「やり直す」を出し、「完了にする」は出さない", async () => {
    render(<App api={fakeApi(cards).api} />);
    await openKanban();
    fireEvent.click(await screen.findByRole("button", { name: /週報を書く/ }));
    await screen.findByRole("button", { name: "やり直す" });
    assert.isNull(screen.queryByRole("button", { name: "完了にする" }));
  });

  it("断られたら、その理由を見せる", async () => {
    const { api } = fakeApi(cards, (command) => (command._tag === "CompleteTask" ? { ok: false, reason: "やること のときだけ" } : undefined));
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /請求書を送る/ }));
    fireEvent.click(await screen.findByRole("button", { name: "完了にする" }));
    assert.isNotNull(await screen.findByText("やること のときだけ"));
  });

  it("優先度を選ぶと、ユーザーが決めた優先度として送る", async () => {
    const { api, sent } = fakeApi(cards);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /請求書を送る/ }));
    const panel = await screen.findByRole("complementary", { name: "Task の詳細" });
    fireEvent.click(within(within(panel).getByRole("group", { name: "いつまでに手を付けるか" })).getByRole("button", { name: "今すぐ" }));
    await waitFor(() => assert.deepStrictEqual(sent.at(-1), { _tag: "SetPriority", id: "t1", level: "今すぐ" }));
  });

  it("期日を入れると、その日の終わりまでを期日として送る", async () => {
    const { api, sent } = fakeApi(cards);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /請求書を送る/ }));
    fireEvent.change(await screen.findByLabelText("期日"), { target: { value: "2026-12-04" } });
    await waitFor(() => assert.strictEqual(sent.at(-1)?._tag, "SetDue"));
    const due = (sent.at(-1) as Extract<Command, { _tag: "SetDue" }>).due;
    assert.deepStrictEqual({ text: due?.text, precision: due?.precision }, { text: "12 月 4 日まで", precision: "日" });
  });
});
