import { useEffect, useRef, useState } from "react";
import type { ConflictResolutionView, GmailMailTargetView, TaskQuestionView, MergePlanView, MovableStatus, PullRequestFixView, Step, TaskDetail, WaitCondition } from "../../shared/api.js";
import { api } from "./api.js";
import { Markdown } from "./Markdown.js";
import { conclusionLabel, describeChange, effortLabel, judgmentText, splitTitle, statusLabel, taskNumber, tracksGmail, tracksSlackSaved } from "./task-text.js";

const MOVABLE: MovableStatus[] = ["needs_review", "todo", "in_progress", "done"];

// 開く先のドメインを見せる（ボタンの名前だけでは、どこが開くか分からないため）
const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).hostname : "");

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
            <SlackActions detail={detail} onDone={props.onChanged} />
            <GmailActions detail={detail} onDone={props.onChanged} />
            <TaskQuestions taskId={detail.id} />
            <MakeRecurring detail={detail} onCreated={props.onChanged} />
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
      {detail.agentRun?.kind !== "dependency_review" && <ReplanButton taskId={detail.id} onStarted={onStarted} />}
    </section>
  );
}

/** この Task をもとに定期の Task を作る（タイトルと次にやることをひな形にする）。将来、AI の提案もこの形で出す */
export function MakeRecurring({ detail, onCreated }: { detail: TaskDetail; onCreated: () => Promise<void> }) {
  const suggestion = detail.recurringSuggestion;
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(suggestion?.day ?? 1);
  const [leadDays, setLeadDays] = useState(suggestion?.leadDays ?? 0);
  const [note, setNote] = useState(suggestion?.note ?? "");
  const [includeCurrent, setIncludeCurrent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 提案があるときだけ出す（すべての Task に出すと、繰り返さない Task にも勧めることになる）
  if (suggestion === undefined || detail.fromRecurring) return message === null ? null : <p className="field-hint">{message}</p>;
  if (!open) {
    return (
      <section className="next-action" aria-labelledby="drawer-recurring">
        <h3 id="drawer-recurring" className="drawer-section-title">
          定期の Task の提案
        </h3>
        <p>
          毎月 {suggestion.day} 日{suggestion.leadDays > 0 ? `（${suggestion.leadDays} 日前から）` : ""}に「{suggestion.title}」を作る
        </p>
        <p className="field-hint">理由: {suggestion.reason}</p>
        <div className="request-review">
          <button type="button" className="quiet-button" onClick={() => setOpen(true)}>
            定期の Task にする
          </button>
          {message && <span className="field-hint">{message}</span>}
        </div>
      </section>
    );
  }
  const submit = async () => {
    const outcome = await api.recurringFromTask({ taskId: detail.id, title: suggestion.title, note, schedule: { kind: "monthly", day, leadDays }, includeCurrent });
    if (outcome.ok) {
      setOpen(false);
      setMessage(`毎月 ${day} 日${leadDays > 0 ? `（${leadDays} 日前から）` : ""}に作ります。設定画面の「定期の Task」で変えられます`);
      await onCreated();
    } else setMessage(`作れませんでした: ${outcome.message}`);
  };
  return (
    <div className="merge-confirm">
      <p className="merge-confirm-title">この Task を毎月作る</p>
      <RecurrenceFields day={day} leadDays={leadDays} note={note} includeCurrent={includeCurrent} onDay={setDay} onLeadDays={setLeadDays} onNote={setNote} onIncludeCurrent={setIncludeCurrent} />
      <div className="merge-confirm-actions">
        <button type="button" className="primary-button" onClick={() => void submit()}>
          定期の Task にする
        </button>
        <button type="button" className="quiet-button" onClick={() => setOpen(false)}>
          やめる
        </button>
      </div>
      {message && <p className="problem">{message}</p>}
    </div>
  );
}

/** 毎月何日に作るか・何日前から出すか・メモ（設定画面と共通） */
export function RecurrenceFields(props: {
  day: number;
  leadDays: number;
  note: string;
  includeCurrent?: boolean;
  onDay: (day: number) => void;
  onLeadDays: (days: number) => void;
  onNote: (note: string) => void;
  onIncludeCurrent?: (value: boolean) => void;
}) {
  return (
    <div className="recurrence-fields">
      <label className="field">
        <span className="field-label">毎月</span>
        <span className="inline-field">
          <input type="number" min={1} max={31} value={props.day} onChange={(event) => props.onDay(Number(event.target.value))} /> 日に作る
        </span>
        <span className="field-hint">その月にない日（31 日など）は月末に作ります</span>
      </label>
      <label className="field">
        <span className="field-label">前もって出す</span>
        <span className="inline-field">
          <input type="number" min={0} max={27} value={props.leadDays} onChange={(event) => props.onLeadDays(Number(event.target.value))} /> 日前から
        </span>
      </label>
      <label className="field">
        <span className="field-label">メモ</span>
        <span className="field-hint">作る Task の状況に載せます（例: 11月分から金額を倍にする）</span>
        <textarea rows={2} value={props.note} onChange={(event) => props.onNote(event.target.value)} />
      </label>
      {props.onIncludeCurrent && (
        <label className="checkbox">
          <input type="checkbox" checked={props.includeCurrent ?? false} onChange={(event) => props.onIncludeCurrent?.(event.target.checked)} />
          <span>今月の分も、時期を過ぎていればすぐに作る</span>
        </label>
      )}
    </div>
  );
}

const QUESTION_POLL_MS = 3000;

/** Task について質問し、Claude Code が調べた回答を読む。調べている途中は少しずつ問い合わせ直す */
export function TaskQuestions({ taskId }: { taskId: number }) {
  const [questions, setQuestions] = useState<TaskQuestionView[]>([]);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const load = async () => setQuestions(await api.taskQuestions(taskId));
  useEffect(() => {
    void load();
  }, [taskId]);
  const running = questions.some((question) => question.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), QUESTION_POLL_MS);
    return () => clearInterval(timer);
  }, [running, taskId]);
  const ask = async () => {
    setSending(true);
    const outcome = await api.askTask(taskId, draft);
    setSending(false);
    if (outcome.ok) {
      setDraft("");
      setProblem(null);
      await load();
    } else setProblem(outcome.message);
  };

  return (
    <section className="drawer-section" aria-labelledby="drawer-questions">
      <h3 id="drawer-questions" className="drawer-section-title">
        質問
      </h3>
      {questions.length > 0 && (
        <ol className="task-questions">
          {questions.map((question) => (
            <li key={question.id} className="task-question">
              <p className="task-question-text">{question.question}</p>
              {question.status === "running" && <p className="field-hint">Claude Code が調べています…</p>}
              {question.status === "failed" && <p className="problem">答えられませんでした: {question.error}</p>}
              {question.status === "answered" && question.answer !== null && (
                <div className="task-question-answer">
                  <Markdown text={question.answer} onOpenLink={(url) => void api.openExternal(url)} />
                  {question.sources.length > 0 && <p className="field-hint">根拠: {question.sources.join("、")}</p>}
                  {question.suggestions.map((suggestion, index) =>
                    suggestion.status === "dismissed" ? null : (
                      <div key={index} className="task-suggestion">
                        <p className="task-question-text">別の Task にしませんか？: {suggestion.title}</p>
                        {suggestion.brief !== "" && <p className="field-hint">{suggestion.brief}</p>}
                        <p className="field-hint">理由: {suggestion.reason}</p>
                        {suggestion.status === "accepted" ? (
                          <p className="field-hint">Task にしました{suggestion.taskId === undefined ? "" : `（#${suggestion.taskId}）`}</p>
                        ) : (
                          <div className="step-actions">
                            <button type="button" className="primary-button" onClick={() => void api.acceptSuggestion(question.id, index).then(load)}>
                              Task にする
                            </button>
                            <button type="button" className="quiet-button" onClick={() => void api.dismissSuggestion(question.id, index).then(load)}>
                              見送る
                            </button>
                          </div>
                        )}
                      </div>
                    ),
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <form
        className="task-question-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() !== "" && !running) void ask();
        }}
      >
        <textarea
          aria-label="この Task についての質問"
          placeholder="この Task について聞きたいこと（例: 期限はいつ？ この PR は何を変える？）"
          value={draft}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="primary-button" disabled={sending || running || draft.trim() === ""}>
          質問する
        </button>
      </form>
      {problem && <p className="problem">{problem}</p>}
    </section>
  );
}

const GMAIL_PREVIEW_LIMIT = 8;
const GMAIL_ACTIONS = {
  archive: { button: "確認済みにする", confirm: (count: number) => `次の ${count} 通を確認済みにします（Gmail でアーカイブし、既読にします）`, failed: "確認済みにできませんでした" },
  trash: { button: "ゴミ箱に入れる", confirm: (count: number) => `次の ${count} 通を Gmail のゴミ箱に入れます`, failed: "ゴミ箱に入れられませんでした" },
} as const;

/** メールの一覧を見せ、承認したものだけを Gmail で確認済みにする（アーカイブ）かゴミ箱に入れる */
export function GmailMailFlow({ taskId, onDone, onlyPastInvites = false }: { taskId: number; onDone: () => Promise<void>; onlyPastInvites?: boolean }) {
  const [pending, setPending] = useState<{ action: "archive" | "trash"; target: GmailMailTargetView } | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "failed"; message: string }>({ kind: "idle" });
  const open = async (action: "archive" | "trash") => {
    setState({ kind: "busy" });
    const loaded = await api.gmailMailTarget(taskId);
    if ("error" in loaded) setState({ kind: "failed", message: loaded.error });
    else {
      const messages = onlyPastInvites ? loaded.messages.filter((message) => message.pastInvite) : loaded.messages;
      setPending({ action, target: { ...loaded, messages } });
      setState({ kind: "idle" });
    }
  };
  const run = async (action: "archive" | "trash", messageIds: ReadonlyArray<string>) => {
    setState({ kind: "busy" });
    const outcome = await api.gmailProcess(taskId, action, messageIds);
    if (outcome.ok) {
      setPending(null);
      setState({ kind: "idle" });
      await onDone();
    } else setState({ kind: "failed", message: `${GMAIL_ACTIONS[action].failed}: ${outcome.message}` });
  };

  return (
    <>
      {pending === null ? (
        <div className="step-actions">
          <button type="button" className="primary-button" disabled={state.kind === "busy"} onClick={() => void open("archive")}>
            {GMAIL_ACTIONS.archive.button}
          </button>
          {!onlyPastInvites && (
            <button type="button" className="quiet-button" disabled={state.kind === "busy"} onClick={() => void open("trash")}>
              {GMAIL_ACTIONS.trash.button}
            </button>
          )}
        </div>
      ) : pending.target.messages.length === 0 ? (
        <p className="problem">受信トレイに残っているメールはありません。</p>
      ) : (
        <div className="merge-confirm" role="alertdialog" aria-labelledby={`gmail-confirm-${taskId}`}>
          <p id={`gmail-confirm-${taskId}`} className="merge-confirm-title">
            {GMAIL_ACTIONS[pending.action].confirm(pending.target.messages.length)}
          </p>
          <ul className="gmail-trash-list">
            {pending.target.messages.slice(0, GMAIL_PREVIEW_LIMIT).map((message) => (
              <li key={message.messageId}>
                <span className="gmail-trash-date">{dateTimeOf(new Date(message.receivedAt).toISOString())}</span>
                {message.subject === "" ? "（件名なし）" : message.subject}
                <span className="gmail-trash-from">{message.senderName}</span>
              </li>
            ))}
            {pending.target.messages.length > GMAIL_PREVIEW_LIMIT && <li>ほか {pending.target.messages.length - GMAIL_PREVIEW_LIMIT} 通</li>}
          </ul>
          <div className="merge-confirm-actions">
            <button
              type="button"
              className="primary-button"
              disabled={state.kind === "busy"}
              onClick={() => void run(pending.action, pending.target.messages.map((message) => message.messageId))}
            >
              {GMAIL_ACTIONS[pending.action].button}
            </button>
            <button type="button" className="quiet-button" onClick={() => setPending(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
      {state.kind === "failed" && <p className="problem">{state.message}</p>}
    </>
  );
}

const isThreadTask = (detail: TaskDetail) => detail.items.some((item) => item.role === "tracks" && /^gmail:[a-z0-9][a-z0-9-]*:threads$/.test(item.source));

const hasMailStep = (detail: TaskDetail) => JSON.stringify(detail.nextActions ?? null).includes('"process_mail"');

/** Gmail のメールを追う Task のうち、次にやることに片付ける手順がないものに出す（人からのメールのスレッドなど）。日程が過ぎた招待があれば案内する */
export function GmailActions({ detail, onDone }: { detail: TaskDetail; onDone: () => Promise<void> }) {
  const visible = tracksGmail(detail.items) && detail.status !== "done" && detail.status !== "dismissed" && !hasMailStep(detail);
  const [pastInvites, setPastInvites] = useState(0);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void api.gmailMailTarget(detail.id).then((loaded) => {
      if (!cancelled && !("error" in loaded)) setPastInvites(loaded.messages.filter((message) => message.pastInvite).length);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, detail.id, detail.updatedAt]);
  if (!visible) return null;
  return (
    <section className="next-action" aria-labelledby="drawer-gmail">
      <h3 id="drawer-gmail" className="drawer-section-title">
        Gmail
      </h3>
      {isThreadTask(detail) && <p className="field-hint">この Task を完了にすると、Gmail のメールも確認済み（アーカイブして既読）にします</p>}
      {pastInvites > 0 && (
        <div className="gmail-invite-hint">
          <p className="field-hint">日程が過ぎた招待が {pastInvites} 通あります。確認済みにしますか？</p>
          <GmailMailFlow taskId={detail.id} onDone={onDone} onlyPastInvites />
        </div>
      )}
      <GmailMailFlow taskId={detail.id} onDone={onDone} />
    </section>
  );
}

/** Slack の To-do・Saved を追う Task だけに出す。押すと確認を出し、承認したときだけ Slack に書き込む */
export function SlackActions({ detail, onDone }: { detail: TaskDetail; onDone: () => Promise<void> }) {
  const [confirming, setConfirming] = useState<"complete" | "remove" | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "failed"; message: string }>({ kind: "idle" });
  if (!tracksSlackSaved(detail.items) || detail.status === "done" || detail.status === "dismissed") return null;
  const run = async (action: "complete" | "remove") => {
    setState({ kind: "busy" });
    const outcome = await api.slackAction(detail.id, action);
    if (outcome.ok) {
      setConfirming(null);
      setState({ kind: "idle" });
      await onDone();
    } else setState({ kind: "failed", message: outcome.message });
  };
  const LABELS = {
    complete: { button: "Slack でも完了にする", confirm: "Slack の To-do を完了にし、この Task も完了にします" },
    remove: { button: "Slack の To-do から外す", confirm: "Slack の To-do・Saved から外し、この Task を片付けます（メッセージは消えません）" },
  } as const;

  return (
    <section className="next-action" aria-labelledby="drawer-slack">
      <h3 id="drawer-slack" className="drawer-section-title">
        Slack
      </h3>
      {confirming === null ? (
        <div className="step-actions">
          <button type="button" className="primary-button" onClick={() => setConfirming("complete")}>
            {LABELS.complete.button}
          </button>
          <button type="button" className="quiet-button" onClick={() => setConfirming("remove")}>
            {LABELS.remove.button}
          </button>
        </div>
      ) : (
        <div className="merge-confirm" role="alertdialog" aria-labelledby="slack-confirm-title">
          <p id="slack-confirm-title" className="merge-confirm-title">
            {LABELS[confirming].confirm}
          </p>
          <div className="merge-confirm-actions">
            <button type="button" className="primary-button" disabled={state.kind === "busy"} onClick={() => void run(confirming)}>
              実行する
            </button>
            <button type="button" className="quiet-button" onClick={() => setConfirming(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
      {state.kind === "failed" && <p className="problem">Slack に書き込めませんでした: {state.message}</p>}
    </section>
  );
}

/** 依存更新の PR は「もう一度調べる」で次にやることも作り直すので、それ以外の Task にだけ出す */
function ReplanButton({ taskId, onStarted }: { taskId: number; onStarted: () => Promise<void> }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [request, setRequest] = useState("");
  const send = (text: string | undefined) =>
    void api.replanNextActions(taskId, text).then(async (outcome) => {
      if (outcome.ok) {
        setRequest("");
        await onStarted();
      } else setProblem(outcome.message);
    });
  return (
    <div className="request-review">
      <form
        className="task-question-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (request.trim() !== "") send(request.trim());
        }}
      >
        <textarea
          aria-label="次にやることへの希望"
          rows={2}
          value={request}
          placeholder="こうしたい（例: このメールはアーカイブして終わりにしたい / 先に佐藤さんに確認してから進めたい）"
          onChange={(event) => setRequest(event.target.value)}
        />
        <div className="step-actions">
          <button type="submit" className="primary-button" disabled={request.trim() === ""}>
            希望に合わせて書き換える
          </button>
          <button type="button" className="quiet-button" onClick={() => send(undefined)}>
            次にやることを考え直す
          </button>
        </div>
      </form>
      <span className="field-hint">済んだ手順は残して、残りを AI が書き換えます</span>
      {problem && <p className="problem">{problem}</p>}
    </div>
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
      {isCurrent && step.kind === "process_mail" && <GmailMailFlow taskId={detail.id} onDone={props.onChanged} />}
      {isCurrent && step.kind === "archive_past_invites" && <GmailMailFlow taskId={detail.id} onDone={props.onChanged} onlyPastInvites />}
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
      {isCurrent && step.kind !== "decision" && step.link !== undefined && (
        <div className="step-actions">
          <button type="button" className="primary-button" onClick={() => void api.openStepLink(detail.id, step.id)}>
            {step.link.label}を開く
          </button>
          <span className="field-hint">{hostOf(step.link.url)}</span>
        </div>
      )}
      {isCurrent && (step.kind === "manual" || step.kind === "fix_and_push") && (
        <div className="step-actions">
          {step.kind === "fix_and_push" && <PullRequestFixFlow taskId={detail.id} step={step.title} onStarted={props.onStarted} onPushed={props.onChanged} />}
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

/** Claude Code に PR を修正させ、直した内容を確かめて push する。自分で直したなら「済んだ」でもよい */
function PullRequestFixFlow({ taskId, step, onStarted, onPushed }: { taskId: number; step: string; onStarted: () => Promise<void>; onPushed: () => Promise<void> }) {
  const [view, setView] = useState<PullRequestFixView | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "failed"; message: string }>({ kind: "idle" });
  useEffect(() => {
    void api.pullRequestFix(taskId).then((result) => setView("error" in result || result.step !== step ? null : result));
  }, [taskId, step]);
  const start = async () => {
    setState({ kind: "busy" });
    const outcome = await api.fixPullRequest(taskId);
    if (outcome.ok) await onStarted();
    else setState({ kind: "failed", message: outcome.message });
  };
  const push = async () => {
    if (view === null) return;
    setState({ kind: "busy" });
    const outcome = await api.pushPullRequestFix(taskId, view.commitSha);
    if (outcome.ok) await onPushed();
    else setState({ kind: "failed", message: outcome.message });
  };

  return (
    <div className="step-actions step-actions--column">
      {view === null ? (
        <>
          <span className="field-hint">PR のブランチを取り出して、Claude Code が調査の内容どおりに直します。確認のコマンドも実行しますが、push は確かめてからです</span>
          <button type="button" className="primary-button" disabled={state.kind === "busy"} onClick={() => void start()}>
            Claude Code に修正させる
          </button>
        </>
      ) : (
        <>
          <Markdown text={view.summary} onOpenLink={(url) => void api.openExternal(url)} />
          <p className="field-hint">確かめたこと: {view.verification}</p>
          {view.concerns !== "" && <p className="field-hint">確かめてほしい点: {view.concerns}</p>}
          <details className="conflict-diff">
            <summary>差分</summary>
            <pre>{view.diff}</pre>
          </details>
          <div className="merge-confirm" role="alertdialog" aria-labelledby={`fix-push-${taskId}`}>
            <p id={`fix-push-${taskId}`} className="merge-confirm-title">
              {view.repository} の {view.headRef} に、この修正の commit（<code className="session-id">{view.commitSha.slice(0, 7)}</code>）を push します
            </p>
            <div className="merge-confirm-actions">
              <button type="button" className="primary-button" disabled={state.kind === "busy"} onClick={() => void push()}>
                push する
              </button>
              <button type="button" className="quiet-button" disabled={state.kind === "busy"} onClick={() => void start()}>
                もう一度直させる
              </button>
            </div>
          </div>
        </>
      )}
      {state.kind === "failed" && <p className="problem">{state.message}</p>}
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
