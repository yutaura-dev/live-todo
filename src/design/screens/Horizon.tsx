import { useRef, useState, type CSSProperties, type RefObject } from "react";
import { awaitingDetail, decisionDetail, mergeDetail, undecidedDetail, waitingDetail, workingDetail, type TaskDetailData } from "../../wireframes/detail-fixtures.js";
import { tasks as sampleTasks, TODAY, writeRequests, writeTroubles } from "../../wireframes/fixtures.js";
import { attentionOf, densityOf, groupByHorizon, HORIZONS, type HorizonGroup } from "../../wireframes/horizon.js";
import type { Level, WireTask } from "../../wireframes/model.js";
import { AppShell, ScreenHead, type SyncView, type View } from "../AppShell.js";
import { AttentionPill, Button, Icon, Problem, Toast, WorkingPill } from "../components.js";
import { rulerOf } from "../ruler.js";
import { TaskDetail } from "./TaskDetail.js";

const DETAILS: TaskDetailData[] = [mergeDetail, decisionDetail, workingDetail, waitingDetail, undecidedDetail, awaitingDetail];

const detailOf = (task: WireTask): TaskDetailData =>
  DETAILS.find((detail) => detail.task.id === task.id) ?? {
    task,
    due: null,
    plan: null,
    facts: task.sources.filter((source) => source !== "manual").map((source) => ({ source, title: `${task.title} の元の項目`, lines: ["状態: 開いている"] })),
    effects: [],
    questions: [],
    history: [],
  };

export type MassRemoval = { account: string; stream: string; count: number };

export type HorizonProps = {
  tasks?: WireTask[];
  sync?: SyncView;
  massRemoval?: MassRemoval;
  openTaskId?: number;
  onNavigate?: (view: View) => void;
  onOpenWrite?: (taskId: number) => void;
};

const GROUP_TITLES: Partial<Record<HorizonGroup["level"], string>> = {
  ラベル未定: "いつまでに手を付けるか、決めてください",
  未判定: "アプリが優先度を決めています",
};

export function Horizon(props: HorizonProps) {
  const [list, setList] = useState(props.tasks ?? sampleTasks);
  const [openId, setOpenId] = useState<number | null>(props.openTaskId ?? null);
  const [focusPlan, setFocusPlan] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo: WireTask } | null>(null);
  const [dismissed, setDismissed] = useState<WireTask[]>([]);
  const addDialog = useRef<HTMLDialogElement>(null);
  const groups = groupByHorizon(list);
  const open = list.find((task) => task.id === openId);

  const dismiss = (task: WireTask) => {
    setList((current) => current.filter((candidate) => candidate.id !== task.id));
    setDismissed((current) => [task, ...current]);
    if (openId === task.id) setOpenId(null);
    setToast({ message: `「${task.title}」をやらないことにしました`, undo: task });
  };

  const setPriority = (task: WireTask, level: Level) => {
    setList((current) => current.map((candidate) => (candidate.id === task.id ? { ...candidate, priority: { status: "ユーザーが決めた", level, reason: "あなたが決めた" } } : candidate)));
    setToast({ message: `「${task.title}」を${level}にしました`, undo: task });
  };

  return (
    <AppShell
      current="見通し"
      {...(props.sync ? { sync: props.sync } : {})}
      {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}
      inspector={open ? <TaskDetail key={`${open.id}-${focusPlan}`} data={detailOf(open)} focusPlan={focusPlan} onClose={() => setOpenId(null)} /> : undefined}
    >
      <ScreenHead
        title={`${TODAY}の見通し`}
        actions={
          <Button onClick={() => addDialog.current?.showModal()}>
            <Icon name="plus" />
            Task を追加
          </Button>
        }
      />

      <div className="ui-notices">
        {props.sync?.state === "problem" && (
          <Problem
            title="取り込めていません"
            actions={
              <Button tone="primary" size="sm" onClick={() => props.onNavigate?.("設定")}>
                設定を開く
              </Button>
            }
          >
            <p>{props.sync.text}。この一覧は、そのときまでの内容です</p>
          </Problem>
        )}
        {props.massRemoval && (
          <div className="ui-notice" role="alert">
            <p>
              {props.massRemoval.account}の{props.massRemoval.stream}で、<span className="ui-num">{props.massRemoval.count}</span> 件が一度に消えました。まだ反映していません
            </p>
            <div className="ui-row">
              <Button tone="primary" size="sm">
                消えたことにする
              </Button>
              <Button size="sm">間違いなので反映しない</Button>
            </div>
          </div>
        )}
        <WriteNotice onNavigate={props.onNavigate} />
      </div>

      <div className="ui-horizon">
        {groups.map((group) => (
          <Band
            key={group.level}
            group={group}
            openId={openId}
            onOpen={(id, toPlan = false) => {
              setFocusPlan(toPlan);
              setOpenId(id);
            }}
            onWrite={(id) => (props.onOpenWrite ? props.onOpenWrite(id) : setOpenId(id))}
            onDismiss={dismiss}
            onSetPriority={setPriority}
          />
        ))}
      </div>

      {dismissed.length > 0 && (
        <details className="ui-disclosure ui-dismissed">
          <summary>
            <Icon name="chevron" />
            <span>最近やらないことにしたもの</span>
            <span className="ui-sub ui-num">{dismissed.length} 件</span>
          </summary>
          <ul className="ui-plain-list">
            {dismissed.map((task) => (
              <li key={task.id}>
                <span>{task.title}</span>
                <Button
                  tone="quiet"
                  size="sm"
                  onClick={() => {
                    setDismissed((current) => current.filter((candidate) => candidate.id !== task.id));
                    setList((current) => [...current, task]);
                  }}
                >
                  戻す
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <AddTaskDialog dialogRef={addDialog} />
      {toast && (
        <div className="ui-toasts" role="region" aria-label="お知らせ">
          <Toast
            message={toast.message}
            action={{
              label: "元に戻す",
              onClick: () => {
                const before = toast.undo;
                setDismissed((current) => current.filter((candidate) => candidate.id !== before.id));
                setList((current) => (current.some((candidate) => candidate.id === before.id) ? current.map((candidate) => (candidate.id === before.id ? before : candidate)) : [...current, before]));
                setToast(null);
              },
            }}
            onClose={() => setToast(null)}
          />
        </div>
      )}
    </AppShell>
  );
}

/** 外への書き込みは承認なしにはしないので、自分が動かないと止まる書き込みを最上段で知らせる */
function WriteNotice({ onNavigate }: { onNavigate?: ((view: View) => void) | undefined }) {
  const count = writeRequests.length + writeTroubles.length;
  if (count === 0) return null;
  return (
    <div className="ui-notice">
      <p>
        承認を待っている書き込みが <strong className="ui-num">{count}</strong> 件あります
        {writeTroubles.length > 0 && <span className="ui-sub">（うち {writeTroubles.length} 件は書き込めませんでした）</span>}
      </p>
      <Button tone="primary" size="sm" onClick={() => onNavigate?.("承認")}>
        承認を開く
      </Button>
    </div>
  );
}

type BandProps = {
  group: HorizonGroup;
  openId: number | null;
  onOpen: (id: number, toPlan?: boolean) => void;
  onWrite: (id: number) => void;
  onDismiss: (task: WireTask) => void;
  onSetPriority: (task: WireTask, level: Level) => void;
};

/**
 * 見通しの 1 段。左に「時の物差し」の目盛りを置き、右に Task を並べる。
 * 目盛りは近いほど大きく濃く、遠いほど小さく淡くする（--depth で決める）。
 */
function Band(props: BandProps) {
  const { group } = props;
  const density = densityOf(group.level);
  const ruler = rulerOf(group.level);
  const headingId = `ui-band-${group.level}`;
  const title = GROUP_TITLES[group.level];
  const style = { "--depth": ruler.depth } as CSSProperties;
  const className = `ui-band ui-band--${density} ui-band--${ruler.tone}`;
  const items = group.tasks.map((task) => (
    <li key={task.id}>
      <TaskItem task={task} density={density} undecided={group.level === "ラベル未定"} current={props.openId === task.id} {...props} />
    </li>
  ));

  const rulerCell = (
    <div className="ui-ruler">
      <h2 id={headingId} className="ui-ruler-label">
        {ruler.label}
      </h2>
      <span className="ui-ruler-count ui-num" aria-label={`${group.tasks.length} 件`}>
        {group.tasks.length}
      </span>
    </div>
  );

  if (density === "line") {
    return (
      <section className={className} style={style} aria-labelledby={headingId}>
        {rulerCell}
        <details className="ui-disclosure ui-band-fold">
          <summary>
            <Icon name="chevron" />
            <span className="ui-sub">
              {group.tasks.length} 件を{group.tasks.length > 3 ? "すべて" : ""}見る
            </span>
          </summary>
          <ul className="ui-titles">{items}</ul>
        </details>
      </section>
    );
  }

  return (
    <section className={className} style={style} aria-labelledby={headingId}>
      {rulerCell}
      <div className="ui-band-body">
        {title && <p className="ui-band-title">{title}</p>}
        {group.tasks.length === 0 ? (
          <p className="ui-band-empty">{group.level}に手を付けるものはありません</p>
        ) : (
          <ul className={density === "full" ? "ui-cards" : "ui-rows"}>{items}</ul>
        )}
      </div>
    </section>
  );
}

// 書き込みは押すと中身を確かめる画面へ行くので、「頼む」ではなく「確かめる」と書く（押した結果と名前をそろえる）
const NEXT_ACTION_LABELS = { human: "済んだ", claude: "Claude Code に頼む", write: "書き込みを確かめる", decision: "選ぶ", condition: null } as const;

type ItemResult = "済んだ" | "頼んだ";
type NowItem = WireTask["now"][number];

function TaskItem(props: BandProps & { task: WireTask; density: "full" | "row" | "line"; undecided: boolean; current: boolean }) {
  const { task, density } = props;
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  const working = task.work === "作業中";
  const failedWrite = writeTroubles.some((trouble) => trouble.taskId === task.id);
  const current = props.current ? "true" : undefined;

  const title = (
    <button type="button" className="ui-task-open" onClick={() => props.onOpen(task.id)}>
      {task.title}
    </button>
  );
  const marks = (
    <>
      <AttentionPill attention={attentionOf(task)} />
      {working && <WorkingPill />}
    </>
  );

  if (density === "line") {
    return (
      <div className="ui-title-item" aria-current={current}>
        {title}
      </div>
    );
  }

  if (props.undecided) {
    return (
      <div className="ui-card ui-card--decide" aria-current={current}>
        <div className="ui-card-head">
          {marks}
          {title}
        </div>
        {task.brief && <p className="ui-sub">{task.brief}</p>}
        <div className="ui-segmented" role="group" aria-label={`「${task.title}」にいつまでに手を付けるか`}>
          {HORIZONS.map((level) => (
            <button key={level} type="button" onClick={() => props.onSetPriority(task, level)}>
              {level}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const labelOf = (item: NowItem) => (item.how === "write" && failedWrite ? "書き込めなかった理由を見る" : NEXT_ACTION_LABELS[item.how]);
  const actOn = (item: NowItem) => {
    if (item.how === "write") return () => props.onWrite(task.id);
    if (item.how === "decision") return () => props.onOpen(task.id, true);
    if (item.how === "human") return () => setResults((all) => ({ ...all, [item.title]: "済んだ" }));
    if (item.how === "claude") return () => setResults((all) => ({ ...all, [item.title]: "頼んだ" }));
    return undefined;
  };
  const undo = (item: NowItem) =>
    setResults((all) => {
      const { [item.title]: _removed, ...rest } = all;
      return rest;
    });

  /** 押したあとの結果はその行に出す（お知らせは出さない）。済んだは戻せる */
  const actionOf = (item: NowItem, tone: "primary" | "secondary", size: "sm" | "md") => {
    const result = results[item.title];
    if (result === "済んだ")
      return (
        <span className="ui-row ui-result">
          <span className="ui-result-done">
            <Icon name="check" />
            済んだ
          </span>
          <Button tone="quiet" size="sm" onClick={() => undo(item)}>
            戻す
          </Button>
        </span>
      );
    if (result === "頼んだ") return <span className="ui-result ui-sub">Claude Code に頼みました（順番待ち 1 番目）</span>;
    if (item.working) return <span className="ui-result ui-seiji">Claude Code が作業中</span>;
    const label = labelOf(item);
    if (label === null) return <span className="ui-result ui-sub">見張っています</span>;
    return (
      <Button tone={item.how === "write" && failedWrite ? "secondary" : tone} size={size} onClick={actOn(item)}>
        {label}
      </Button>
    );
  };

  if (density === "row") {
    const single = task.now.length === 1 ? task.now[0] : undefined;
    return (
      <div className={`ui-row-item${working ? " ui-row-item--working" : ""}`} aria-current={current}>
        <div className="ui-row-item-text">
          <div className="ui-row-item-head">
            {marks}
            {title}
          </div>
          {task.now[0] && (
            <p className="ui-sub">
              {task.now[0].title}
              {task.now.length > 1 && <span className="ui-num">　ほか {task.now.length - 1} 件</span>}
            </p>
          )}
        </div>
        {single && <div className="ui-row-item-action">{actionOf(single, "secondary", "sm")}</div>}
      </div>
    );
  }

  const reason = task.priority?.status === "アプリが決めた" || task.priority?.status === "ユーザーが決めた" ? task.priority.reason : null;
  return (
    <article className={`ui-card${working ? " ui-card--working" : ""}`} aria-current={current} aria-label={task.title}>
      <div className="ui-card-head">
        {marks}
        {title}
        <Button tone="quiet" size="sm" className="ui-card-dismiss" onClick={() => props.onDismiss(task)}>
          やらないことにする
        </Button>
      </div>
      {reason && <p className="ui-reason">{reason}</p>}
      {task.drivenBy && task.priority && "level" in task.priority && (
        // 足した項目で上がった優先度は題からは分からないので、上げた項目を出す（ADR-0025）
        <p className="ui-driven">
          <span className="ui-driven-level">{task.priority.level}</span>
          {task.drivenBy}
        </p>
      )}
      {task.now.length > 0 && (
        <ul className="ui-now" aria-label="今できること">
          {task.now.map((item, index) => (
            <li key={item.title} className={results[item.title] === "済んだ" ? "ui-now-item ui-now-item--done" : "ui-now-item"}>
              <span className="ui-now-title">{item.title}</span>
              {actionOf(item, index === 0 ? "primary" : "secondary", "md")}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** Enter で送るのはフォームの暗黙の送信に任せ、自前の keydown を持たない（変換の確定の Enter では送られない） */
function AddTaskDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  return (
    <dialog ref={dialogRef} className="ui ui-dialog" aria-labelledby="ui-add-title" {...({ closedby: "any" } as object)}>
      <form method="dialog" className="ui-dialog-body">
        <h1 id="ui-add-title" className="ui-dialog-title">
          Task を追加
        </h1>
        <div className="ui-field">
          <label htmlFor="ui-add-name">何をするか</label>
          <input id="ui-add-name" className="ui-input" autoFocus placeholder="例: 年末調整の書類を出す" />
        </div>
        <div className="ui-field">
          <label htmlFor="ui-add-memo">メモ（なくてもよい）</label>
          <textarea id="ui-add-memo" className="ui-textarea" />
        </div>
        <p className="ui-sub">追加すると Todo に入り、AI が計画と優先度を考えます</p>
        <div className="ui-row ui-row--end">
          <Button type="submit" value="cancel" tone="quiet">
            やめる
          </Button>
          <Button tone="primary" type="submit" value="add">
            追加する
          </Button>
        </div>
      </form>
    </dialog>
  );
}
