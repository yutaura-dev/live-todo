import { useCallback, useEffect, useState } from "react";
import { AppShell, type View } from "../../design/AppShell.js";
import type { BoardCard, LiveTodoApi, TaskView } from "../shared/api.js";
import { AddTaskDialog } from "./AddTaskDialog.js";
import { Kanban } from "./Kanban.js";
import { TaskPanel } from "./TaskPanel.js";

/** 最初の縦の一本: 手で足した Task とカンバン。ほかの画面は、それぞれの一本で足す */
export function App({ api }: { api: LiveTodoApi }) {
  const [view, setView] = useState<View>("カンバン");
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

  const run = async (tag: "CompleteTask" | "DismissTask" | "ReopenTask" | "DefineCompletion") => {
    if (!selected) return;
    const reply = await api.command({ _tag: tag, id: selected.id });
    if (reply.ok) {
      setProblem(null);
      setSelected(reply.value);
    } else setProblem(reply.reason);
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
      inspector={selected && <TaskPanel task={selected} problem={problem} onCommand={(tag) => void run(tag)} onClose={() => setSelected(null)} />}
    >
      {view === "カンバン" ? (
        <Kanban cards={cards} selectedId={selected?.id ?? null} onOpen={(id) => void open(id)} onAdd={() => setAdding(true)} />
      ) : (
        <p className="ui-empty">「{view}」はまだ作っていません</p>
      )}
      <AddTaskDialog open={adding} onClose={() => setAdding(false)} onSubmit={(input) => void add(input)} />
    </AppShell>
  );
}
