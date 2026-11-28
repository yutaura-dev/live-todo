import { ScreenHead } from "../../design/AppShell.js";
import { Button, Icon, SourceMarks } from "../../design/components.js";
import type { BoardCard, FactView, InboxCommand, InboxView, ProposalView } from "../shared/api.js";

/** 提案。AI が決めきれなかったもの（提案）と、どの Task のものか決められなかった事実を、ユーザーが決める */
export function Proposals(props: { inbox: InboxView; openTasks: ReadonlyArray<BoardCard>; onCommand: (command: InboxCommand) => void }) {
  const open = props.inbox.proposals.filter((p) => p.status === "提案中");
  const declined = props.inbox.proposals.filter((p) => p.status === "見送った");
  return (
    <>
      <ScreenHead title="提案" subtitle="AI が自動では決めなかったものです。Task にするか、見送るかを決めてください" />
      {open.length === 0 && props.inbox.undecided.length === 0 && <p className="ui-empty">いま決めることはありません</p>}
      <div className="ui-stack-8">
        {open.map((proposal) => (
          <ProposalCard key={proposal.id} proposal={proposal} onCommand={props.onCommand} />
        ))}
      </div>
      {props.inbox.undecided.length > 0 && (
        <section className="ui-section" aria-labelledby="undecided-title">
          <h2 id="undecided-title" className="ui-section-title">
            どの Task のものか、決めてください
          </h2>
          <ul className="ui-plain-list">
            {props.inbox.undecided.map((fact) => (
              <UndecidedFact key={fact.id} fact={fact} openTasks={props.openTasks} onCommand={props.onCommand} />
            ))}
          </ul>
        </section>
      )}
      {declined.length > 0 && (
        <details className="ui-disclosure">
          <summary>
            <Icon name="chevron" />
            <span>見送った提案</span>
            <span className="ui-sub ui-num">{declined.length} 件</span>
          </summary>
          <ul className="ui-plain-list">
            {declined.map((proposal) => (
              <li key={proposal.id}>{proposal.title}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Facts({ facts }: { facts: ReadonlyArray<FactView> }) {
  return (
    <ul className="ui-facts">
      {facts.map((fact) => (
        <li key={fact.id} className="ui-fact">
          <SourceMarks sources={[fact.source]} />
          <span className="ui-fact-text">
            <span>{fact.title}</span>
            <span className="ui-sub">{fact.lines.join("・")}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ProposalCard({ proposal, onCommand }: { proposal: ProposalView; onCommand: (command: InboxCommand) => void }) {
  const headingId = `proposal-${proposal.id}`;
  return (
    <article className="ui-card" aria-labelledby={headingId}>
      <p className="ui-sub">{proposal.kind === "新しい Task" ? "新しい Task にしませんか" : `「${proposal.targetTitle ?? "既存の Task"}」の計画に足しませんか`}</p>
      <h3 id={headingId} className="ui-card-head">
        {proposal.title}
      </h3>
      <p>{proposal.brief}</p>
      <Facts facts={proposal.facts} />
      <div className="ui-row">
        <Button tone="primary" size="sm" onClick={() => onCommand({ _tag: "AcceptProposal", id: proposal.id })}>
          {proposal.kind === "新しい Task" ? "Task にする" : "計画に足す"}
        </Button>
        <Button tone="quiet" size="sm" onClick={() => onCommand({ _tag: "DeclineProposal", id: proposal.id })}>
          見送る
        </Button>
      </div>
    </article>
  );
}

function UndecidedFact({ fact, openTasks, onCommand }: { fact: FactView; openTasks: ReadonlyArray<BoardCard>; onCommand: (command: InboxCommand) => void }) {
  const selectId = `attach-${fact.id}`;
  return (
    <li className="ui-row ui-row--split">
      <span className="ui-row">
        <SourceMarks sources={[fact.source]} />
        <span>{fact.title}</span>
      </span>
      <span className="ui-row">
        <Button size="sm" onClick={() => onCommand({ _tag: "RouteFact", id: fact.id, to: { _tag: "NewTask" } })}>
          新しい Task にする
        </Button>
        {openTasks.length > 0 && (
          <label className="ui-select" htmlFor={selectId}>
            <span className="ui-visually-hidden">「{fact.title}」を持たせる Task</span>
            <select id={selectId} value="" onChange={(event) => event.target.value !== "" && onCommand({ _tag: "RouteFact", id: fact.id, to: { _tag: "AttachTo", taskId: event.target.value } })}>
              <option value="">既存の Task に持たせる</option>
              {openTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button tone="quiet" size="sm" onClick={() => onCommand({ _tag: "RouteFact", id: fact.id, to: { _tag: "Ignore" } })}>
          対象外にする
        </Button>
      </span>
    </li>
  );
}
