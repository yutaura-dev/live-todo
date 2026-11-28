import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { EffectView, TaskDetailData } from "../detail-fixtures.js";
import { attentionOf } from "../horizon.js";
import type { Level } from "../model.js";
import { AttentionMark, Box, Button, Mark, SourceMarks, StopWorkButton, WorkingMark } from "../parts.js";
import { Plan } from "../plan/PlanView.js";

const LEVELS: Level[] = ["今すぐ", "今日中", "3 日以内", "10 日以内", "30 日以内", "それより先でよい"];
const COLUMN_LABELS = { triaging: "仕分け中", needs_review: "要確認", todo: "Todo", 完了待ち: "完了待ち", closed: "終わった" } as const;

/**
 * Task の詳細。見通しの右に並べて出すときは h2、単独の画面として出すときは h1 にする。
 * 上から「何をするか → いつまでに → 今の状況 → 計画 → 事実 → AI に聞く → 履歴」の順に置く理由:
 * 開いた人がまず知りたいのは「何を、いつまでに」で、事実や履歴は確かめたいときにだけ読むため。
 */
export function TaskDetail({
  data,
  headingLevel = 2,
  annotate = false,
  focusPlan = false,
  onClose,
}: {
  data: TaskDetailData;
  headingLevel?: 1 | 2;
  annotate?: boolean;
  /** 開いたとき計画（分かれ道）の位置まで移る。見通しのカードの「選ぶ」から開いたとき */
  focusPlan?: boolean;
  onClose?: () => void;
}) {
  const planRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusPlan) planRef.current?.scrollIntoView?.({ block: "start" });
  }, [focusPlan]);
  const mark = (n: number) => (annotate ? <Mark n={n} /> : null);
  const { task } = data;
  const [plan, setPlan] = useState(data.plan);
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const working = task.work === "作業中";
  const open = task.status === "needs_review" || task.status === "todo";
  return (
    <article className="wf-detail" aria-labelledby="wf-detail-title">
      <header className="wf-stack">
        <div className="wf-task-top">
          {task.status !== "todo" && <span className="wf-pill">{COLUMN_LABELS[task.status]}</span>}
          <AttentionMark attention={attentionOf(task)} />
          {working && <WorkingMark />}
          {onClose && (
            <Button tone="quiet" onClick={onClose} style={{ marginInlineStart: "auto" }}>
              閉じる
            </Button>
          )}
        </div>
        <Heading id="wf-detail-title" className="wf-detail-title">
          {task.title}
        </Heading>
        <div className="wf-task-top">
          <TaskActions data={data} />
          {mark(1)}
        </div>
        {open && (
          <div className="wf-task-top" style={{ alignItems: "start", flexWrap: "nowrap" }}>
            <PriorityAndDue data={data} />
            {mark(2)}
          </div>
        )}
      </header>

      {task.brief && (
        <Box kind="ai" label="今の状況">
          <p>{task.brief}</p>
        </Box>
      )}

      {data.recurringDraft && (
        <Box kind="ai" label="AI の提案">
          <p>
            定期の Task にしますか？　{data.recurringDraft.rule}
          </p>
          <div className="wf-button-row">
            <Button>定期の Task にする</Button>
            <Button tone="quiet">見送る</Button>
          </div>
        </Box>
      )}

      {task.status === "完了待ち" && (
        <div className="wf-task-top" style={{ alignItems: "start", flexWrap: "nowrap" }}>
          <CompletionChecklist effects={data.effects} />
          {mark(5)}
        </div>
      )}

      {task.status !== "完了待ち" && (
        <section ref={planRef} className="wf-section" aria-labelledby="wf-plan-title">
          <h3 id="wf-plan-title" className="wf-section-title">
            計画 {mark(3)}
          </h3>
          {plan ? <Plan plan={plan} onChange={setPlan} /> : <p className="wf-sub">AI が計画を考えています</p>}
        </section>
      )}

      {data.facts.length > 0 && (
        <section className="wf-section" aria-labelledby="wf-facts-title">
          <h3 id="wf-facts-title" className="wf-section-title">
            事実 {mark(4)}
          </h3>
          <ul className="wf-now-list">
            {data.facts.map((fact) => (
              <li key={fact.title}>
                <span className="wf-task-top">
                  <SourceMarks sources={[fact.source]} />
                  {fact.title}
                </span>
                <span className="wf-button-row">
                  <Button tone="quiet">開く</Button>
                  <Menu label={`「${fact.title}」の操作`} items={[{ label: "別の Task に移す" }, { label: "この Task から外す" }]} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && <AskAi questions={data.questions} />}

      <details className="wf-more">
        <summary>
          <span className="wf-section-title">履歴</span>
        </summary>
        <ul className="wf-history" style={{ padding: "8px 16px 16px" }}>
          {data.history.map((entry) => (
            <li key={`${entry.at}${entry.what}`}>
              <span>{entry.at}</span>
              <span>{entry.by}</span>
              <span>{entry.what}</span>
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

function Menu({ label, items, note }: { label: string; items: Array<{ label: string; disabled?: boolean }>; note?: string }) {
  return (
    <details className="wf-menu">
      <summary aria-label={label}>…</summary>
      <ul>
        {items.map((item) => (
          <li key={item.label}>
            <button type="button" disabled={item.disabled === true}>
              {item.label}
            </button>
          </li>
        ))}
        {note && <li className="wf-sub">{note}</li>}
      </ul>
    </details>
  );
}

/** Task そのものへの操作（specs/task.spec.ts の complete・dismiss・move・reopen）。いちばん使う「完了にする」だけを出し、残りは「…」に入れる */
function TaskActions({ data }: { data: TaskDetailData }) {
  const { task } = data;
  const working = task.work === "作業中";
  if (task.status === "完了待ち") return <Menu label="Task の操作" items={[{ label: "まだ終わっていない（やり直す）" }, { label: "やらないことにする" }]} />;
  const move = task.status === "needs_review" ? "Todo に移す" : "要確認に戻す";
  return (
    <div className="wf-button-row">
      {working ? <StopWorkButton label="完了にする" tone="default" what="この Task で Claude Code が作業しています" onConfirm={() => undefined} /> : <Button>完了にする</Button>}
      <Menu
        label="Task の操作"
        items={[{ label: "やらないことにする" }, { label: move, disabled: working }]}
        {...(working ? { note: "AI の作業中は、要確認と Todo のあいだを移せません" } : {})}
      />
    </div>
  );
}

/**
 * 優先度と期日（specs/prioritization.spec.ts・task.spec.ts の setDue）。ふだんは「今日中・理由・期日」の 1 行だけを出し、変えるときだけ広げる。
 * ラベル未定のときだけは、決めないと先に進まないので、選択肢を最初から出す。
 */
function PriorityAndDue({ data }: { data: TaskDetailData }) {
  const [priority, setPriority] = useState(data.task.priority);
  const [editing, setEditing] = useState(false);
  if (priority?.status === "ラベル未定") {
    return (
      <Box kind="mine" label="いつまでに手を付けるか、決めてください">
        <div className="wf-options">
          {LEVELS.map((level) => (
            <Button key={level} onClick={() => setPriority({ status: "ユーザーが決めた", level, reason: "あなたが決めた" })}>
              {level}
            </Button>
          ))}
        </div>
      </Box>
    );
  }
  return (
    <section className="wf-stack" style={{ gap: 8 }} aria-label="優先度と期日">
      <p className="wf-task-top">
        {priority?.status === "未判定" ? (
          <span className="wf-sub">優先度を決めています</span>
        ) : priority ? (
          <>
            <strong>{priority.level}</strong>
            <span className="wf-sub">{priority.reason}</span>
          </>
        ) : null}
        {data.due && <span className="wf-sub">期日 {data.due}</span>}
        <Button tone="quiet" onClick={() => setEditing(!editing)}>
          {editing ? "閉じる" : "変える"}
        </Button>
      </p>
      {editing && (
        <div className="wf-box wf-box--quiet">
          {/* 選択肢を開いて選ぶ形にしない理由: 段は 6 つしかなく、ボタンを並べれば 1 回押すだけで決まる */}
          <div className="wf-options" role="group" aria-label="優先度">
            {LEVELS.map((level) => (
              <Button
                key={level}
                tone={priority && priority.status !== "未判定" && priority.level === level ? "primary" : "default"}
                onClick={() => {
                  setPriority({ status: "ユーザーが決めた", level, reason: "あなたが決めた" });
                  setEditing(false);
                }}
              >
                {level}
              </Button>
            ))}
          </div>
          {priority?.status === "ユーザーが決めた" && (
            <Button tone="quiet" onClick={() => setEditing(false)}>
              アプリに任せる
            </Button>
          )}
          <label className="wf-task-top">
            期日
            <input defaultValue={data.due ?? ""} placeholder="例: 12 月中旬、金曜まで" className="wf-inline-input" />
          </label>
        </div>
      )}
    </section>
  );
}

const DELIVERY_NOTE: Record<EffectView["delivery"], string> = {
  まだ: "",
  頼んだ: "書き込んでいます",
  書き込んだ: "書き込みました",
  書き込めなかった: "書き込めませんでした",
  取りやめた: "取りやめました",
};

/**
 * 完了待ちのチェックリスト（specs/completion-effect.spec.ts）。初めは ☑ で、個別に外せる。完了のボタンを押したことが承認になる。
 * 書き込めなかったものはここに残り、もう一度頼むか、☑ を外して済ませる。
 */
function CompletionChecklist({ effects }: { effects: EffectView[] }) {
  const [checked, setChecked] = useState(() => effects.map((effect) => effect.checked));
  const pending = effects.filter((effect, index) => checked[index] && effect.delivery === "まだ").length;
  const failed = effects.some((effect) => effect.delivery === "書き込めなかった");
  return (
    <section className="wf-section" aria-labelledby="wf-effects-title">
      <h3 id="wf-effects-title" className="wf-section-title">
        完了したときにすること
      </h3>
      <ul className="wf-stack" style={{ gap: 8 }}>
        {effects.map((effect, index) => {
          const locked = effect.delivery === "頼んだ" || effect.delivery === "書き込んだ" || effect.delivery === "取りやめた";
          return (
            <li key={effect.title}>
              <div className={`wf-check${effect.delivery === "書き込めなかった" ? " wf-check--failed" : ""}`}>
                <input
                  type="checkbox"
                  aria-label={effect.title}
                  disabled={locked}
                  checked={checked[index] ?? false}
                  onChange={(event) => setChecked((current) => current.map((value, i) => (i === index ? event.target.checked : value)))}
                />
                <span className="wf-stack" style={{ gap: 2 }}>
                  <span className={effect.delivery === "書き込んだ" ? "wf-node-done-plain" : undefined}>{effect.title}</span>
                  {DELIVERY_NOTE[effect.delivery] && <span className="wf-sub">{DELIVERY_NOTE[effect.delivery]}</span>}
                  {effect.failure && <span className="wf-task-reason">{effect.failure}</span>}
                </span>
                {effect.delivery === "書き込めなかった" && checked[index] && <Button style={{ marginInlineStart: "auto" }}>もう一度頼む</Button>}
              </div>
            </li>
          );
        })}
      </ul>
      {!failed && (
        <div className="wf-button-row">
          <Button tone="primary">{pending > 0 ? `${pending} 件を書き込んで完了にする` : "書き込まずに完了にする"}</Button>
        </div>
      )}
      {failed && <p className="wf-task-reason">書き込めなかったものを、もう一度頼むか ☑ を外すと終わります</p>}
    </section>
  );
}

function AskAi({ questions }: { questions: TaskDetailData["questions"] }) {
  const [draft, setDraft] = useState("");
  const [asked, setAsked] = useState(questions);
  const submit = () => {
    if (draft.trim() === "") return;
    setAsked((current) => [...current, { question: draft.trim(), answer: null }]);
    setDraft("");
  };
  // Enter ではなく ⌘ + Enter で送る理由: 日本語の変換の確定に Enter を使うので、確定のたびに送ってしまわないため
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <section className="wf-section" aria-labelledby="wf-ask-title">
      <h3 id="wf-ask-title" className="wf-section-title">
        AI に聞く
      </h3>
      {asked.map((entry) => (
        <div key={entry.question} className="wf-stack" style={{ gap: 6 }}>
          <Box kind="quiet">{entry.question}</Box>
          {entry.answer === null ? (
            <Box kind="waiting" label="調べています">
              <p>調べ終わると、ここに回答が出ます</p>
            </Box>
          ) : (
            <Box kind="ai" label="回答">
              {entry.answer}
            </Box>
          )}
        </div>
      ))}
      <form
        className="wf-ask"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          id="wf-ask-input"
          aria-label="この Task について AI に聞く"
          placeholder="この Task について聞く（⌘ + Enter で送る）"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="wf-button-row">
          <Button type="submit" disabled={draft.trim() === ""}>
            聞く
          </Button>
        </div>
      </form>
    </section>
  );
}


export const DETAIL_NOTES = [
  { n: 1, text: "いちばん使う「完了にする」だけを出し、やらないことにする・列を移すは「…」に入れる。AI が作業中に完了にするときは「作業を止めますか」と確かめる" },
  { n: 2, text: "優先度・理由・期日を 1 行で見せ、変えるときだけ広げる。自分で決めたときだけ「アプリに任せる」が出る。ラベル未定のときだけは、選択肢を最初から出す" },
  { n: 3, text: "計画は線路で見せる（ワイヤーフレーム/Task の詳細/計画 を参照）。計画を立て直すのは AI だけなので、ここに「考え直してもらう」は置かない" },
  { n: 4, text: "事実は題と「開く」だけ。振り分けを間違えたときの「別の Task に移す」「外す」は「…」に入れる" },
  { n: 5, text: "☑ の付いたものを、完了のボタンで書き込む（押したことが承認）。書き込めなかったものは残り、もう一度頼むか ☑ を外す" },
];
