import { Button, Pill } from "../../design/components.js";
import type { PlanRow } from "../shared/api.js";
import type { PanelCommand } from "./TaskPanel.js";

const TURN_LABELS = { 番が来ている: "今できる", 番待ち: "番待ち", 済んだ: "済んだ", やらない: "やらない" } as const;
const STATE_CLASS = { 番が来ている: "now", 番待ち: "waiting", 済んだ: "done", やらない: "skipped" } as const;
const HOW_LABELS = { human: null, claude: "Claude Code", condition: "待つ", write: "書き込み", decision: null } as const;

/** 計画。番が来ている Action Item にだけ操作を出す（番待ちのものは、押せても断られるだけなので出さない） */
export function PlanView(props: { rows: ReadonlyArray<PlanRow> | null; open: boolean; onCommand: (command: PanelCommand) => void; onRequestWrite?: (itemId: string) => void }) {
  const { rows } = props;
  const items = rows?.filter((row) => row.kind === "item" || row.kind === "decision") ?? [];
  const done = items.filter((row) => row.turn === "済んだ" || row.turn === "やらない").length;
  return (
    <section className="ui-section" aria-labelledby="plan-title">
      <h3 id="plan-title" className="ui-section-title">
        計画
      </h3>
      {rows === null ? (
        <p className="ui-sub">まだ計画はありません</p>
      ) : (
        <div className="ui-plan">
          <div className="ui-plan-summary">
            <span className="ui-plan-now">
              今できる <strong className="ui-num">{items.filter((row) => row.turn === "番が来ている").length}</strong>
            </span>
            <span className="ui-sub ui-num">
              {items.length} 項目中 {done} 済み
            </span>
          </div>
          <ol className="ui-track">
            {rows.map((row) => (
              <li key={row.id} className={`ui-station ui-station--${row.turn ? STATE_CLASS[row.turn] : "done"}${row.kind === "decision" ? " ui-station--decision" : ""}`} style={{ marginInlineStart: `${row.depth * 1.25}rem` }}>
                <span className="ui-station-mark" aria-hidden="true" />
                <div className="ui-station-body">
                  <div className="ui-station-line">
                    <span>{row.title}</span>
                    {row.turn && row.kind !== "group" && <span className="ui-sub">{TURN_LABELS[row.turn]}</span>}
                    {row.completes && <Pill tone="outline">完了条件</Pill>}
                    {row.how && HOW_LABELS[row.how] && <span className="ui-sub">{HOW_LABELS[row.how]}</span>}
                    {row.added && <Pill tone="seiji">事実から足した</Pill>}
                  </div>
                  {props.open && row.kind === "item" && row.turn === "番が来ている" && (row.how === "human" || row.how === "claude") && (
                    <div className="ui-row">
                      <Button size="sm" tone="primary" onClick={() => props.onCommand({ _tag: "PlanAction", action: { _tag: "CompleteItem", itemId: row.id } })}>
                        済んだ
                      </Button>
                      <Button size="sm" tone="quiet" onClick={() => props.onCommand({ _tag: "PlanAction", action: { _tag: "SkipItem", itemId: row.id } })}>
                        やらない
                      </Button>
                    </div>
                  )}
                  {props.open && row.kind === "item" && row.turn === "番が来ている" && row.how === "write" && props.onRequestWrite && (
                    <Button size="sm" tone="primary" className="ui-self-start" onClick={() => props.onRequestWrite?.(row.id)}>
                      書き込みを頼む
                    </Button>
                  )}
                  {props.open && row.kind === "item" && row.turn === "済んだ" && (row.how === "human" || row.how === "claude") && (
                    <Button size="sm" tone="quiet" className="ui-self-start" onClick={() => props.onCommand({ _tag: "PlanAction", action: { _tag: "ReopenItem", itemId: row.id } })}>
                      戻す
                    </Button>
                  )}
                  {row.kind === "decision" && (
                    <div className="ui-options ui-row" role="group" aria-label={row.title}>
                      {row.options.map((option, index) => (
                        <Button
                          key={option}
                          size="sm"
                          tone={row.chosen === index ? "primary" : "secondary"}
                          disabled={!props.open || row.turn !== "番が来ている"}
                          onClick={() => props.onCommand({ _tag: "PlanAction", action: { _tag: "ChooseOption", itemId: row.id, option: index } })}
                        >
                          {option}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {props.open && (
        <Button size="sm" tone="quiet" className="ui-self-start" onClick={() => props.onCommand({ _tag: "RevisePlan" })}>
          {rows === null ? "計画を立てる" : "計画を立て直す"}
        </Button>
      )}
    </section>
  );
}
