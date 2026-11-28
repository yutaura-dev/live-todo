import { useCallback, useEffect, useState } from "react";
import { AppShell, type View } from "../../design/AppShell.js";
import type { PriorityLevel } from "../../llm/shared/vocabulary.js";
import type { BoardCard, LiveTodoApi, TaskView } from "../shared/api.js";
import { AddTaskDialog } from "./AddTaskDialog.js";
import { Kanban } from "./Kanban.js";
import { Horizon } from "./Horizon.js";
import { type PanelCommand, TaskPanel } from "./TaskPanel.js";

/** 最初の縦の一本: 手で足した Task とカンバン。ほかの画面は、それぞれの一本で足す */
export function App({ api }: { api: LiveTodoApi }) {
  const [view, setView] = useState<View>("見通し");
  const [cards, setCards] = useState<ReadonlyArray<BoardCard>>([]);
  const [selected, setSelected] = useState<TaskView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    const board = await api.board();
    if (board.ok) setCards(board.value);
    else setProblem(board.reason);
  }, [api]);

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
      current={view}
      counts={{}}
      sync={{ state: "ok", text: "まだ取り込みはありません" }}
      onNavigate={setView}
      inspector={selected && <TaskPanel task={selected} problem={problem} onCommand={(command) => void run(command)} onClose={() => setSelected(null)} />}
    >
      {view === "見通し" ? (
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
