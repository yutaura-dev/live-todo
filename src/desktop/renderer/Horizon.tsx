import type { CSSProperties } from "react";
import { ScreenHead } from "../../design/AppShell.js";
import { Button, Icon, Pill } from "../../design/components.js";
import { rulerOf } from "../../design/ruler.js";
import type { PriorityLevel } from "../../llm/shared/vocabulary.js";
import type { BoardCard } from "../shared/api.js";
import { densityOf, groupForHorizon, type HorizonGroup, LEVELS } from "./horizon-groups.js";

const GROUP_TITLES: Partial<Record<HorizonGroup["key"], string>> = {
  ラベル未定: "いつまでに手を付けるか、決めてください",
  未判定: "アプリが優先度を決めています",
};

const today = () => new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" }).format(new Date());

/** 見通し。開いている Task を「いつまでに手を付けるとよいか」の段に並べる */
export function Horizon(props: {
  cards: ReadonlyArray<BoardCard>;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onSetPriority: (id: string, level: PriorityLevel) => void;
}) {
  return (
    <>
      <ScreenHead
        title={`${today()}の見通し`}
        actions={
          <Button tone="primary" size="sm" onClick={props.onAdd}>
            <Icon name="plus" />
            Task を足す
          </Button>
        }
      />
      <div className="ui-horizon">
        {groupForHorizon(props.cards).map((group) => (
          <Band key={group.key} group={group} {...props} />
        ))}
      </div>
    </>
  );
}

function Band(props: { group: HorizonGroup; selectedId: string | null; onOpen: (id: string) => void; onSetPriority: (id: string, level: PriorityLevel) => void }) {
  const { group } = props;
  const ruler = rulerOf(group.key);
  const density = densityOf(group.key);
  // aria-labelledby は空白で区切って複数の id として読むので、段の名前の空白を除く
  const headingId = `band-${group.key.replaceAll(" ", "")}`;
  const title = GROUP_TITLES[group.key];
  const open = (card: BoardCard) => (
    <button type="button" className="ui-task-open" aria-current={props.selectedId === card.id ? "true" : undefined} onClick={() => props.onOpen(card.id)}>
      {card.title}
    </button>
  );
  const marks = (card: BoardCard) => card.mark !== "なし" && <Pill tone={card.mark === "新着" ? "ruri" : "seiji"}>{card.mark === "新着" ? "新着" : "更新"}</Pill>;

  return (
    <section className={`ui-band ui-band--${density} ui-band--${ruler.tone}`} style={{ "--depth": ruler.depth } as CSSProperties} aria-labelledby={headingId}>
      <div className="ui-ruler">
        <h2 id={headingId} className="ui-ruler-label">
          {ruler.label}
        </h2>
        <span className="ui-ruler-count ui-num" aria-label={`${group.cards.length} 件`}>
          {group.cards.length}
        </span>
      </div>
      {density === "line" ? (
        <details className="ui-disclosure ui-band-fold">
          <summary>
            <Icon name="chevron" />
            <span className="ui-sub">{group.cards.length} 件を見る</span>
          </summary>
          <ul className="ui-titles">
            {group.cards.map((card) => (
              <li key={card.id} className="ui-title-item">
                {open(card)}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <div className="ui-band-body">
          {title && <p className="ui-band-title">{title}</p>}
          {group.cards.length === 0 ? (
            <p className="ui-band-empty">{group.key}に手を付けるものはありません</p>
          ) : (
            <ul className="ui-rows">
              {group.cards.map((card) => (
                <li key={card.id}>
                  {group.key === "ラベル未定" ? (
                    <div className="ui-card ui-card--decide">
                      <div className="ui-card-head">
                        {marks(card)}
                        {open(card)}
                      </div>
                      <div className="ui-segmented" role="group" aria-label={`「${card.title}」にいつまでに手を付けるか`}>
                        {LEVELS.map((level) => (
                          <button key={level} type="button" onClick={() => props.onSetPriority(card.id, level)}>
                            {level}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="ui-row-item">
                      <div className="ui-row-item-text">
                        <div className="ui-row-item-head">
                          {marks(card)}
                          {open(card)}
                        </div>
                        {(card.priority.reason || card.due) && <p className="ui-sub">{[card.due, card.priority.reason].filter(Boolean).join("・")}</p>}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
