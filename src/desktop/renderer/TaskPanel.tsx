import { Button, Icon, Pill, SourceMarks } from "../../design/components.js";
import type { PriorityLevel } from "../../llm/shared/vocabulary.js";
import type { DueDate } from "../../domain/values.js";
import type { Command, TaskView } from "../shared/api.js";
import { PlanView } from "./PlanView.js";
import { LEVELS } from "./horizon-groups.js";

export type PanelCommand =
  | { _tag: "CompleteTask" | "DismissTask" | "ReopenTask" | "DefineCompletion" | "ClearPriority" | "RevisePlan" }
  | { _tag: "PlanAction"; action: Extract<Command, { _tag: "PlanAction" }>["action"] }
  | { _tag: "SetPriority"; level: PriorityLevel }
  | { _tag: "SetDue"; due: DueDate | null };

const pad = (n: number) => String(n).padStart(2, "0");
const localDateOf = (iso: string) => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 日付だけを選ぶので、その日のうち（その地域の 0 時〜23 時 59 分）を期日にする */
export function dueOfDate(value: string): DueDate | null {
  if (value === "") return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return { text: `${m} 月 ${d} 日まで`, earliest: new Date(y, m - 1, d, 0, 0, 0).toISOString(), latest: new Date(y, m - 1, d, 23, 59, 59).toISOString(), precision: "日" };
}

const CLOSURE_LABELS = { done: "やり終えた", dismissed: "やらないことにした", merged: "別の Task にまとめた" } as const;

const timeOf = (iso: string) => new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Task の詳細。手で足した Task は計画を持たないので、完了条件と操作・履歴だけを見せる */
export function TaskPanel(props: { task: TaskView; problem: string | null; onCommand: (command: PanelCommand) => void; onRequestWrite?: (itemId: string) => void; onClose: () => void }) {
  const { task } = props;
  const open = task.status === "やること";
  return (
    <article className="ui-detail" aria-labelledby="detail-title">
      <header className="ui-detail-head">
        <div className="ui-detail-bar">
          <span className="ui-row">{task.closure ? <Pill tone="outline">{CLOSURE_LABELS[task.closure.outcome]}</Pill> : task.status !== "やること" && <Pill tone="outline">{task.status}</Pill>}</span>
          <Button tone="quiet" size="sm" className="ui-button--icon" onClick={props.onClose} aria-label="詳細を閉じる">
            <Icon name="close" />
          </Button>
        </div>
        <h2 id="detail-title" className="ui-detail-title">
          {task.title}
        </h2>
        {open && (
          <div className="ui-priority">
            <div className="ui-segmented" role="group" aria-label="いつまでに手を付けるか">
              {LEVELS.map((level) => (
                <button key={level} type="button" aria-pressed={task.priority.level === level} onClick={() => props.onCommand({ _tag: "SetPriority", level })}>
                  {level}
                </button>
              ))}
            </div>
            <p className="ui-sub">
              {task.priority.status === "ラベル未定"
                ? "アプリでは決められませんでした。選んでください"
                : task.priority.status === "未判定" && task.priority.level === null
                  ? "アプリが優先度を決めています"
                  : task.priority.reason}
              {task.priority.status === "ユーザーが決めた" && (
                <Button tone="quiet" size="sm" onClick={() => props.onCommand({ _tag: "ClearPriority" })}>
                  アプリに任せる
                </Button>
              )}
            </p>
          </div>
        )}
        {open ? (
          <label className="ui-field ui-due">
            期日
            <input type="date" className="ui-input" value={task.due ? localDateOf(task.due.earliest) : ""} onChange={(event) => props.onCommand({ _tag: "SetDue", due: dueOfDate(event.target.value) })} />
          </label>
        ) : (
          task.due && <p className="ui-due ui-sub">期日: {task.due.text}</p>
        )}
        <div className="ui-row">
          {open ? (
            <>
              <Button tone="primary" size="sm" onClick={() => props.onCommand({ _tag: "CompleteTask" })}>
                完了にする
              </Button>
              <Button tone="quiet" size="sm" onClick={() => props.onCommand({ _tag: "DismissTask" })}>
                やらないことにする
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => props.onCommand({ _tag: "ReopenTask" })}>
              やり直す
            </Button>
          )}
        </div>
        {props.problem && (
          <p className="ui-problem" role="alert">
            {props.problem}
          </p>
        )}
      </header>

      {task.brief && (
        <section className="ui-section" aria-labelledby="brief-title">
          <h3 id="brief-title" className="ui-section-title">
            今の状況
          </h3>
          <p>{task.brief}</p>
        </section>
      )}

      <PlanView rows={task.plan} open={open} onCommand={props.onCommand} {...(props.onRequestWrite ? { onRequestWrite: props.onRequestWrite } : {})} />

      {task.plan === null && (
      <section className="ui-section" aria-labelledby="completion-title">
        <h3 id="completion-title" className="ui-section-title">
          完了条件
        </h3>
        {task.completion === "未定" ? (
          <div className="ui-stack-4">
            <p className="ui-sub">まだ決めていません</p>
            {open && (
              <Button size="sm" tone="quiet" className="ui-self-start" onClick={() => props.onCommand({ _tag: "DefineCompletion" })}>
                やり終えたら自分で確かめる
              </Button>
            )}
          </div>
        ) : (
          <p>{task.completion === "満たした" ? "満たしました" : "やり終えたら、自分で確かめて完了にします"}</p>
        )}
      </section>
      )}

      {task.facts.length > 0 && (
        <section className="ui-section" aria-labelledby="facts-title">
          <h3 id="facts-title" className="ui-section-title">
            事実
          </h3>
          <ul className="ui-facts">
            {task.facts.map((fact) => (
              <li key={fact.id} className="ui-fact">
                <SourceMarks sources={[fact.source]} />
                <span className="ui-fact-text">
                  <span>{fact.title}</span>
                  <span className="ui-sub">{fact.lines.join("・")}</span>
                  {!fact.present && <span className="ui-sub">（元の項目は見えなくなりました）</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="ui-section" aria-labelledby="history-title">
        <h3 id="history-title" className="ui-section-title">
          履歴
        </h3>
        <ol className="ui-history">
          {[...task.history].reverse().map((activity, i) => (
            <li key={`${activity.occurredAt}-${i}`}>
              <span className="ui-history-by">{activity.by}</span>
              {activity.kind === "できた"
                ? `Task ができた（${activity.cause ?? ""}）`
                : activity.changes.map((change) => `${change.field}: ${change.before ?? "なし"} → ${change.after ?? "なし"}`).join("、")}
              <span className="ui-sub ui-num"> {timeOf(activity.occurredAt)}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
