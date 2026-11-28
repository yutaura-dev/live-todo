import { recurringPreviews, tasks as sampleTasks } from "../../wireframes/fixtures.js";
import { attentionOf } from "../../wireframes/horizon.js";
import type { WireTask } from "../../wireframes/model.js";
import { AppShell, ScreenHead, type View } from "../AppShell.js";
import { AttentionPill, Button, Pill, SourceMarks, WorkingPill } from "../components.js";

type Card = { id: number; title: string; sources: string[]; task?: WireTask };

const DONE: Card[] = [
  { id: 90, title: "週報を書く", sources: ["notion"] },
  { id: 91, title: "PR #470 をレビューする", sources: ["github"] },
];

/**
 * カンバン。列は Task の status の 3 つ（Todo・完了待ち・完了）で、やらないことにした・別の Task にまとめた Task は出さない。
 * 要確認の列はない（Task はやると決まったものだけ。迷ったものは提案の画面に出る。ADR-0025）。
 * AI が作業中かは列にせず、カードの印で見せる（AI の作業では列が変わらないため）。
 * 見通しと違い、ここは「どこまで進めたか」を見る場所なので、優先度は小さな印にとどめる。
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
    <AppShell current="カンバン" {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}>
      <ScreenHead title="カンバン" subtitle="Task をどこまで進めたかで並べています。カードをドラッグすると列を移せます" />
      <div className="ui-board">
        {columns.map((column) => (
          <section key={column.name} className="ui-column" aria-labelledby={`ui-col-${column.name}`}>
            <h2 id={`ui-col-${column.name}`} className="ui-column-head">
              {column.name}
              <span className="ui-sub ui-num">{column.cards.length}</span>
            </h2>
            <ul className="ui-column-cards">
              {column.name === "Todo" &&
                recurringPreviews.map((preview) => (
                  <li key={preview.ruleId} className="ui-kcard ui-kcard--preview">
                    <p className="ui-sub">定期の Task の予告</p>
                    <p className="ui-kcard-title">{preview.title}</p>
                    <p className="ui-sub">{preview.createOn}に作ります</p>
                    <Button tone="quiet" size="sm" className="ui-self-start">
                      今すぐ作る
                    </Button>
                  </li>
                ))}
              {column.cards.map((card) => {
                const task = card.task;
                const level = task?.priority?.status === "アプリが決めた" || task?.priority?.status === "ユーザーが決めた" ? task.priority.level : null;
                return (
                  <li key={card.id} className={`ui-kcard${task?.work === "作業中" ? " ui-kcard--working" : ""}${column.name === "完了" ? " ui-kcard--done" : ""}`} draggable={column.name !== "完了"}>
                    {task && (attentionOf(task).kind !== "なし" || task.work === "作業中") && (
                      <div className="ui-row">
                        <AttentionPill attention={attentionOf(task)} />
                        {task.work === "作業中" && <WorkingPill />}
                      </div>
                    )}
                    <p className="ui-kcard-title">{card.title}</p>
                    <div className="ui-kcard-foot">
                      <SourceMarks sources={card.sources} />
                      {task?.priority?.status === "ラベル未定" && <Pill tone="ruri">優先度を決めてください</Pill>}
                      {level && <span className="ui-sub">{level}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
