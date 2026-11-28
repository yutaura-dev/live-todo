import { useState } from "react";
import { Button, Pill } from "../../design/components.js";
import type { AgentRunView } from "../shared/api.js";

const STATUS_TONE = { 待ち行列: "outline", やっている: "ruri", 判断中: "ruri", 終わった: "seiji", 止まった: "bengara", 取り消した: "outline" } as const;

/** Task について Claude Code に頼んだ作業（agent-run.spec）。答えは Task の言葉にもなるが、元の答えもここで読める */
export function AgentSection(props: {
  runs: ReadonlyArray<AgentRunView>;
  open: boolean;
  onAsk: (request: string) => void;
  onStop: (runId: string) => void;
  onCancel: (runId: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const ask = () => {
    props.onAsk(question.trim());
    setQuestion("");
  };
  return (
    <section className="ui-section" aria-labelledby="agent-title">
      <h3 id="agent-title" className="ui-section-title">
        Claude Code
      </h3>
      {props.runs.length > 0 && (
        <ol className="ui-stack-4">
          {props.runs.map((run) => (
            <AgentRunRow key={run.id} run={run} onStop={props.onStop} onCancel={props.onCancel} />
          ))}
        </ol>
      )}
      {props.open && (
        <div className="ui-stack-4">
          <label className="ui-field">
            Claude Code に聞くこと
            <textarea className="ui-input" rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} />
          </label>
          <p className="ui-sub">調べて答えるだけで、ファイルを直したり外へ書き込んだりはしません</p>
          <Button size="sm" tone="primary" className="ui-self-start" disabled={question.trim() === ""} onClick={ask}>
            聞く
          </Button>
        </div>
      )}
    </section>
  );
}

function AgentRunRow(props: { run: AgentRunView; onStop: (runId: string) => void; onCancel: (runId: string) => void }) {
  const { run } = props;
  const [confirming, setConfirming] = useState(false);
  const active = run.status === "やっている" || run.status === "判断中";
  return (
    <li className="ui-stack-4">
      <div className="ui-row">
        <span>{run.request}</span>
        <Pill tone={STATUS_TONE[run.status]}>{run.status}</Pill>
        {run.stopReason && <span className="ui-sub">{run.stopReason}</span>}
      </div>
      {active && run.progress.length > 0 && <p className="ui-sub">{run.progress.at(-1)}</p>}
      {run.result && <p>{run.result}</p>}
      {run.status === "待ち行列" && (
        <Button size="sm" tone="quiet" className="ui-self-start" onClick={() => props.onCancel(run.id)}>
          取り消す
        </Button>
      )}
      {active &&
        (confirming ? (
          <div className="ui-stack-4" role="alert">
            <p className="ui-sub">止めると、Claude Code は途中で終わります。途中までの様子はここに残ります</p>
            <div className="ui-row">
              <Button size="sm" tone="primary" onClick={() => props.onStop(run.id)}>
                止めることにする
              </Button>
              <Button size="sm" tone="quiet" onClick={() => setConfirming(false)}>
                続けさせる
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" tone="quiet" className="ui-self-start" onClick={() => setConfirming(true)}>
            止める
          </Button>
        ))}
    </li>
  );
}
