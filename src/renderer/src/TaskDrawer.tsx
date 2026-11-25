import { useEffect, useRef, useState } from "react";
import type { MergePlanView, MovableStatus, TaskDetail } from "../../shared/api.js";
import { api } from "./api.js";
import { Markdown } from "./Markdown.js";
import { conclusionLabel, describeChange, judgmentText, splitTitle, statusLabel, taskNumber } from "./task-text.js";

const MOVABLE: MovableStatus[] = ["needs_review", "todo", "in_progress", "done"];

const dateTimeOf = (iso: string) =>
  new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function TaskDrawer(props: {
  taskId: number;
  /** 一覧の更新に合わせて読み直すための値（カンバンを読み込んだ時刻） */
  revision: string | null;
  onClose: () => void;
  onMove: (taskId: number, status: MovableStatus) => Promise<void>;
  onDelete: (taskId: number) => Promise<void>;
  /** merge などで Task が外から変わったあとに、カンバンを読み直す */
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    api
      .taskDetail(props.taskId)
      .then((next) => {
        if (!current) return;
        setDetail(next);
        setProblem(null);
        if (next.changes.some((change) => change.unread)) void api.markSeen(next.id);
      })
      .catch((error: unknown) => {
        if (!current) return;
        // 原因を推測で書かない（アプリの更新途中など、Task が消えた以外の理由でも失敗するため）
        const reason = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);
        setProblem(`この Task の詳細を読み込めませんでした: ${reason}`);
      });
    return () => {
      current = false;
    };
  }, [props.taskId, props.revision]);

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const title = detail ? splitTitle(detail.title) : null;

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" onClick={props.onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer-header">
          <p className="drawer-status">
            {detail ? (
              <>
                <span className="task-number">{taskNumber(detail.id)}</span> {statusLabel(detail.status)}
              </>
            ) : (
              ""
            )}
          </p>
          <button ref={closeButton} type="button" className="quiet-button" onClick={props.onClose}>
            閉じる
          </button>
        </header>
        {problem && <p className="problem">{problem}</p>}
        {detail && title && (
          <div className="drawer-body">
            <h2 id="drawer-title" className="drawer-title">
              {title.main}
            </h2>
            {title.repository && <p className="card-repository">{title.repository}</p>}

            <div className="drawer-actions">
              <label className="field">
                <span className="field-label">ステータス</span>
                <select
                  value={MOVABLE.includes(detail.status as MovableStatus) ? detail.status : ""}
                  onChange={(event) => void props.onMove(detail.id, event.target.value as MovableStatus)}
                >
                  {!MOVABLE.includes(detail.status as MovableStatus) && <option value="">{statusLabel(detail.status)}</option>}
                  {MOVABLE.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>
              {detail.status !== "dismissed" && (
                <button type="button" className="dismiss-button" onClick={() => void props.onDelete(detail.id)}>
                  削除
                </button>
              )}
            </div>

            {detail.brief && <p className="drawer-brief">{detail.brief}</p>}

            <NextAction detail={detail} onMerged={props.onChanged} />
            {detail.agentRun && <AgentRunSection run={detail.agentRun} taskId={detail.id} onRequested={props.onChanged} />}

            <section className="drawer-section" aria-labelledby="drawer-items">
              <h3 id="drawer-items" className="drawer-section-title">
                元の項目
              </h3>
              {detail.items.length === 0 ? (
                <p className="field-hint">手動で追加した Task です。</p>
              ) : (
                <ul className="drawer-items">
                  {detail.items.map((item) => (
                    <li key={item.url} className="drawer-item">
                      <div className="drawer-item-head">
                        <span className="drawer-item-title">{splitTitle(item.title).main}</span>
                        <button type="button" className="open-link" onClick={() => void api.openExternal(item.url)}>
                          開く
                        </button>
                      </div>
                      <span className="field-hint">
                        {item.role === "tracks" ? "完了を決める項目" : "関連する項目"}。{item.source}。{item.state === "open" ? "未解決" : "解決済み"}
                      </span>
                      {item.judgment && <span className="field-hint">判定: {judgmentText(item.judgment)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="drawer-section" aria-labelledby="drawer-history">
              <h3 id="drawer-history" className="drawer-section-title">
                変更の履歴
              </h3>
              <ol className="drawer-history">
                {detail.changes.map((change, index) => (
                  <li key={index} className={change.unread ? "drawer-change drawer-change--unread" : "drawer-change"}>
                    <time className="field-hint" dateTime={change.occurredAt}>
                      {dateTimeOf(change.occurredAt)}
                    </time>
                    <span>{describeChange(change)}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

type ReviewResult = {
  conclusion?: string;
  impact?: string;
  requiredChanges?: string;
  blockers?: string;
  configChanges?: string;
  canMergeAsIs?: boolean;
  mergeAsIsNote?: string;
};

function AgentRunSection({ run, taskId, onRequested }: { run: NonNullable<TaskDetail["agentRun"]>; taskId: number; onRequested: () => Promise<void> }) {
  const review = (run.result ?? {}) as ReviewResult;
  const idle = run.status === "succeeded" || run.status === "failed";
  return (
    <section className="drawer-section" aria-labelledby="drawer-agent">
      <h3 id="drawer-agent" className="drawer-section-title">
        AI の調査（依存更新の PR）
      </h3>
      {run.status === "queued" && <p className="field-hint">調査待ちです。順番が来たら Claude Code が調べます。</p>}
      {run.status === "running" && <p className="field-hint">Claude Code が調べています（{dateTimeOf(run.startedAt)} から）。</p>}
      {run.status === "failed" && <p className="problem">調べられませんでした: {run.error}</p>}
      {run.status === "succeeded" && (
        <div className="review">
          {review.conclusion && <p className={`review-conclusion review-conclusion--${review.conclusion}`}>{conclusionLabel(review.conclusion)}</p>}
          <ReviewField label="影響範囲" text={review.impact} />
          <ReviewField label="必要な修正" text={review.requiredChanges} />
          <ReviewField label="merge できない理由" text={review.blockers} />
          <ReviewField label="設定ファイルの直し方" text={review.configChanges} />
        </div>
      )}
      <p className="field-hint">
        {run.finishedAt && `${dateTimeOf(run.finishedAt)} に終了。`}
        {run.costUsd !== undefined && `費用 $${run.costUsd.toFixed(2)}。`}
        {run.sessionId && <>session: <code className="session-id">{run.sessionId}</code></>}
      </p>
      {idle && <RequestReviewButton taskId={taskId} onRequested={onRequested} />}
    </section>
  );
}

function ReviewField({ label, text }: { label: string; text: string | undefined }) {
  if (text === undefined || text.trim() === "") return null;
  return (
    <div className="review-field">
      <span className="field-label">{label}</span>
      <Markdown text={text} onOpenLink={(url) => void api.openExternal(url)} />
    </div>
  );
}

const METHOD_LABELS: Record<string, string> = { squash: "squash", merge: "merge commit", rebase: "rebase" };

/** Task の「次にやること」。依存更新の調査の結論から決める */
function NextAction({ detail, onMerged }: { detail: TaskDetail; onMerged: () => Promise<void> }) {
  const run = detail.agentRun;
  const review = (run?.status === "succeeded" ? (run.result ?? {}) : {}) as ReviewResult;
  const [plan, setPlan] = useState<MergePlanView | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "merged" } | { kind: "failed"; message: string }>({ kind: "idle" });

  if (detail.status === "done" || detail.status === "dismissed" || review.conclusion === undefined) return null;
  const canMerge = review.conclusion === "mergeable" || (review.conclusion === "mergeable_after_fix" && review.canMergeAsIs === true);
  const pullUrl = detail.items.find((item) => item.role === "tracks" && item.url.includes("/pull/"))?.url;

  const openConfirm = async () => {
    setState({ kind: "busy" });
    const result = await api.mergePlan(detail.id);
    if ("error" in result) setState({ kind: "failed", message: result.error });
    else {
      setPlan(result);
      setState({ kind: "idle" });
    }
  };
  const merge = async () => {
    if (plan === null) return;
    setState({ kind: "busy" });
    const outcome = await api.merge(detail.id, { method: plan.method, sha: plan.sha });
    if (outcome.ok) {
      setState({ kind: "merged" });
      setPlan(null);
      await onMerged();
    } else setState({ kind: "failed", message: outcome.message });
  };

  return (
    <section className="next-action" aria-labelledby="drawer-next">
      <h3 id="drawer-next" className="drawer-section-title">
        次にやること
      </h3>
      {review.conclusion === "mergeable" && <p className="next-action-text">PR を merge する（AI の調査で merge 可能と判定）</p>}
      {review.conclusion === "mergeable_after_fix" && (
        <>
          <p className="next-action-text">修正してから merge する。必要な修正は下の「AI の調査」を見てください</p>
          {review.canMergeAsIs && review.mergeAsIsNote && <p className="field-hint">条件によっては、修正せずにそのまま merge してもよい: {review.mergeAsIsNote}</p>}
        </>
      )}
      {canMerge && (
        <>
          {state.kind === "merged" ? (
            <p className="next-action-done">merge しました</p>
          ) : plan === null ? (
            <button type="button" className={review.conclusion === "mergeable" ? "primary-button" : "quiet-button"} disabled={state.kind === "busy"} onClick={() => void openConfirm()}>
              {review.conclusion === "mergeable" ? "merge する" : "そのまま merge する"}
            </button>
          ) : (
            <div className="merge-confirm" role="alertdialog" aria-labelledby="merge-confirm-title">
              <p id="merge-confirm-title" className="merge-confirm-title">
                {plan.repository} #{plan.number} を {METHOD_LABELS[plan.method]} で merge します
              </p>
              {review.conclusion === "mergeable_after_fix" && <p className="field-hint">修正せずに merge します。条件: {review.mergeAsIsNote}</p>}
              <p className="field-hint">方法の理由: {plan.reason}</p>
              <p className="field-hint">
                調べたときの commit（<code className="session-id">{plan.sha.slice(0, 7)}</code>）から PR が変わっていれば、GitHub が merge を断ります。
              </p>
              <div className="merge-confirm-actions">
                <button type="button" className="primary-button" disabled={state.kind === "busy"} onClick={() => void merge()}>
                  merge する
                </button>
                <button type="button" className="quiet-button" onClick={() => setPlan(null)}>
                  やめる
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {review.conclusion === "not_mergeable" && (
        <p className="next-action-text">merge しない。renovate / dependabot の設定を直すか、PR を閉じる。直し方は下の「AI の調査」を見てください</p>
      )}
      {state.kind === "failed" && (
        <>
          <p className="problem">merge できませんでした: {state.message}</p>
          {/commit が分からない|調べ直された/.test(state.message) && <RequestReviewButton taskId={detail.id} onRequested={onMerged} />}
          {/GitHub の画面/.test(state.message) && pullUrl && (
            <button type="button" className="quiet-button" onClick={() => void api.openExternal(pullUrl)}>
              GitHub で PR を開く
            </button>
          )}
        </>
      )}
    </section>
  );
}

function RequestReviewButton({ taskId, onRequested }: { taskId: number; onRequested: () => Promise<void> }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="request-review">
      <button
        type="button"
        className="quiet-button"
        onClick={() =>
          void api.requestReview(taskId).then(async (outcome) => {
            setMessage(outcome.ok ? "調査待ちに入れました。1 分以内に調べ始めます" : `調べ直せません: ${outcome.message}`);
            await onRequested();
          })
        }
      >
        もう一度調べる
      </button>
      {message && <span className="field-hint">{message}</span>}
    </div>
  );
}
