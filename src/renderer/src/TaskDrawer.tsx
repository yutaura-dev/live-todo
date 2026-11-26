import { useEffect, useRef, useState } from "react";
import type { ConflictResolutionView, MergePlanView, MovableStatus, Step, TaskDetail, WaitCondition } from "../../shared/api.js";
import { api } from "./api.js";
import { Markdown } from "./Markdown.js";
import { conclusionLabel, describeChange, effortLabel, judgmentText, splitTitle, statusLabel, taskNumber } from "./task-text.js";

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
  /** merge を始めたあとなど、ドロワーを閉じてカンバンで進み具合を見せたいとき */
  onStarted: () => Promise<void>;
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

            <NextAction detail={detail} onMerged={props.onChanged} onStarted={props.onStarted} />
            {detail.agentRun && <AgentRunSection run={detail.agentRun} problem={detail.agentRunProblem} taskId={detail.id} onRequested={props.onChanged} />}

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

function AgentRunSection({
  run,
  problem,
  taskId,
  onRequested,
}: {
  run: NonNullable<TaskDetail["agentRun"]>;
  problem: string | undefined;
  taskId: number;
  onRequested: () => Promise<void>;
}) {
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
      {problem && <p className="field-hint">このあとの調べ直しは失敗しました（{problem}）。下の結果は、その前に調べたものです。</p>}
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

/** Task の「次にやること」。手順の並びを表示し、いま着手できる手順を操作できるようにする */
function NextAction({ detail, onMerged, onStarted }: { detail: TaskDetail; onMerged: () => Promise<void>; onStarted: () => Promise<void> }) {
  const plan = detail.nextActions;
  if (plan === undefined || detail.status === "done" || detail.status === "dismissed") return null;
  const current = new Set(detail.currentStepIds ?? []);
  return (
    <section className="next-action" aria-labelledby="drawer-next">
      <h3 id="drawer-next" className="drawer-section-title">
        次にやること
      </h3>
      <StepList steps={plan.steps} current={current} detail={detail} onChanged={onMerged} onStarted={onStarted} />
    </section>
  );
}

function StepList(props: {
  steps: ReadonlyArray<Step>;
  current: Set<string>;
  detail: TaskDetail;
  onChanged: () => Promise<void>;
  onStarted: () => Promise<void>;
}) {
  return (
    <ol className="step-list">
      {props.steps.map((step, index) => (
        <StepItem key={step.id} step={step} parallel={index > 0 && step.mode === "parallel"} {...props} />
      ))}
    </ol>
  );
}

function waitHint(until: WaitCondition): string {
  switch (until.kind) {
    case "pull_request_opened":
      return `${until.repository} で「${until.query}」の PR が出たら、アプリが自動で済ませます`;
    case "review_submitted":
      return "レビューが付いたら、アプリが自動で済ませます";
    case "merged":
      return "merge されたら、アプリが自動で済ませます";
    case "included_in_pull_request":
      return `この PR が ${until.repository} の「${until.query}」の PR に入ったら、アプリが自動で済ませます`;
    case "workflow_succeeded":
      return `この PR を含む commit で ${until.workflow} が成功したら、アプリが自動で済ませます`;
    case "item_changed":
      return "元の項目に動き（コメント・レビューなど）があったら、アプリが自動で済ませます";
  }
}

function StepItem(props: {
  step: Step;
  parallel: boolean;
  current: Set<string>;
  detail: TaskDetail;
  onChanged: () => Promise<void>;
  onStarted: () => Promise<void>;
}) {
  const { step, detail } = props;
  const isCurrent = props.current.has(step.id);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (action: Promise<{ ok: true } | { ok: false; message: string }>) => {
    const outcome = await action;
    setProblem(outcome.ok ? null : outcome.message);
    await props.onChanged();
  };
  const chosen = step.kind === "decision" ? step.options.find((option) => option.key === step.chosen) : undefined;

  return (
    <li className={`step step--${step.status}${isCurrent ? " step--current" : ""}`}>
      <div className="step-head">
        {step.kind === "wait" ? (
          <span className="effort effort--wait">待ち</span>
        ) : (
          <span className={`effort effort--${step.effort}`}>{effortLabel(step.effort)}</span>
        )}
        <span className="step-title">{step.title}</span>
        {props.parallel && <span className="field-hint">前と並行してできる</span>}
        {step.status === "done" && (
          <>
            <span className="step-done">済み</span>
            <button type="button" className="open-link" onClick={() => void run(api.reopenStep(detail.id, step.id))}>
              戻す
            </button>
          </>
        )}
      </div>
      {isCurrent && step.kind === "merge_pull_request" && <MergeFlow detail={detail} onMerged={props.onChanged} onStarted={props.onStarted} />}
      {isCurrent && step.kind === "resolve_conflicts" && (
        <div className="step-actions">
          <span className="field-hint">PR のブランチにベースを merge し、Claude Code がコンフリクトしたファイルだけを直します。push は確かめてからです</span>
          <button
            type="button"
            className="primary-button"
            onClick={() =>
              void api.resolveConflicts(detail.id).then(async (outcome) => {
                if (outcome.ok) await props.onStarted();
                else setProblem(outcome.message);
              })
            }
          >
            コンフリクトを直す
          </button>
        </div>
      )}
      {isCurrent && step.kind === "push_conflict_resolution" && <ConflictPushFlow taskId={detail.id} onPushed={props.onChanged} />}
      {isCurrent && step.kind === "decision" && (
        <div className="step-actions">
          {step.options.map((option) => (
            <button key={option.key} type="button" className="quiet-button" onClick={() => void run(api.chooseOption(detail.id, step.id, option.key))}>
              {option.label}
            </button>
          ))}
        </div>
      )}
      {isCurrent && step.kind === "wait" && (
        <div className="step-actions">
          <span className="field-hint">{waitHint(step.until ?? { kind: "item_changed" })}</span>
        </div>
      )}
      {isCurrent && (step.kind === "manual" || step.kind === "fix_and_push") && (
        <div className="step-actions">
          {step.kind === "fix_and_push" && <span className="field-hint">アプリからの修正はまだできません。修正して push したら「済んだ」を押してください</span>}
          <button type="button" className="quiet-button" onClick={() => void run(api.completeStep(detail.id, step.id))}>
            済んだ
          </button>
        </div>
      )}
      {problem && <p className="problem">{problem}</p>}
      {chosen && (
        <div className="step-branch">
          <span className="field-hint">選んだ: {chosen.label}</span>
          <StepList steps={chosen.steps} current={props.current} detail={detail} onChanged={props.onChanged} onStarted={props.onStarted} />
        </div>
      )}
    </li>
  );
}

/** merge の確認と実行。確認で承認した方法と commit だけで merge する */
function MergeFlow({ detail, onMerged, onStarted }: { detail: TaskDetail; onMerged: () => Promise<void>; onStarted: () => Promise<void> }) {
  const [plan, setPlan] = useState<MergePlanView | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "merged" } | { kind: "failed"; message: string }>({ kind: "idle" });
  const review = (detail.agentRun?.status === "succeeded" ? (detail.agentRun.result ?? {}) : {}) as ReviewResult;
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
    // 始められたらドロワーを閉じ、処理中のレーンで merge の進み具合を見せる
    if (outcome.ok) await onStarted();
    else setState({ kind: "failed", message: outcome.message });
  };

  return (
    <div className="step-actions step-actions--column">
      {state.kind === "merged" ? (
        <p className="next-action-done">merge しました</p>
      ) : plan === null ? (
        <button type="button" className="primary-button" disabled={state.kind === "busy"} onClick={() => void openConfirm()}>
          merge する
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
    </div>
  );
}

/** Claude Code が直した内容を見せ、承認されたら PR のブランチに push する */
function ConflictPushFlow({ taskId, onPushed }: { taskId: number; onPushed: () => Promise<void> }) {
  const [view, setView] = useState<ConflictResolutionView | { error: string } | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "failed"; message: string }>({ kind: "idle" });
  useEffect(() => {
    void api.conflictResolution(taskId).then(setView);
  }, [taskId]);

  if (view === null) return <p className="field-hint">直した内容を読み込んでいます</p>;
  if ("error" in view) return <p className="problem">{view.error}</p>;
  const push = async () => {
    setState({ kind: "busy" });
    if ("error" in view) return;
    const outcome = await api.pushConflictResolution(taskId, view.commitSha);
    if (outcome.ok) await onPushed();
    else setState({ kind: "failed", message: outcome.message });
  };

  return (
    <div className="step-actions step-actions--column">
      <Markdown text={view.summary} onOpenLink={(url) => void api.openExternal(url)} />
      {view.files.length > 0 && (
        <ul className="conflict-files">
          {view.files.map((entry) => (
            <li key={entry.path}>
              <code>{entry.path}</code>: {entry.resolution}
            </li>
          ))}
        </ul>
      )}
      {view.concerns !== "" && <p className="field-hint">確かめてほしい点: {view.concerns}</p>}
      {view.diff !== "" && (
        <details className="conflict-diff">
          <summary>PR のブランチから見た差分</summary>
          <pre>{view.diff}</pre>
        </details>
      )}
      <div className="merge-confirm" role="alertdialog" aria-labelledby={`conflict-push-${taskId}`}>
        <p id={`conflict-push-${taskId}`} className="merge-confirm-title">
          {view.repository} の {view.headRef} に、{view.baseRef} を取り込んだ commit（<code className="session-id">{view.commitSha.slice(0, 7)}</code>）を push します
        </p>
        <p className="field-hint">直し始めたあとに PR のブランチへ commit が足されていたら、push しません（force push はしません）。</p>
        <div className="merge-confirm-actions">
          <button type="button" className="primary-button" disabled={state.kind === "busy"} onClick={() => void push()}>
            push する
          </button>
        </div>
      </div>
      {state.kind === "failed" && <p className="problem">push できませんでした: {state.message}</p>}
    </div>
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
