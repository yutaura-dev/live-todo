import { ScreenHead } from "../../design/AppShell.js";
import { Button, Pill, SourceMarks } from "../../design/components.js";
import type { BoardCard } from "../shared/api.js";

const COLUMNS = [
  { name: "Todo", status: "やること" },
  { name: "完了待ち", status: "完了待ち" },
  { name: "完了", status: "終わった" },
] as const;

/** カンバン。列は Task の status の 3 つ。やらないことにした Task は main 側で除いてから届く */
export function Kanban(props: { cards: ReadonlyArray<BoardCard>; selectedId: string | null; onOpen: (id: string) => void; onAdd: () => void }) {
  return (
    <>
      <ScreenHead
        title="カンバン"
        subtitle="Task をどこまで進めたかで並べています"
        actions={
          <Button tone="primary" size="sm" onClick={props.onAdd}>
            Task を足す
          </Button>
        }
      />
      <div className="ui-board">
        {COLUMNS.map((column) => {
          const cards = props.cards.filter((card) => card.status === column.status);
          return (
            <section key={column.name} className="ui-column" aria-labelledby={`col-${column.status}`}>
              <h2 id={`col-${column.status}`} className="ui-column-head">
                {column.name}
                <span className="ui-sub ui-num">{cards.length}</span>
              </h2>
              <ul className="ui-column-cards">
                {cards.map((card) => (
                  <li key={card.id} className={`ui-kcard${column.status === "終わった" ? " ui-kcard--done" : ""}`}>
                    {card.mark !== "なし" && (
                      <div className="ui-row">
                        <Pill tone={card.mark === "新着" ? "ruri" : "seiji"}>{card.mark === "新着" ? "新着" : "更新"}</Pill>
                      </div>
                    )}
                    <button type="button" className="ui-task-open ui-kcard-title" aria-current={props.selectedId === card.id ? "true" : undefined} onClick={() => props.onOpen(card.id)}>
                      {card.title}
                    </button>
                    {card.sources.length > 0 && <SourceMarks sources={[...card.sources]} />}
                    {(card.due || card.priority.level) && (
                      <p className="ui-kcard-foot ui-sub">{[card.due, column.status === "やること" ? card.priority.level : null].filter(Boolean).join("・")}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
