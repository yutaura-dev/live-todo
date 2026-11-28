import { recurringPreviews, tasks as sampleTasks } from "../fixtures.js";
import { attentionOf } from "../horizon.js";
import type { WireTask } from "../model.js";
import { AttentionMark, Button, Mark, WorkingMark } from "../parts.js";
import { AppFrame, ScreenHead, type View } from "./AppFrame.js";

type Card = { id: number; title: string; sources: string[]; task?: WireTask };

const DONE: Card[] = [
  { id: 90, title: "週報を書く", sources: ["notion"] },
  { id: 91, title: "PR #470 をレビューする", sources: ["github"] },
];

/**
 * カンバン（specs/task.spec.ts の status）。列は Todo・完了待ち・完了 の 3 つで、やらないことにした・別の Task にまとめた Task は出さない。
 * AI が作業中かは列にせず、カードの模様で見せる（work は status と別の軸で、AI の作業では列が変わらないため）。
 */
export function Board(props: { tasks?: WireTask[]; onNavigate?: (view: View) => void }) {
  const list = props.tasks ?? sampleTasks;
  const toCard = (task: WireTask): Card => ({ id: task.id, title: task.title, sources: task.sources, task });
  const columns: Array<{ name: string; cards: Card[] }> = [
    { name: "Todo", cards: list.filter((task) => task.status === "todo").map(toCard) },
    { name: "完了待ち", cards: [{ id: 104, title: "来週の定例のアジェンダに返事をする", sources: ["slack"] }] },
    { name: "完了", cards: DONE },
  ];
  return (
    <AppFrame current="カンバン" {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}>
      <ScreenHead title="カンバン" subtitle="Task をどこまで進めたかで並べています" />
      <div className="wf-board">
        {columns.map((column) => (
          <section key={column.name} className="wf-column" aria-labelledby={`wf-col-${column.name}`}>
            <h2 id={`wf-col-${column.name}`} className="wf-column-head">
              <span>
                {column.name} {column.name === "Todo" && <Mark n={1} />}
              </span>
              <span className="wf-horizon-count">{column.cards.length}</span>
            </h2>
            <ul className="wf-stack" style={{ gap: 8 }}>
              {column.name === "Todo" &&
                recurringPreviews.map((preview) => (
                  <li key={preview.ruleId} className="wf-card wf-card--preview">
                    <span className="wf-task-top">
                      <span className="wf-pill wf-pill--ai">定期の Task の予告</span>
                      <Mark n={3} />
                    </span>
                    <p className="wf-task-title" style={{ fontSize: 15 }}>
                      {preview.title}
                    </p>
                    <p className="wf-sub">{preview.createOn}に作ります</p>
                    <Button tone="quiet">今すぐ作る</Button>
                  </li>
                ))}
              {column.cards.map((card) => (
                <li key={card.id} className={`wf-card${card.task?.work === "作業中" ? " wf-card--working" : ""}`}>
                  <div className="wf-task-top">
                    {card.task && <AttentionMark attention={attentionOf(card.task)} />}
                    {card.task?.work === "作業中" && (
                      <>
                        <WorkingMark />
                        <Mark n={2} />
                      </>
                    )}
                    {card.task?.priority?.status === "ラベル未定" && <span className="wf-pill wf-pill--mine">ラベル未定</span>}
                    {(card.task?.priority?.status === "アプリが決めた" || card.task?.priority?.status === "ユーザーが決めた") && <span className="wf-pill">{card.task.priority.level}</span>}
                  </div>
                  <p className="wf-task-title" style={{ fontSize: 15 }}>
                    {card.title}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </AppFrame>
  );
}

export const BOARD_NOTES = [
  { n: 1, text: "列は Task の status の 3 つ（Todo・完了待ち・完了）。Task はやると決まったものだけなので、要確認の列はない（迷ったものは提案の画面に出る）。やらないことにした・別の Task にまとめた Task は出さない（まとめた Task は、まとめ先の履歴から開ける）" },
  { n: 2, text: "AI の作業は列にせず、破線と「AI 作業中」で見せる（AI の作業では列が変わらない）。作業中でも完了・やらないことにするはできる（「作業を止めますか」と確かめる）" },
  { n: 3, text: "定期の Task の予告は本当の Task ではないので、動かせない・消せない。「今すぐ作る」で待たずに作れる" },
];

export const BOARD_QUESTIONS: string[] = [];
