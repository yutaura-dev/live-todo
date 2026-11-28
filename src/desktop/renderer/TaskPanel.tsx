import { Button, Icon, Pill } from "../../design/components.js";
import type { TaskView } from "../shared/api.js";

const CLOSURE_LABELS = { done: "やり終えた", dismissed: "やらないことにした", merged: "別の Task にまとめた" } as const;

const timeOf = (iso: string) => new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Task の詳細。手で足した Task は計画を持たないので、完了条件と操作・履歴だけを見せる */
export function TaskPanel(props: { task: TaskView; problem: string | null; onCommand: (tag: "CompleteTask" | "DismissTask" | "ReopenTask" | "DefineCompletion") => void; onClose: () => void }) {
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
        {task.due && <p className="ui-due ui-sub">期日: {task.due.text}</p>}
        <div className="ui-row">
          {open ? (
            <>
              <Button tone="primary" size="sm" onClick={() => props.onCommand("CompleteTask")}>
                完了にする
              </Button>
              <Button tone="quiet" size="sm" onClick={() => props.onCommand("DismissTask")}>
                やらないことにする
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => props.onCommand("ReopenTask")}>
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

      <section className="ui-section" aria-labelledby="completion-title">
        <h3 id="completion-title" className="ui-section-title">
          完了条件
        </h3>
        {task.completion === "未定" ? (
          <div className="ui-stack-4">
            <p className="ui-sub">まだ決めていません</p>
            {open && (
              <Button size="sm" tone="quiet" className="ui-self-start" onClick={() => props.onCommand("DefineCompletion")}>
                やり終えたら自分で確かめる
              </Button>
            )}
          </div>
        ) : (
          <p>{task.completion === "満たした" ? "満たしました" : "やり終えたら、自分で確かめて完了にします"}</p>
        )}
      </section>

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
