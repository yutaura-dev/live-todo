import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { EffectView, TaskDetailData } from "../../wireframes/detail-fixtures.js";
import { attentionOf } from "../../wireframes/horizon.js";
import type { Level } from "../../wireframes/model.js";
import { AiText, AttentionPill, Button, Icon, Menu, Pill, SourceMarks, StopWorkButton, WorkingPill } from "../components.js";
import { Plan } from "./Plan.js";

const LEVELS: Level[] = ["今すぐ", "今日中", "3 日以内", "10 日以内", "30 日以内", "それより先でよい"];
const COLUMN_LABELS = { todo: "Todo", 完了待ち: "完了待ち", closed: "終わった" } as const;

/**
 * Task の詳細。上から「何をするか → いつまでに → 今の状況 → 計画 → 事実 → AI に聞く → 履歴」の順に置く。
 * 開いた人がまず知りたいのは「何を、いつまでに」で、事実や履歴は確かめたいときにだけ読むため。
 */
export function TaskDetail({ data, headingLevel = 2, focusPlan = false, onClose }: { data: TaskDetailData; headingLevel?: 1 | 2; focusPlan?: boolean; onClose?: () => void }) {
  const planRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusPlan) planRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [focusPlan]);
  const { task } = data;
  const [plan, setPlan] = useState(data.plan);
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const working = task.work === "作業中";
  const open = task.status === "todo";
  return (
    <article className="ui-detail" aria-labelledby="ui-detail-title">
      <header className="ui-detail-head">
        <div className="ui-detail-bar">
          <span className="ui-row">
            {task.status !== "todo" && <Pill tone="outline">{COLUMN_LABELS[task.status]}</Pill>}
            <AttentionPill attention={attentionOf(task)} />
            {working && <WorkingPill />}
            <SourceMarks sources={task.sources} />
          </span>
          {onClose && (
            <Button tone="quiet" size="sm" className="ui-button--icon" onClick={onClose} aria-label="詳細を閉じる">
              <Icon name="close" />
            </Button>
          )}
        </div>
        <Heading id="ui-detail-title" className="ui-detail-title">
          {task.title}
        </Heading>
        {open && <PriorityAndDue data={data} />}
        <TaskActions data={data} />
      </header>

      {task.brief && (
        <AiText label="今の状況（AI が書いた）">
          <p>{task.brief}</p>
        </AiText>
      )}

      {data.recurringDraft && (
        <div className="ui-suggest">
          <p>
            <strong>定期の Task にしますか？</strong>
            <span className="ui-sub">　{data.recurringDraft.rule}</span>
          </p>
          <div className="ui-row">
            <Button size="sm">定期の Task にする</Button>
            <Button size="sm" tone="quiet">
              見送る
            </Button>
          </div>
        </div>
      )}

      {task.status === "完了待ち" ? (
        <CompletionChecklist effects={data.effects} />
      ) : (
        <section ref={planRef} className="ui-section" aria-labelledby="ui-plan-title">
          <h3 id="ui-plan-title" className="ui-section-title">
            計画
          </h3>
          {plan ? <Plan plan={plan} onChange={setPlan} /> : <p className="ui-thinking">AI が計画を考えています</p>}
        </section>
      )}

      {data.facts.length > 0 && (
        <section className="ui-section" aria-labelledby="ui-facts-title">
          <h3 id="ui-facts-title" className="ui-section-title">
            事実
          </h3>
          <ul className="ui-facts">
            {data.facts.map((fact) => (
              <li key={fact.title} className="ui-fact">
                <SourceMarks sources={[fact.source]} />
                <span className="ui-fact-text">
                  <span>{fact.title}</span>
                  <span className="ui-sub">{fact.lines.slice(1).join("、")}</span>
                </span>
                <span className="ui-row">
                  <Button tone="quiet" size="sm">
                    <Icon name="open" size={14} />
                    開く
                  </Button>
                  <Menu label={`「${fact.title}」の操作`} items={[{ label: "別の Task に移す" }, { label: "この Task から外す" }]} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && <AskAi questions={data.questions} />}

      {data.history.length > 0 && (
        <details className="ui-disclosure ui-section">
          <summary className="ui-section-title">
            <Icon name="chevron" />
            履歴
          </summary>
          <ol className="ui-history">
            {data.history.map((entry) => (
              <li key={`${entry.at}${entry.what}`}>
                <span className="ui-num ui-sub">{entry.at}</span>
                <span className="ui-history-by">{entry.by}</span>
                <span>{entry.what}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

/** Task そのものへの操作。いちばん使う「完了にする」だけを出し、残りは「…」に入れる */
function TaskActions({ data }: { data: TaskDetailData }) {
  const { task } = data;
  const working = task.work === "作業中";
  if (task.status === "完了待ち")
    return (
      <div className="ui-row">
        <Menu label="Task の操作" items={[{ label: "まだ終わっていない（やり直す）" }, { label: "やらないことにする" }]} />
      </div>
    );
  return (
    <div className="ui-row">
      {working ? (
        <StopWorkButton label="完了にする" tone="secondary" size="sm" what="この Task で Claude Code が作業しています" onConfirm={() => undefined} />
      ) : (
        <Button size="sm">
          <Icon name="check" size={14} />
          完了にする
        </Button>
      )}
      <Menu
        label="Task の操作"
        items={[{ label: "別の Task にまとめる…", disabled: working }, { label: "やらないことにする", tone: "danger" }]}
        {...(working ? { note: "AI の作業中は、別の Task にまとめられません（作業を止めるか、終わるのを待つ）" } : {})}
      />
    </div>
  );
}

/** 優先度と期日。ふだんは 1 行だけを出し、変えるときだけ広げる。ラベル未定のときだけは選択肢を最初から出す */
function PriorityAndDue({ data }: { data: TaskDetailData }) {
  const [priority, setPriority] = useState(data.task.priority);
  const [editing, setEditing] = useState(false);
  const choose = (level: Level) => {
    setPriority({ status: "ユーザーが決めた", level, reason: "あなたが決めた" });
    setEditing(false);
  };
  if (priority?.status === "ラベル未定") {
    return (
      <div className="ui-decide-box">
        <p className="ui-decide-title">いつまでに手を付けるか、決めてください</p>
        <p className="ui-sub">AI は優先度を決めきれませんでした</p>
        <div className="ui-segmented" role="group" aria-label="優先度">
          {LEVELS.map((level) => (
            <button key={level} type="button" onClick={() => choose(level)}>
              {level}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const decided = priority && priority.status !== "未判定" ? priority : null;
  return (
    <section className="ui-priority" aria-label="優先度と期日">
      <div className="ui-priority-line">
        {decided ? (
          <>
            <span className="ui-level">{decided.level}</span>
            <span className="ui-sub">{decided.reason}</span>
          </>
        ) : (
          <span className="ui-sub">優先度を決めています</span>
        )}
        <Button tone="quiet" size="sm" className="ui-priority-toggle" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          {editing ? "閉じる" : "変える"}
        </Button>
      </div>
      {data.due && (
        <p className="ui-sub">
          期日 <span className="ui-due">{data.due}</span>
        </p>
      )}
      {editing && (
        <div className="ui-priority-edit">
          {/* 選択肢を開いて選ぶ形にしない理由: 段は 6 つしかなく、並べれば 1 回押すだけで決まる */}
          <div className="ui-segmented" role="group" aria-label="優先度">
            {LEVELS.map((level) => (
              <button key={level} type="button" aria-pressed={decided?.level === level} onClick={() => choose(level)}>
                {level}
              </button>
            ))}
          </div>
          {priority?.status === "ユーザーが決めた" && (
            <Button tone="quiet" size="sm" onClick={() => setEditing(false)}>
              アプリに任せる
            </Button>
          )}
          <div className="ui-field">
            <label htmlFor="ui-due-input">期日</label>
            <input id="ui-due-input" className="ui-input" defaultValue={data.due ?? ""} placeholder="例: 12 月中旬、金曜まで" />
          </div>
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

/** 完了待ちのチェックリスト。初めは ☑ で、個別に外せる。完了のボタンを押したことが承認になる */
function CompletionChecklist({ effects }: { effects: EffectView[] }) {
  const [checked, setChecked] = useState(() => effects.map((effect) => effect.checked));
  const pending = effects.filter((effect, index) => checked[index] && effect.delivery === "まだ").length;
  const failed = effects.some((effect) => effect.delivery === "書き込めなかった");
  return (
    <section className="ui-section" aria-labelledby="ui-effects-title">
      <h3 id="ui-effects-title" className="ui-section-title">
        完了したときにすること
      </h3>
      <ul className="ui-checklist">
        {effects.map((effect, index) => {
          const locked = effect.delivery === "頼んだ" || effect.delivery === "書き込んだ" || effect.delivery === "取りやめた";
          const id = `ui-effect-${index}`;
          return (
            <li key={effect.title} className={`ui-check${effect.delivery === "書き込めなかった" ? " ui-check--failed" : ""}${effect.delivery === "書き込んだ" ? " ui-check--done" : ""}`}>
              <input
                id={id}
                type="checkbox"
                disabled={locked}
                checked={checked[index] ?? false}
                onChange={(event) => setChecked((current) => current.map((value, i) => (i === index ? event.target.checked : value)))}
              />
              <label htmlFor={id} className="ui-check-text">
                <span className="ui-check-title">{effect.title}</span>
                {DELIVERY_NOTE[effect.delivery] && <span className="ui-sub">{DELIVERY_NOTE[effect.delivery]}</span>}
                {effect.failure && <span className="ui-check-failure">{effect.failure}</span>}
              </label>
              {effect.delivery === "書き込めなかった" && checked[index] && <Button size="sm">もう一度頼む</Button>}
            </li>
          );
        })}
      </ul>
      {failed ? (
        <p className="ui-sub">書き込めなかったものを、もう一度頼むか ☑ を外すと終わります</p>
      ) : (
        <Button tone="primary" size="lg" className="ui-complete">
          {pending > 0 ? `${pending} 件を書き込んで完了にする` : "書き込まずに完了にする"}
        </Button>
      )}
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
    <section className="ui-section" aria-labelledby="ui-ask-title">
      <h3 id="ui-ask-title" className="ui-section-title">
        AI に聞く
      </h3>
      {asked.length > 0 && (
        <ol className="ui-thread">
          {asked.map((entry) => (
            <li key={entry.question} className="ui-thread-pair">
              <p className="ui-thread-question">{entry.question}</p>
              {entry.answer === null ? (
                <p className="ui-thinking">調べています。調べ終わると、ここに回答が出ます</p>
              ) : (
                <AiText label="回答">
                  <p>{entry.answer}</p>
                </AiText>
              )}
            </li>
          ))}
        </ol>
      )}
      <form
        className="ui-ask"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          className="ui-ask-input"
          aria-label="この Task について AI に聞く"
          placeholder="この Task について聞く"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="ui-ask-foot">
          <span className="ui-sub">⌘ + Enter で送る</span>
          <Button type="submit" size="sm" tone={draft.trim() === "" ? "secondary" : "primary"} disabled={draft.trim() === ""}>
            聞く
          </Button>
        </div>
      </form>
    </section>
  );
}
