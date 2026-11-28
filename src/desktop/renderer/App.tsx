import { useCallback, useEffect, useState } from "react";
import { AppShell, type View } from "../../design/AppShell.js";
import type { PriorityLevel } from "../../llm/shared/vocabulary.js";
import type { AiCommand, AiSettingsView, BoardCard, InboxCommand, InboxView, LiveTodoApi, TaskView } from "../shared/api.js";
import { Proposals } from "./Proposals.js";
import { AddTaskDialog } from "./AddTaskDialog.js";
import { Kanban } from "./Kanban.js";
import { Horizon } from "./Horizon.js";
import { Settings } from "./Settings.js";
import { type PanelCommand, TaskPanel } from "./TaskPanel.js";

/** 最初の縦の一本: 手で足した Task とカンバン。ほかの画面は、それぞれの一本で足す */
export function App({ api }: { api: LiveTodoApi }) {
  const [view, setView] = useState<View>("見通し");
  const [cards, setCards] = useState<ReadonlyArray<BoardCard>>([]);
  const [selected, setSelected] = useState<TaskView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [ai, setAi] = useState<AiSettingsView | null>(null);
  const [inbox, setInbox] = useState<InboxView>({ proposals: [], undecided: [], accounts: [] });
  const locked = ai !== null && ai.status !== "使える";

  useEffect(() => {
    void api.aiSettings().then((reply) => reply.ok && setAi(reply.value));
  }, [api]);

  const configureAi = async (command: AiCommand) => {
    const reply = await api.configureAi(command);
    if (!reply.ok) return reply.reason;
    setAi(reply.value);
    return null;
  };

  const reload = useCallback(async () => {
    const [board, current] = await Promise.all([api.board(), api.inbox()]);
    if (board.ok) setCards(board.value);
    else setProblem(board.reason);
    if (current.ok) setInbox(current.value);
  }, [api]);

  const sendInbox = async (command: InboxCommand) => {
    const reply = await api.inboxCommand(command);
    if (!reply.ok) return reply.reason;
    setInbox(reply.value);
    await reload();
    return null;
  };

  useEffect(() => {
    void reload();
    return api.onChanged(() => void reload());
  }, [api, reload]);

  const open = async (id: string) => {
    setProblem(null);
    const reply = await api.command({ _tag: "ViewTask", id });
    if (reply.ok) setSelected(reply.value);
    else setProblem(reply.reason);
  };

  const run = async (command: PanelCommand) => {
    if (!selected) return;
    const reply = await api.command({ ...command, id: selected.id });
    if (reply.ok) {
      setProblem(null);
      setSelected(reply.value);
    } else setProblem(reply.reason);
    await reload();
  };

  const setPriority = async (id: string, level: PriorityLevel) => {
    const reply = await api.command({ _tag: "SetPriority", id, level });
    if (!reply.ok) setProblem(reply.reason);
    else if (selected?.id === id) setSelected(reply.value);
    await reload();
  };

  const add = async (input: { title: string; brief: string | null }) => {
    const reply = await api.command({ _tag: "CreateTask", ...input });
    if (reply.ok) setAdding(false);
    else setProblem(reply.reason);
    await reload();
  };

  return (
    <AppShell
      current={locked ? "設定" : view}
      locked={locked}
      counts={{ 提案: inbox.proposals.filter((p) => p.status === "提案中").length + inbox.undecided.length }}
      sync={{ state: "ok", text: "まだ取り込みはありません" }}
      onNavigate={setView}
      inspector={selected && <TaskPanel task={selected} problem={problem} onCommand={(command) => void run(command)} onClose={() => setSelected(null)} />}
    >
      {ai === null ? null : locked || view === "設定" ? (
        <Settings settings={ai} onConfigure={configureAi} accounts={inbox.accounts} onInbox={sendInbox} />
      ) : view === "提案" ? (
        <Proposals inbox={inbox} openTasks={cards.filter((card) => card.status === "やること")} onCommand={(command) => void sendInbox(command)} />
      ) : view === "見通し" ? (
        <Horizon cards={cards} selectedId={selected?.id ?? null} onOpen={(id) => void open(id)} onAdd={() => setAdding(true)} onSetPriority={(id, level) => void setPriority(id, level)} />
      ) : view === "カンバン" ? (
        <Kanban cards={cards} selectedId={selected?.id ?? null} onOpen={(id) => void open(id)} onAdd={() => setAdding(true)} />
      ) : (
        <p className="ui-empty">「{view}」はまだ作っていません</p>
      )}
      <AddTaskDialog open={adding} onClose={() => setAdding(false)} onSubmit={(input) => void add(input)} />
    </AppShell>
  );
}
