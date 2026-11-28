import { aspectsOf, choose, complete, hasRunningWork, progressOf, rechoose, reopenItem, turnsOf, type PlanDecision, type PlanGroup, type PlanItem, type PlanNode, type Turn } from "../../wireframes/plan/plan.js";
import { Button, Icon, Pill, StopWorkButton } from "../components.js";

type Ctx = { turns: Map<string, Turn>; act: (next: PlanGroup) => void; plan: PlanGroup };

const joinJa = (head: string, tail: string) => (/^[A-Za-z0-9]/.test(tail) ? `${head} ${tail}` : `${head}${tail}`);

/**
 * 計画。直列は 1 本の線路でつなぎ、並列は線路を分けた囲みにし、分かれ道は菱形の駅から枝を出す。
 * 番が来ている項目だけを瑠璃の駅と白いカードにし、操作もそこにだけ出す。
 * 手順に番号を振らない理由: 並列や枝があると番号の順に進むとは限らず、番号がかえって誤解を招くため。
 */
export function Plan({ plan, onChange }: { plan: PlanGroup; onChange: (next: PlanGroup) => void }) {
  const ctx: Ctx = { turns: turnsOf(plan), act: onChange, plan };
  const progress = progressOf(plan);
  return (
    <div className="ui-plan">
      <div className="ui-plan-summary">
        <span className="ui-plan-now">
          今できる <strong className="ui-num">{progress.now}</strong>
        </span>
        <span className="ui-sub ui-num">
          {progress.total} 項目中 {progress.done} 済み
        </span>
        <span className="ui-plan-meter" aria-hidden="true">
          <span style={{ inlineSize: `${progress.total === 0 ? 0 : (progress.done / progress.total) * 100}%` }} />
        </span>
      </div>
      <Track group={plan} ctx={ctx} />
    </div>
  );
}

function Track({ group, ctx }: { group: PlanGroup; ctx: Ctx }) {
  const items = group.arrangement === "serial" ? group.items : [group];
  return (
    <ol className="ui-track">
      {items.map((node, index) => (
        <Station key={keyOf(node, index)} node={node} ctx={ctx} />
      ))}
    </ol>
  );
}

const keyOf = (node: PlanNode, index: number) => (node.type === "item" || node.type === "decision" ? node.id : `${node.type}-${index}`);

function stateOf(node: PlanNode, ctx: Ctx): Turn {
  if (node.type === "item" || node.type === "decision") return ctx.turns.get(node.id) ?? { state: "番待ち", waitingOn: [] };
  if (node.type === "effect") return { state: "済んだ", waitingOn: [] };
  const children = node.items.filter((child) => child.type !== "effect").map((child) => stateOf(child, ctx));
  if (children.some((child) => child.state === "番が来ている")) return { state: "番が来ている", waitingOn: [] };
  const waiting = children.find((child) => child.state === "番待ち");
  if (waiting) return waiting;
  return children.every((child) => child.state === "やらない") ? { state: "やらない", waitingOn: [] } : { state: "済んだ", waitingOn: [] };
}

const STATE_CLASS: Record<Turn["state"], string> = { 済んだ: "done", やらない: "skipped", 番が来ている: "now", 番待ち: "waiting" };

/** 線路の上の 1 駅。駅の形が項目の種類（丸: 項目 / 菱形: 分かれ道 / 二重線: 並列 / 四角: 完了したら） */
function Station({ node, ctx }: { node: PlanNode; ctx: Ctx }) {
  const turn = stateOf(node, ctx);
  const shape = node.type === "decision" ? "decision" : node.type === "group" ? "parallel" : node.type === "effect" ? "effect" : "item";
  return (
    <li className={`ui-station ui-station--${STATE_CLASS[turn.state]} ui-station--${shape}`}>
      <span className="ui-station-mark" aria-hidden="true">
        {turn.state === "済んだ" && shape !== "effect" && <Icon name="check" size={12} />}
      </span>
      <div className="ui-station-body">
        {node.type === "item" && <Item item={node} turn={turn} ctx={ctx} />}
        {node.type === "decision" && <Decision decision={node} turn={turn} ctx={ctx} />}
        {node.type === "group" && <Parallel group={node} turn={turn} ctx={ctx} />}
        {node.type === "effect" && (
          <p className="ui-effect">
            <span className="ui-sub">完了したら</span> {node.title}
          </p>
        )}
      </div>
    </li>
  );
}

function Waiting({ turn }: { turn: Turn }) {
  if (turn.waitingOn.length === 0) return null;
  return (
    <p className="ui-waiting">
      「{turn.waitingOn[0]}」{turn.waitingOn.length > 1 && `ほか ${turn.waitingOn.length - 1} 件`}のあと
    </p>
  );
}

function Item({ item, turn, ctx }: { item: PlanItem; turn: Turn; ctx: Ctx }) {
  if (turn.state === "済んだ" || turn.state === "やらない") {
    const canReopen = turn.state === "済んだ" && (item.how === "human" || item.how === "claude");
    return (
      <p className="ui-station-line">
        <span className="ui-station-done">{item.title}</span>
        {turn.state === "やらない" && <span className="ui-sub">やらない</span>}
        {canReopen && (
          <Button tone="quiet" size="sm" className="ui-reopen" onClick={() => ctx.act(reopenItem(ctx.plan, item.id))}>
            戻す
          </Button>
        )}
      </p>
    );
  }
  if (turn.state === "番待ち") {
    return (
      <div className="ui-station-later">
        <p className="ui-station-line">
          <span>{item.title}</span>
          {item.due && <span className="ui-due">{item.due}</span>}
        </p>
        <Waiting turn={turn} />
        {item.condition?.expectedWait && <p className="ui-sub">見込み {item.condition.expectedWait}</p>}
        <AddedFrom item={item} />
        {item.how === "claude" && item.run && <p className="ui-sub">Claude Code に先に頼んであります</p>}
      </div>
    );
  }
  const busy = item.run?.state === "やっている" || item.run?.state === "判断中" || (item.how === "condition" && item.condition?.observed !== "達成できない");
  return (
    <div className={`ui-stop${busy ? " ui-stop--busy" : ""}`}>
      <p className="ui-stop-title">
        <span>{item.title}</span>
        {item.due && <span className="ui-due">{item.due}</span>}
      </p>
      {item.condition?.expectedWait && <p className="ui-sub">見込み {item.condition.expectedWait}</p>}
      <AddedFrom item={item} />
      <ItemActions item={item} ctx={ctx} />
    </div>
  );
}

/** 事実から計画に足した項目には、もとの事実と「切り出す」を添える（寄せすぎを 1 回の操作で直せるように。ADR-0025） */
function AddedFrom({ item }: { item: PlanItem }) {
  if (!item.addedFrom) return null;
  return (
    <p className="ui-added">
      <span>「{item.addedFrom}」から足した</span>
      <Button tone="quiet" size="sm">
        別の Task に切り出す
      </Button>
    </p>
  );
}

function ItemActions({ item, ctx }: { item: PlanItem; ctx: Ctx }) {
  const done = () => ctx.act(complete(ctx.plan, item.id));
  if (item.how === "claude") {
    const run = item.run;
    if (run?.state === "待ち行列")
      return (
        <div className="ui-row">
          <Pill tone="seiji">順番待ち（{run.position} 番目）</Pill>
          <Button tone="quiet" size="sm">
            頼むのを取り消す
          </Button>
        </div>
      );
    if (run?.state === "やっている" || run?.state === "判断中")
      return (
        <div className="ui-row ui-row--split">
          <span className="ui-seiji ui-working-line">
            <span className="ui-pill-pulse" aria-hidden="true" />
            Claude Code が作業中
          </span>
          <StopWorkButton label="止める" size="sm" what={item.title} onConfirm={() => undefined} />
        </div>
      );
    if (run?.state === "止まった" || run?.state === "元の項目が変わった")
      return (
        <div className="ui-stack-8">
          <p className="ui-sub">{run.state === "止まった" ? `止まりました（${run.reason}）` : "頼んだあとに元の項目が変わりました"}</p>
          <div className="ui-row">
            <Button tone="primary" size="sm">
              もう一度 Claude Code に頼む
            </Button>
            <Button size="sm">報告を見る</Button>
            {run.state === "止まった" && (
              <Button tone="quiet" size="sm" onClick={done}>
                自分で済ませた
              </Button>
            )}
          </div>
        </div>
      );
    return (
      <div className="ui-row">
        <Button tone="primary" size="sm">
          Claude Code に頼む
        </Button>
        <Button tone="quiet" size="sm" onClick={done}>
          自分で済ませた
        </Button>
      </div>
    );
  }
  if (item.how === "condition") {
    if (item.condition?.observed === "達成できない") return <p className="ui-sub">待っていた対象がなくなりました</p>;
    return <p className="ui-sub">{item.condition?.label ? `「${item.condition.label}」を見張っています` : "見張っています"}</p>;
  }
  // 書き込む中身が見えていれば、「頼む」と「承認」を 1 回の押下にまとめてよい（中身を見てから承認する、という決まりは守れる）
  if (item.how === "write")
    return item.write ? (
      <div className="ui-stack-8">
        <p className="ui-write-summary">{item.write.summary}</p>
        <div className="ui-row">
          <Button tone="primary" size="sm" onClick={done}>
            {joinJa("承認して", item.write.verb)}
          </Button>
        </div>
      </div>
    ) : (
      <div className="ui-row">
        <Button tone="primary" size="sm">
          書き込みを頼む
        </Button>
      </div>
    );
  return (
    <div className="ui-row">
      <Button tone="primary" size="sm" onClick={done}>
        <Icon name="check" size={14} />
        済んだ
      </Button>
      {item.place && (
        <Button size="sm">
          <Icon name="open" size={14} />
          {item.place.label}
        </Button>
      )}
    </div>
  );
}

function Parallel({ group, turn, ctx }: { group: PlanGroup; turn: Turn; ctx: Ctx }) {
  return (
    <div className={`ui-parallel${turn.state === "番待ち" ? " ui-parallel--later" : ""}`}>
      <p className="ui-parallel-head">どれからでも</p>
      {turn.state === "番待ち" && <Waiting turn={turn} />}
      <ul className="ui-lanes">
        {group.items.map((child, index) => (
          <li key={keyOf(child, index)} className="ui-lane">
            <Lane node={child} ctx={ctx} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Lane({ node, ctx }: { node: PlanNode; ctx: Ctx }) {
  if (node.type === "group") {
    const lane = progressOf(node);
    return (
      <div className="ui-stack-4">
        <p className="ui-sub ui-num">
          {lane.done} / {lane.total} 済み
        </p>
        <Track group={node} ctx={ctx} />
      </div>
    );
  }
  if (node.type === "item") return <Item item={node} turn={stateOf(node, ctx)} ctx={ctx} />;
  if (node.type === "decision") return <Decision decision={node} turn={stateOf(node, ctx)} ctx={ctx} />;
  return (
    <p className="ui-effect">
      <span className="ui-sub">完了したら</span> {node.title}
    </p>
  );
}

function Decision({ decision, turn, ctx }: { decision: PlanDecision; turn: Turn; ctx: Ctx }) {
  const active = decision.branches.find((branch) => branch.state === "進めている");
  const abandoned = decision.branches.filter((branch) => branch.state === "取りやめた");

  if (decision.status === "done" && active) {
    const redo = () => ctx.act(rechoose(ctx.plan, decision.id));
    return (
      <div className="ui-decision ui-decision--chosen">
        <p className="ui-station-line">
          <span className="ui-station-done">{decision.title}</span>
          <span className="ui-chosen">{active.option}</span>
          {active.plan && hasRunningWork(active.plan) ? (
            <StopWorkButton label="選び直す" size="sm" what={`枝「${active.option}」で作業しています`} onConfirm={redo} />
          ) : (
            <Button tone="quiet" size="sm" className="ui-reopen" onClick={redo}>
              選び直す
            </Button>
          )}
        </p>
        <div className="ui-branch">
          {active.plan ? <Track group={active.plan} ctx={ctx} /> : <p className="ui-thinking">AI がこの先の計画を考えています</p>}
        </div>
        <Abandoned branches={abandoned} ctx={ctx} />
      </div>
    );
  }

  const canChoose = turn.state === "番が来ている";
  const body = (
    <div className="ui-decision-body">
      {decision.question && <p className="ui-decision-question">{decision.question}</p>}
      {decision.kind === "確かめる" ? (
        <div className="ui-howto">
          <p className="ui-howto-label">確かめ方</p>
          <p>{decision.howToCheck}</p>
        </div>
      ) : decision.recommendation ? (
        <div className="ui-ai">
          <p className="ui-ai-label">AI のおすすめ</p>
          <p className="ui-ai-body">
            <strong>{decision.recommendation.label}</strong>　{decision.recommendation.reason}
          </p>
        </div>
      ) : (
        <p className="ui-sub">AI はおすすめを決めきれませんでした</p>
      )}
      {decision.kind === "選ぶ" && (
        <p className="ui-aspects">
          <span className="ui-sub">比べること</span>
          {aspectsOf(decision.options).map((aspect) => (
            <span key={aspect} className="ui-aspect">
              {aspect}
            </span>
          ))}
        </p>
      )}
      <ul className="ui-options">
        {decision.options.map((option) => {
          const recommended = decision.recommendation?.label === option.label;
          return (
            <li key={option.label} className={`ui-option${recommended ? " ui-option--recommended" : ""}`}>
              <p className="ui-option-head">
                <strong>{option.label}</strong>
                {recommended && <Pill tone="seiji">おすすめ</Pill>}
              </p>
              {(option.gains.length > 0 || option.costs.length > 0) && (
                <ul className="ui-tradeoffs" aria-label={`「${option.label}」を選ぶと`}>
                  {option.gains.map((gain) => (
                    <li key={gain.aspect + gain.detail} className="ui-tradeoff ui-tradeoff--gain">
                      <span className="ui-tradeoff-sign" aria-label="得るもの">
                        ＋
                      </span>
                      <span className="ui-tradeoff-aspect">{gain.aspect}</span>
                      <span>{gain.detail}</span>
                    </li>
                  ))}
                  {option.costs.map((cost) => (
                    <li key={cost.aspect + cost.detail} className="ui-tradeoff ui-tradeoff--cost">
                      <span className="ui-tradeoff-sign" aria-label="失うもの">
                        −
                      </span>
                      <span className="ui-tradeoff-aspect">{cost.aspect}</span>
                      <span>{cost.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              {option.unclear.length > 0 && <p className="ui-sub">判断できなかった観点: {option.unclear.join("、")}</p>}
              <p className="ui-option-then">
                {option.then.type === "planned" ? `このあと: ${titlesOf(option.then.plan).join(" → ")}` : "このあと: AI が計画を考える"}
              </p>
              {canChoose && (
                <Button tone={recommended ? "primary" : "secondary"} size="sm" onClick={() => ctx.act(choose(ctx.plan, decision.id, option.label))}>
                  これにする
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );

  if (!canChoose) {
    // 番待ちの分かれ道は、まだ選べない将来の分かれ道なので、題と「〇〇のあと」だけを出して閉じておく
    return (
      <div className="ui-decision ui-decision--later">
        <p className="ui-station-line">{decision.title}</p>
        <Waiting turn={turn} />
        <details className="ui-disclosure ui-fold">
          <summary>
            <Icon name="chevron" size={14} />
            <span className="ui-sub ui-num">選択肢を見る（{decision.options.length} 件）</span>
          </summary>
          {body}
        </details>
        <Abandoned branches={abandoned} ctx={ctx} />
      </div>
    );
  }
  return (
    <div className="ui-decision ui-decision--now">
      <p className="ui-stop-title">{decision.title}</p>
      {body}
      <Abandoned branches={abandoned} ctx={ctx} />
    </div>
  );
}

function Abandoned({ branches, ctx }: { branches: PlanDecision["branches"]; ctx: Ctx }) {
  if (branches.length === 0) return null;
  return (
    <details className="ui-disclosure ui-fold">
      <summary>
        <Icon name="chevron" size={14} />
        <span className="ui-sub ui-num">取りやめた枝 {branches.length} 本</span>
      </summary>
      {branches.map((branch, index) => (
        <div key={`${branch.option}-${index}`} className="ui-branch ui-branch--abandoned">
          <p className="ui-sub">「{branch.option}」（取りやめた）</p>
          {branch.plan ? <Track group={branch.plan} ctx={ctx} /> : <p className="ui-sub">計画を考える前に取りやめた</p>}
        </div>
      ))}
    </details>
  );
}

function titlesOf(node: PlanNode): string[] {
  if (node.type === "item" || node.type === "decision") return [node.title];
  if (node.type === "group") return node.items.flatMap(titlesOf);
  return [`完了したら ${node.title}`];
}
