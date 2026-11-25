import { useEffect, useRef, useState } from "react";
import type { MovableStatus, TaskDetail } from "../../shared/api.js";
import { api } from "./api.js";
import { conclusionLabel, describeChange, judgmentText, splitTitle, statusLabel } from "./task-text.js";

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
          <p className="drawer-status">{detail ? statusLabel(detail.status) : ""}</p>
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

            {detail.agentRun && <AgentRunSection run={detail.agentRun} />}

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

type ReviewResult = { conclusion?: string; impact?: string; requiredChanges?: string; blockers?: string; configChanges?: string };

function AgentRunSection({ run }: { run: NonNullable<TaskDetail["agentRun"]> }) {
  const review = (run.result ?? {}) as ReviewResult;
  return (
    <section className="drawer-section" aria-labelledby="drawer-agent">
      <h3 id="drawer-agent" className="drawer-section-title">
        AI の調査（依存更新の PR）
      </h3>
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
    </section>
  );
}

function ReviewField({ label, text }: { label: string; text: string | undefined }) {
  if (text === undefined || text.trim() === "") return null;
  return (
    <div className="review-field">
      <span className="field-label">{label}</span>
      <p className="review-text">{text}</p>
    </div>
  );
}
