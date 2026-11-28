import { useRef, useState, type RefObject } from "react";
import { awaitingDetail, decisionDetail, mergeDetail, undecidedDetail, waitingDetail, workingDetail, type TaskDetailData } from "../detail-fixtures.js";
import { tasks as sampleTasks, TODAY, writeRequests, writeTroubles } from "../fixtures.js";
import { attentionOf, densityOf, groupByHorizon, HORIZONS, type HorizonGroup } from "../horizon.js";
import type { Level, WireTask } from "../model.js";
import { AttentionMark, Button, Mark, Toast, WorkingMark } from "../parts.js";
import { AppFrame, ScreenHead, type SyncView, type View } from "./AppFrame.js";
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

/** 取り込みで一度に大量に消えた（specs/sync.spec.ts の「確かめている」） */
export type MassRemoval = { account: string; stream: string; count: number };

export type HorizonProps = {
  tasks?: WireTask[];
  sync?: SyncView;
  massRemoval?: MassRemoval;
  /** 最初から詳細を開いておく Task */
  openTaskId?: number;
  onNavigate?: (view: View) => void;
  /** 書き込みの次の一手から、承認の画面でその Task の書き込みを開く */
  onOpenWrite?: (taskId: number) => void;
};

const GROUP_TITLES: Partial<Record<HorizonGroup["level"], string>> = {
  ラベル未定: "優先度を決めてください",
  未判定: "優先度を決めています",
};

export function Horizon(props: HorizonProps) {
  const [list, setList] = useState(props.tasks ?? sampleTasks);
  const [openId, setOpenId] = useState<number | null>(props.openTaskId ?? null);
  const [focusPlan, setFocusPlan] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo: WireTask } | null>(null);
  // やらないことにした Task。お知らせを閉じたあとでも戻せるように、一覧の下に残す
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

  // ラベル未定の Task は、一覧の中で段を押せばその場で決まる（詳細を開かずに済む）
  const setPriority = (task: WireTask, level: Level) => {
    setList((current) => current.map((candidate) => (candidate.id === task.id ? { ...candidate, priority: { status: "ユーザーが決めた", level, reason: "あなたが決めた" } } : candidate)));
    setToast({ message: `「${task.title}」を${level}にしました`, undo: task });
  };

  return (
    <AppFrame
      current="見通し"
      {...(props.sync ? { sync: props.sync } : {})}
      {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}
      inspector={open ? <TaskDetail key={`${open.id}-${focusPlan}`} data={detailOf(open)} focusPlan={focusPlan} onClose={() => setOpenId(null)} /> : undefined}
    >
      <ScreenHead
        title={`${TODAY}の見通し`}
        actions={
          <>
            <Mark n={6} />
            <Button onClick={() => addDialog.current?.showModal()}>Task を追加</Button>
          </>
        }
      />

      {props.sync?.state === "problem" && (
        <div className="wf-box wf-box--error wf-banner" role="alert">
          <p>
            <span className="wf-error-text">⚠ 取り込めていません</span> {props.sync.text}。この一覧は、そのときまでの内容です
          </p>
          <div className="wf-button-row">
            <Button tone="primary" onClick={() => props.onNavigate?.("設定")}>
              設定を開く
            </Button>
          </div>
        </div>
      )}

      {props.massRemoval && (
        <div className="wf-box wf-box--mine wf-banner" role="alert">
          <p>
            {props.massRemoval.account}の{props.massRemoval.stream}で、{props.massRemoval.count} 件が一度に消えました。まだ反映していません
          </p>
          <div className="wf-button-row">
            <Button tone="primary">消えたことにする</Button>
            <Button>間違いなので反映しない</Button>
          </div>
        </div>
      )}

      <WriteBanner onNavigate={props.onNavigate} />

      {groups.map((group) => (
        <HorizonSection
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

      {dismissed.length > 0 && (
        <details className="wf-more">
          <summary>
            <span className="wf-section-title">最近やらないことにしたもの</span>
            <span className="wf-horizon-count">{dismissed.length} 件</span>
            <Mark n={7} />
          </summary>
          <ul className="wf-now-list" style={{ padding: "0 16px" }}>
            {dismissed.map((task) => (
              <li key={task.id}>
                <span>{task.title}</span>
                <Button
                  tone="quiet"
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
        <div className="wf-toasts" role="region" aria-label="お知らせ">
          <Toast
            message={toast.message}
            action={{
              label: "元に戻す",
              onClick: () => {
                // 同じ Task が一覧にあれば元の姿に置き換え（優先度を決めた）、なければ戻す（やらないことにした）
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
    </AppFrame>
  );
}

/** 自分が動かないと進まない書き込み。外への書き込みは承認なしにはしないので、ここで止まっていることを最上段で知らせる */
function WriteBanner({ onNavigate }: { onNavigate?: ((view: View) => void) | undefined }) {
  if (writeRequests.length === 0 && writeTroubles.length === 0) return null;
  return (
    <div className="wf-box wf-box--mine wf-approval-bar">
      <Mark n={1} />
      <p>承認を待っている書き込みが {writeRequests.length + writeTroubles.length} 件あります</p>
      <div className="wf-button-row">
        <Button tone="primary" onClick={() => onNavigate?.("承認")}>
          承認を開く
        </Button>
      </div>
    </div>
  );
}

function HorizonSection(props: {
  group: HorizonGroup;
  openId: number | null;
  onOpen: (id: number, toPlan?: boolean) => void;
  onWrite: (id: number) => void;
  onDismiss: (task: WireTask) => void;
  onSetPriority: (task: WireTask, level: Level) => void;
}) {
  const { group } = props;
  const density = densityOf(group.level);
  const headingId = `wf-horizon-${group.level}`;
  const title = GROUP_TITLES[group.level] ?? group.level;
  const items = group.tasks.map((task, index) => (
    <li key={task.id}>
      <TaskItem
        task={task}
        density={density}
        undecided={group.level === "ラベル未定"}
        firstFull={density === "full" && index === 0}
        current={props.openId === task.id}
        onOpen={(toPlan) => props.onOpen(task.id, toPlan)}
        onWrite={() => props.onWrite(task.id)}
        onDismiss={() => props.onDismiss(task)}
        onSetPriority={(level) => props.onSetPriority(task, level)}
      />
    </li>
  ));

  if (density === "line") {
    return (
      <section className="wf-horizon wf-horizon--line" aria-labelledby={headingId}>
        <details className="wf-more">
          <summary>
            <h2 id={headingId} className="wf-horizon-name">
              {title}
            </h2>
            <span className="wf-horizon-count">{group.tasks.length} 件</span>
            {group.level === "10 日以内" && <Mark n={5} />}
          </summary>
          <ul className="wf-more-body">{items}</ul>
        </details>
      </section>
    );
  }

  return (
    <section className={`wf-horizon wf-horizon--${density}${group.level === "ラベル未定" ? " wf-horizon--undecided" : ""}`} aria-labelledby={headingId}>
      <div className="wf-horizon-head">
        <h2 id={headingId} className="wf-horizon-name">
          {title}
        </h2>
        {group.level === "ラベル未定" && <Mark n={2} />}
        {group.level === "今すぐ" && <Mark n={3} />}
      </div>
      {group.tasks.length === 0 ? (
        <p className="wf-horizon-empty">{group.level}に手を付けるものはありません</p>
      ) : (
        <ul className="wf-stack" style={{ gap: density === "full" ? 12 : 8 }}>
          {items}
        </ul>
      )}
    </section>
  );
}

// 書き込みは押すと中身を確かめる画面へ行くので、「頼む」ではなく「確かめる」と書く（押した結果と名前をそろえる）
const NEXT_ACTION_LABELS = { human: "済んだ", claude: "Claude Code に頼む", write: "書き込みを確かめる", decision: "選ぶ", condition: null } as const;

/** 押したあとの、その場の結果（その行に出す。お知らせは出さない） */
type ItemResult = "済んだ" | "頼んだ";

/**
 * Task の 1 件。出すのは「何を（題）」「なぜ今か（理由）」「次に何をするか（次の一手と操作）」と、見る必要がある印（新着・更新・要確認・AI 作業中）だけ。
 * 取得元・AI の書いた状況・手間は、詳細を開けば見えるので一覧には出さない。
 */
function TaskItem(props: {
  task: WireTask;
  density: "full" | "row" | "line";
  undecided: boolean;
  firstFull: boolean;
  current: boolean;
  onOpen: (toPlan?: boolean) => void;
  onWrite: () => void;
  onDismiss: () => void;
  onSetPriority: (level: Level) => void;
}) {
  const { task, density } = props;
  const working = task.work === "作業中";
  const className = `wf-task wf-task--${density}${working ? " wf-task--working" : ""}`;
  const title = (
    <button type="button" className="wf-task-open" onClick={() => props.onOpen()}>
      <span className="wf-task-title">{task.title}</span>
    </button>
  );
  const marks = (
    <>
      <AttentionMark attention={attentionOf(task)} />
      {task.status === "needs_review" && <span className="wf-pill">要確認</span>}
      {working && <WorkingMark />}
    </>
  );

  if (density === "line") {
    return (
      <div className={className} aria-current={props.current ? "true" : undefined}>
        {title}
      </div>
    );
  }

  if (props.undecided) {
    return (
      <div className={className} aria-current={props.current ? "true" : undefined} style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        <div className="wf-stack" style={{ gap: 0 }}>
          <div className="wf-task-top">
            {marks}
            {title}
          </div>
          {task.now[0] && <p className="wf-sub">{task.now[0].title}</p>}
        </div>
        <div className="wf-button-row" role="group" aria-label={`「${task.title}」にいつまでに手を付けるか`}>
          {HORIZONS.map((level) => (
            <Button key={level} onClick={() => props.onSetPriority(level)}>
              {level}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  // 今日中・3 日以内の行でも、今できることが 1 つだけならその操作を出す（詳細を開かずに済む）。複数あるときは行が長くなるので、詳細で選ぶ
  const single = task.now.length === 1 ? task.now[0] : undefined;
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  // 書き込みが一度失敗している Task は、頼み直す前に理由を見る必要があるので、ボタンを理由の確認にする
  const failedWrite = writeTroubles.some((trouble) => trouble.taskId === task.id);
  const labelOf = (item: WireTask["now"][number]) => (item.how === "write" && failedWrite ? "書き込めなかった理由を見る" : NEXT_ACTION_LABELS[item.how]);
  const singleLabel = single && !single.working ? labelOf(single) : null;
  const actOn = (item: WireTask["now"][number]) => {
    if (item.how === "write") return props.onWrite;
    if (item.how === "decision") return () => props.onOpen(true);
    if (item.how === "human") return () => setResults((current) => ({ ...current, [item.title]: "済んだ" }));
    if (item.how === "claude") return () => setResults((current) => ({ ...current, [item.title]: "頼んだ" }));
    return undefined;
  };
  const undoResult = (item: WireTask["now"][number]) =>
    setResults((current) => {
      const { [item.title]: _removed, ...rest } = current;
      return rest;
    });
  const resultOf = (item: WireTask["now"][number]) => {
    const result = results[item.title];
    if (result === "済んだ")
      return (
        <span className="wf-button-row">
          <span className="wf-sub">✓ 済んだ</span>
          <Button tone="quiet" onClick={() => undoResult(item)}>
            戻す
          </Button>
        </span>
      );
    if (result === "頼んだ") return <span className="wf-sub">Claude Code に頼みました（順番待ち 1 番目）</span>;
    return null;
  };

  if (density === "row") {
    return (
      <div className={className} aria-current={props.current ? "true" : undefined}>
        <div className="wf-stack" style={{ gap: 0 }}>
          <div className="wf-task-top">
            {marks}
            {title}
          </div>
          {task.now[0] && (
            <p className="wf-sub">
              {task.now[0].title}
              {task.now.length > 1 && `　ほか ${task.now.length - 1} 件`}
            </p>
          )}
        </div>
        {single && (resultOf(single) ?? (singleLabel && <Button onClick={actOn(single)}>{singleLabel}</Button>))}
      </div>
    );
  }

  const reason = task.priority?.status === "アプリが決めた" || task.priority?.status === "ユーザーが決めた" ? task.priority.reason : null;
  return (
    <div className={className} aria-current={props.current ? "true" : undefined}>
      <div className="wf-task-top" style={{ justifyContent: "space-between" }}>
        <span className="wf-task-top">
          {marks}
          {title}
        </span>
        <Button tone="quiet" onClick={props.onDismiss}>
          やらないことにする
        </Button>
      </div>
      {reason && <p className="wf-sub">{reason}</p>}
      {task.now.length > 0 && (
        <ul className="wf-now-list" aria-label="今できること">
          {task.now.map((item, index) => {
            const label = labelOf(item);
            const result = resultOf(item);
            return (
              <li key={item.title}>
                <span className={results[item.title] === "済んだ" ? "wf-node-done" : undefined}>{item.title}</span>
                <span className="wf-button-row">
                  {props.firstFull && index === 0 && <Mark n={4} />}
                  {result ? (
                    result
                  ) : item.working ? (
                    <span className="wf-sub">Claude Code が作業中</span>
                  ) : label ? (
                    <Button tone="primary" onClick={actOn(item)}>
                      {label}
                    </Button>
                  ) : (
                    <span className="wf-sub">見張っています</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Task を手で追加するダイアログ（specs/task.spec.ts の triage: ユーザーが手で足すと todo になる）。
 * closedby="any" で外側を押しても閉じる（書きかけを失っても、題 1 行なので痛くない）。
 * Enter で送るのはフォームの暗黙の送信に任せ、自前の keydown を持たない（変換の確定の Enter では送られない）。
 */
function AddTaskDialog({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  return (
    <dialog ref={dialogRef} className="wf wf-dialog" aria-labelledby="wf-add-title" {...({ closedby: "any" } as object)}>
      <form method="dialog">
        <h1 id="wf-add-title">Task を追加</h1>
        <div className="wf-field">
          <label htmlFor="wf-add-name">何をするか</label>
          <input id="wf-add-name" autoFocus placeholder="例: 年末調整の書類を出す" />
        </div>
        <div className="wf-field">
          <label htmlFor="wf-add-memo">メモ（なくてもよい）</label>
          <textarea id="wf-add-memo" />
        </div>
        <div className="wf-button-row">
          <Button tone="primary" type="submit" value="add">
            追加する
          </Button>
          <Button type="submit" value="cancel">
            やめる
          </Button>
        </div>
      </form>
    </dialog>
  );
}

export const HORIZON_NOTES = [
  { n: 1, text: "外への書き込みは承認なしにはしないので、自分が動かないと止まる書き込みを最上段に 1 行で出す（頼むのを待っているもの・書き込めなかったものを合わせた件数）。押すと承認の画面へ" },
  { n: 2, text: "AI が優先度を決めきれなかった Task。後回しにせず今すぐの上に出し、自分で決めてもらう（迷ったら黙って決めず、人に回す）。段のボタンを押すとその場で決まり、そのまとまりへ移る（詳細を開かずに済む）。押し間違えたら、お知らせの「元に戻す」で戻せる" },
  { n: 3, text: "今すぐ・今日中は空でも見出しを残す。「今日やることはない」と分かること自体が、朝いちばんに知りたい答え" },
  { n: 4, text: "一覧に出すのは題・なぜ今か・今できることだけ。並列の計画で今できることが複数あれば、すべて並べてそれぞれに操作を付ける。取得元・AI が書いた状況・手間は詳細で見る。次の一手が何で果たされるかで、押せる操作が変わる（自分でやる → 済んだ、Claude Code → 頼む、書き込み → 承認の画面でその書き込みを開く、分かれ道 → 詳細を開いて分かれ道まで移る）。押したあとの結果（済んだ・頼んだ）はその行に出し、済んだは「戻す」で取り消せる。書き込みが一度失敗している Task は「書き込めなかった理由を見る」にする" },
  { n: 5, text: "10 日以内より先は題だけにして閉じておく。並びはアプリが決め、ドラッグでは動かさない（変えたいときは詳細で優先度を決めるか、期日を直す）" },
  { n: 6, text: "手で足した Task は Todo に入り、AI が計画と優先度を考える" },
  { n: 7, text: "やらないことにした Task は、お知らせを閉じたあとでも戻せるように、一覧の下に閉じて残す" },
];

export const HORIZON_QUESTIONS = [
  "まだ一度も優先度を決めていない Task の置き場は spec にない。仮にいちばん下に「優先度を決めています」として置いたが、それでよいか？",
  "spec の「ボードで今すぐの上に印を付けて出す」のボードは、この見通しのことか、カンバンのことか？",
];
