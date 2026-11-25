import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useCallback, useEffect, useState } from "react";
import type { Board, BoardCard, BoardColumnId, MovableStatus, SettingsSnapshot } from "../../shared/api.js";
import { api, isMock } from "./api.js";
import { Settings } from "./Settings.js";
import { TaskDrawer } from "./TaskDrawer.js";

const REFRESH_INTERVAL_MS = 15_000;
const UNDO_VISIBLE_MS = 8_000;

/** "タイトル（owner/repo）" をタイトルとリポジトリに分ける */
function splitTitle(title: string): { main: string; repository?: string } {
  const match = /^(.*)（([^（）\s]+\/[^（）\s]+)）$/.exec(title);
  return match ? { main: match[1]!, repository: match[2]! } : { main: title };
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

type View = "board" | "settings";
const viewFromHash = (): View => (window.location.hash === "#settings" ? "settings" : "board");

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [board, setBoard] = useState<Board | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [undo, setUndo] = useState<{ taskId: number; title: string; previous: MovableStatus } | null>(null);
  const [expiringTokens, setExpiringTokens] = useState<{ accountId: string; daysLeft: number }[]>([]);

  const load = useCallback(async () => {
    void api.settings().then((snapshot) => setExpiringTokens(expiringTokensOf(snapshot)));
    try {
      setBoard(await api.board());
      setLoadedAt(new Date().toISOString());
    } catch {
      setProblem("Task を読み込めませんでした。同期の設定を確かめてから、再読み込みしてください。");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  const move = useCallback(
    async (card: BoardCard, status: MovableStatus) => {
      if (card.status === status) return;
      // 先に画面を動かしてから保存する。保存に失敗したら読み込み直して元に戻す
      setBoard((current) => current && moveLocally(current, card.id, status));
      try {
        await api.moveTask(card.id, status);
        setProblem(null);
      } catch {
        setProblem(`「${splitTitle(card.title).main}」を動かせませんでした。もう一度試してください。`);
      }
      await load();
    },
    [load],
  );

  const remove = useCallback(
    async (card: { id: number; title: string; status: string }) => {
      const previous = card.status as MovableStatus;
      await move({ ...card, status: previous } as BoardCard, "dismissed");
      setUndo({ taskId: card.id, title: splitTitle(card.title).main, previous });
      if (openTaskId === card.id) setOpenTaskId(null);
    },
    [move, openTaskId],
  );

  useEffect(() => {
    if (undo === null) return;
    const timer = setTimeout(() => setUndo(null), UNDO_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const markSeen = useCallback(
    async (card: BoardCard) => {
      await api.markSeen(card.id);
      await load();
    },
    [load],
  );

  const open = useCallback(
    async (card: BoardCard) => {
      if (card.url === undefined) return;
      await api.openExternal(card.url);
      if (card.unreadChanges > 0) await markSeen(card);
    },
    [markSeen],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  const onDragEnd = (event: DragEndEvent) => {
    const card = event.active.data.current?.["card"] as BoardCard | undefined;
    const target = event.over?.id as BoardColumnId | undefined;
    if (card !== undefined && target !== undefined) void move(card, target);
  };

  return (
    <div className="app">
      <header className="masthead">
        <h1 className="wordmark">live-todo</h1>
        <nav className="views" aria-label="画面">
          <button type="button" className="view-tab" aria-current={view === "board" ? "page" : undefined} onClick={() => setView("board")}>
            カンバン
          </button>
          <button type="button" className="view-tab" aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")}>
            設定
          </button>
        </nav>
        <p className="sync-note">
          {isMock ? "見本のデータを表示しています" : loadedAt ? `${timeOf(loadedAt)} に読み込み` : "読み込んでいます"}
        </p>
        {view === "board" && (
          <button type="button" className="quiet-button" onClick={() => void load()}>
            再読み込み
          </button>
        )}
      </header>
      {view === "board" &&
        expiringTokens.map(({ accountId, daysLeft }) => (
          <p key={accountId} className="expiry-banner" role="alert">
            {daysLeft === 0 ? `${accountId} の GitHub トークンの有効期限が切れています。` : `${accountId} の GitHub トークンは、あと ${daysLeft} 日で有効期限が切れます。`}
            <button type="button" className="quiet-button" onClick={() => setView("settings")}>
              設定で新しいトークンを入れる
            </button>
          </p>
        ))}
      {problem && (
        <p className="problem" role="alert">
          {problem}
        </p>
      )}
      {view === "settings" && <Settings />}
      {view === "board" && board && (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <main className="board">
            {board.columns.map((column) => (
              <Column key={column.id} id={column.id} title={column.title} cards={column.cards}>
                {column.cards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    inTray={column.id === "needs_review"}
                    onMove={move}
                    onOpen={open}
                    onSeen={markSeen}
                    onShow={() => setOpenTaskId(card.id)}
                    onDelete={() => void remove(card)}
                  />
                ))}
              </Column>
            ))}
          </main>
        </DndContext>
      )}
      {openTaskId !== null && (
        <TaskDrawer
          taskId={openTaskId}
          revision={loadedAt}
          onClose={() => setOpenTaskId(null)}
          onMove={async (taskId, status) => {
            const card = board?.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
            if (card) await move(card, status);
          }}
          onDelete={async (taskId) => {
            const card = board?.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
            if (card) await remove(card);
          }}
        />
      )}
      {undo && (
        <div className="toast" role="status">
          「{undo.title}」を削除しました
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              void api.moveTask(undo.taskId, undo.previous).then(load);
              setUndo(null);
            }}
          >
            元に戻す
          </button>
        </div>
      )}
    </div>
  );
}

function expiringTokensOf(snapshot: SettingsSnapshot) {
  return Object.entries(snapshot.githubTokens).flatMap(([accountId, token]) =>
    token.expiryWarning === undefined ? [] : [{ accountId, daysLeft: token.expiryWarning.daysLeft }],
  );
}

function moveLocally(board: Board, taskId: number, status: MovableStatus): Board {
  const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
  if (card === undefined) return board;
  return {
    columns: board.columns.map((column) => ({
      ...column,
      cards: [
        ...(column.id === status ? [{ ...card, status }] : []),
        ...column.cards.filter((candidate) => candidate.id !== taskId),
      ],
    })),
  };
}

const EMPTY_MESSAGES: Record<BoardColumnId, string> = {
  needs_review: "仕分ける通知はありません。新しい通知は、同期のたびにここに入ります。",
  todo: "やることはありません。",
  in_progress: "手を付けている Task はありません。カードをここに移すと進行中になります。",
  done: "完了した Task はまだありません。",
};

function Column(props: { id: BoardColumnId; title: string; cards: readonly BoardCard[]; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: props.id });
  return (
    <section
      ref={setNodeRef}
      className={`column column--${props.id}${isOver ? " column--over" : ""}`}
      aria-label={`${props.title} ${props.cards.length} 件`}
    >
      <h2 className="column-title">
        {props.title}
        <span className="count">{props.cards.length}</span>
      </h2>
      <div className="column-body">
        {props.cards.length === 0 ? <p className="empty">{EMPTY_MESSAGES[props.id]}</p> : props.children}
      </div>
    </section>
  );
}

function Card(props: {
  card: BoardCard;
  inTray: boolean;
  onMove: (card: BoardCard, status: MovableStatus) => Promise<void>;
  onOpen: (card: BoardCard) => Promise<void>;
  onSeen: (card: BoardCard) => Promise<void>;
  onShow: () => void;
  onDelete: () => void;
}) {
  const { card, inTray } = props;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id, data: { card } });
  const { main, repository } = splitTitle(card.title);
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`card${inTray ? " card--tray" : ""}${card.unreadChanges > 0 ? " card--updated" : ""}${isDragging ? " card--dragging" : ""}`}
      {...attributes}
      {...listeners}
      aria-roledescription="動かせるカード"
      onClick={props.onShow}
    >
      {card.unreadChanges > 0 && (
        <button
          type="button"
          className="update-tab"
          onClick={(event) => {
            event.stopPropagation();
            void props.onSeen(card);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label={`${card.unreadChanges} 件の更新を既読にする`}
        >
          更新 {card.unreadChanges}
        </button>
      )}
      <h3 className="card-title">
        {/* キーボードでは Enter とスペースがドラッグの開始に使われるので、詳細はタイトルのボタンから開く */}
        <button
          type="button"
          className="card-title-button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onShow();
          }}
        >
          {main}
        </button>
      </h3>
      {repository && <p className="card-repository">{repository}</p>}
      {inTray && card.judgment && <Judgment judgment={card.judgment} />}
      <div className="card-actions" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        {inTray && (
          <>
            <button type="button" className="primary-button" onClick={() => void props.onMove(card, "todo")}>
              Todo にする
            </button>
            <button type="button" className="dismiss-button" onClick={() => void props.onMove(card, "dismissed")}>
              対象外にする
            </button>
          </>
        )}
        {!inTray && (
          <button type="button" className="delete-link" onClick={props.onDelete}>
            削除
          </button>
        )}
        {card.url && (
          <button type="button" className={inTray ? "quiet-button" : "open-link"} onClick={() => void props.onOpen(card)}>
            GitHub で開く
          </button>
        )}
      </div>
    </article>
  );
}

function Judgment({ judgment }: { judgment: NonNullable<BoardCard["judgment"]> }) {
  if (judgment.probability !== undefined) {
    const percent = Math.round(judgment.probability * 100);
    return (
      <div className="judgment">
        <span className="judgment-label">自分の対応が要る確率 {percent}%</span>
        <span className="meter" aria-hidden="true">
          <span className="meter-fill" style={{ inlineSize: `${percent}%` }} />
        </span>
      </div>
    );
  }
  if (judgment.reason !== undefined) return <blockquote className="judgment-reason">{judgment.reason}</blockquote>;
  return null;
}
