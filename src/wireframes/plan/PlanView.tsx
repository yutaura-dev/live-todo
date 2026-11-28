import type { ReactNode } from "react";
import { Button, joinJa, Mark, StopWorkButton } from "../parts.js";
import { aspectsOf, choose, complete, hasRunningWork, progressOf, rechoose, reopenItem, turnsOf, type PlanDecision, type PlanGroup, type PlanItem, type PlanNode, type Turn } from "./plan.js";

/** markOnce: 注釈の番号を、最初に現れた 1 か所にだけ付ける（同じ種類の項目が並んでも番号を繰り返さない） */
type Ctx = { turns: Map<string, Turn>; act: (next: PlanGroup) => void; plan: PlanGroup; markOnce: (n: number) => ReactNode };

/**
 * 計画（specs/task.spec.ts の Plan）。直列は縦の線でつなぎ、並列は 1 つの囲みに横に並べ、分かれ道は枝として字下げする。
 * 番が来ている項目だけを大きく黒くし、番待ちの項目には「何を待っているか」を名指しで出す。
 * 手順に番号を振らない理由: 並列や枝があると番号の順に進むとは限らず、番号がかえって誤解を招くため。
 */
export function Plan({ plan, onChange, annotate = false }: { plan: PlanGroup; onChange: (next: PlanGroup) => void; annotate?: boolean }) {
  const marked = new Set<number>();
  const markOnce = (n: number) => {
    if (!annotate || marked.has(n)) return null;
    marked.add(n);
    return <Mark n={n} />;
  };
  const ctx: Ctx = { turns: turnsOf(plan), act: onChange, plan, markOnce };
  const progress = progressOf(plan);
  return (
    <div className="wf-plan">
      <p className="wf-plan-summary">
        <span className="wf-pill wf-pill--mine">今できる {progress.now}</span>
        <span className="wf-sub">
          {progress.total} 項目中 {progress.done} 済み
        </span>
        {markOnce(1)}
      </p>
      <Track group={plan} ctx={ctx} />
    </div>
  );
}

function Track({ group, ctx }: { group: PlanGroup; ctx: Ctx }) {
  const items = group.arrangement === "serial" ? group.items : [group];
  return (
    <ol className="wf-track">
      {items.map((node, index) => (
        <Node key={keyOf(node, index)} node={node} ctx={ctx} />
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

const MARKER_CLASS: Record<Turn["state"], string> = { 済んだ: "done", やらない: "skipped", 番が来ている: "now", 番待ち: "waiting" };

function Node({ node, ctx }: { node: PlanNode; ctx: Ctx }) {
  const turn = stateOf(node, ctx);
  const shape = node.type === "decision" ? "decision" : node.type === "group" ? "parallel" : node.type === "effect" ? "effect" : "item";
  return (
    <li className={`wf-node wf-node--${MARKER_CLASS[turn.state]}`}>
      <span className={`wf-marker wf-marker--${shape}`} aria-hidden="true">
        <span>{markerText(shape, turn.state)}</span>
      </span>
      <div className="wf-node-body">
        {node.type === "item" && <Item item={node} turn={turn} ctx={ctx} />}
        {node.type === "decision" && <Decision decision={node} turn={turn} ctx={ctx} />}
        {node.type === "group" && <Parallel group={node} turn={turn} ctx={ctx} />}
        {node.type === "effect" && (
          <p className="wf-node-line">
            <span className="wf-task-reason">完了したら</span> {node.title}
          </p>
        )}
      </div>
    </li>
  );
}

function markerText(shape: string, state: Turn["state"]) {
  if (shape === "effect") return "完";
  if (state === "済んだ") return "✓";
  if (state === "番が来ている") return "今";
  if (state === "やらない") return "−";
  return "";
}

function Waiting({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  return (
    <p className="wf-waiting">
      {ctx.markOnce(3)}
      <span className="wf-sub">
        「{turn.waitingOn[0]}」{turn.waitingOn.length > 1 && `ほか ${turn.waitingOn.length - 1} 件`}のあと
      </span>
    </p>
  );
}

/** 項目に添えるのは、自分の行動を変えるものだけ（期日）。何で果たすか・手間・自動か・完了条件かは、ボタンの文言とアプリの判断に任せて出さない */
function Tags({ item }: { item: PlanItem }) {
  return item.due ? <span className="wf-pill wf-pill--quiet">{item.due}</span> : null;
}

/**
 * 事実から計画に足した項目には、もとの事実と「切り出す」を添える（寄せすぎて、この Task が終わっても残る項目だったら、1 回の操作で別の Task にできる）
 */
function AddedFrom({ item, ctx }: { item: PlanItem; ctx: Ctx }) {
  if (!item.addedFrom) return null;
  return (
    <p className="wf-task-top">
      <span className="wf-sub">「{item.addedFrom}」から足した</span>
      <Button tone="quiet">別の Task に切り出す</Button>
      {ctx.markOnce(9)}
    </p>
  );
}

/** 待つ条件は、待つ見込みが分かるときだけ添える */
function ConditionLine({ item }: { item: PlanItem }) {
  if (!item.condition?.expectedWait) return null;
  return <p className="wf-sub">見込み {item.condition.expectedWait}</p>;
}

function Item({ item, turn, ctx }: { item: PlanItem; turn: Turn; ctx: Ctx }) {
  if (turn.state === "済んだ" || turn.state === "やらない") {
    const canReopen = turn.state === "済んだ" && (item.how === "human" || item.how === "claude");
    return (
      <p className="wf-node-line">
        <span className="wf-node-done">{item.title}</span>
        {turn.state === "やらない" && <span className="wf-sub">やらない</span>}
        {canReopen && (
          <Button tone="quiet" onClick={() => ctx.act(reopenItem(ctx.plan, item.id))}>
            戻す
          </Button>
        )}
      </p>
    );
  }
  if (turn.state === "番待ち") {
    return (
      <div className="wf-node-card wf-node-card--waiting">
        <div className="wf-node-head">
          <span>{item.title}</span>
          <Tags item={item} />
        </div>
        <ConditionLine item={item} />
        <AddedFrom item={item} ctx={ctx} />
        <Waiting turn={turn} ctx={ctx} />
        {item.how === "claude" && item.run && <p className="wf-sub">Claude Code に先に頼んであります</p>}
      </div>
    );
  }
  const busy = item.run?.state === "やっている" || item.run?.state === "判断中" || item.run?.state === "待ち行列" || (item.how === "condition" && item.condition?.observed !== "達成できない");
  return (
    <div className={`wf-node-card wf-node-card--now${busy ? " wf-node-card--busy" : ""}`}>
      <div className="wf-node-head">
        <strong className="wf-node-title">
          {item.title} {ctx.markOnce(2)}
        </strong>
        <Tags item={item} />
      </div>
      <ConditionLine item={item} />
      <AddedFrom item={item} ctx={ctx} />
      <ItemActions item={item} ctx={ctx} />
    </div>
  );
}


function ItemActions({ item, ctx }: { item: PlanItem; ctx: Ctx }) {
  const done = () => ctx.act(complete(ctx.plan, item.id));
  if (item.how === "claude") {
    const run = item.run;
    if (run?.state === "待ち行列")
      return (
        <div className="wf-button-row">
          <span className="wf-pill wf-pill--waiting">順番待ち（{run.position} 番目）</span>
          <Button tone="quiet">頼むのを取り消す</Button>
        </div>
      );
    if (run?.state === "やっている" || run?.state === "判断中")
      return (
        <div className="wf-button-row">
          <span className="wf-sub">Claude Code が作業中</span>
          <StopWorkButton label="止める" what={item.title} onConfirm={() => undefined} />
        </div>
      );
    if (run?.state === "止まった")
      return (
        <div className="wf-stack" style={{ gap: 8 }}>
          <p className="wf-sub">止まりました（{run.reason}）</p>
          <div className="wf-button-row">
            <Button tone="primary">もう一度 Claude Code に頼む</Button>
            <Button>報告を見る</Button>
            <Button tone="quiet" onClick={done}>
              自分で済ませた
            </Button>
          </div>
        </div>
      );
    if (run?.state === "元の項目が変わった")
      return (
        <div className="wf-stack" style={{ gap: 8 }}>
          <p className="wf-sub">頼んだあとに元の項目が変わりました</p>
          <div className="wf-button-row">
            <Button tone="primary">もう一度 Claude Code に頼む</Button>
            <Button>報告を見る</Button>
          </div>
        </div>
      );
    return (
      <div className="wf-button-row">
        <Button tone="primary">Claude Code に頼む</Button>
        <Button tone="quiet" onClick={done}>
          自分で済ませた
        </Button>
      </div>
    );
  }
  if (item.how === "condition") {
    if (item.condition?.observed === "達成できない")
      return <p className="wf-sub">待っていた対象がなくなりました</p>;
    return <p className="wf-sub">見張っています</p>;
  }
  // 書き込む中身が見えていれば、「頼む」と「承認」を 1 回の押下にまとめてよい（中身を見てから承認する、という決まりは守れる）
  if (item.how === "write")
    return item.write ? (
      <div className="wf-stack" style={{ gap: 8 }}>
        <p className="wf-quote">{item.write.summary}</p>
        <div className="wf-button-row">
          <Button tone="primary" onClick={done}>
            {joinJa("承認して", item.write.verb)}
          </Button>
          {ctx.markOnce(8)}
        </div>
      </div>
    ) : (
      <div className="wf-button-row">
        <Button tone="primary">書き込みを頼む</Button>
      </div>
    );
  return (
    <div className="wf-stack" style={{ gap: 8 }}>
      <div className="wf-button-row">
        <Button tone="primary" onClick={done}>
          済んだ
        </Button>
        {item.place && <Button>{item.place.label}</Button>}
      </div>
    </div>
  );
}

function Parallel({ group, turn, ctx }: { group: PlanGroup; turn: Turn; ctx: Ctx }) {
  return (
    <div className={`wf-parallel${turn.state === "番待ち" ? " wf-parallel--waiting" : ""}`}>
      <p className="wf-parallel-head">
        <strong>どれからでも</strong>
        {ctx.markOnce(4)}
      </p>
      {turn.state === "番待ち" && <Waiting turn={turn} ctx={ctx} />}
      <ul className="wf-parallel-lanes">
        {group.items.map((child, index) => (
          <li key={keyOf(child, index)}>
            <Lane node={child} ctx={ctx} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 並列の中の 1 本。1 項目だけなら印を付けずにカードだけを置く（囲みの印が番を示しているので、重ねて描かない）。
 * 中に直列があるときだけ、小さな線路として描く。
 */
function Lane({ node, ctx }: { node: PlanNode; ctx: Ctx }): ReactNode {
  if (node.type === "group") {
    // 枝ごとに進み具合が違うので、直列の枝の頭にだけ「いくつ済んだか」を出す
    const lane = progressOf(node);
    return (
      <div className="wf-stack" style={{ gap: 4 }}>
        <p className="wf-sub">
          {lane.done} / {lane.total} 済み {ctx.markOnce(7)}
        </p>
        <Track group={node} ctx={ctx} />
      </div>
    );
  }
  if (node.type === "item") return <Item item={node} turn={stateOf(node, ctx)} ctx={ctx} />;
  if (node.type === "decision") return <Decision decision={node} turn={stateOf(node, ctx)} ctx={ctx} />;
  return (
    <p className="wf-node-line">
      <span className="wf-task-reason">完了したら</span> {node.title}
    </p>
  );
}

function Decision({ decision, turn, ctx }: { decision: PlanDecision; turn: Turn; ctx: Ctx }) {
  const active = decision.branches.find((branch) => branch.state === "進めている");
  const abandoned = decision.branches.filter((branch) => branch.state === "取りやめた");

  if (decision.status === "done" && active) {
    const redo = () => ctx.act(rechoose(ctx.plan, decision.id));
    return (
      <div className="wf-decision">
        <div className="wf-node-head">
          <span>
            <span className="wf-node-done-plain">{decision.title}</span>
            <span className="wf-chip wf-chip--solid">{active.option}</span>
          </span>
          {active.plan && hasRunningWork(active.plan) ? (
            <StopWorkButton label="選び直す" what={`枝「${active.option}」で作業しています`} onConfirm={redo} />
          ) : (
            <Button tone="quiet" onClick={redo}>
              選び直す
            </Button>
          )}
        </div>
        <div className="wf-branch">
          <p className="wf-branch-label">
            枝「{active.option}」 {ctx.markOnce(6)}
          </p>
          {active.plan ? <Track group={active.plan} ctx={ctx} /> : <div className="wf-node-card wf-node-card--busy">AI がこの先の計画を考えています</div>}
        </div>
        <Abandoned branches={abandoned} ctx={ctx} />
      </div>
    );
  }

  const canChoose = turn.state === "番が来ている";
  const body = (
    <>
        {decision.question && <p>{decision.question}</p>}
        {decision.kind === "確かめる" ? (
          <div className="wf-box wf-box--quiet">
            <span className="wf-box-label">確かめ方</span>
            <p>{decision.howToCheck}</p>
          </div>
        ) : decision.recommendation ? (
          <div className="wf-box wf-box--ai">
            <span className="wf-box-label">AI のおすすめ</span>
            <p>
              <strong>{decision.recommendation.label}</strong>　{decision.recommendation.reason}
            </p>
          </div>
        ) : (
          <p className="wf-sub">AI はおすすめを決めきれませんでした</p>
        )}
        {decision.kind === "選ぶ" && (
        <p className="wf-task-top">
          <span className="wf-sub">比べること</span>
          {aspectsOf(decision.options).map((aspect) => (
            <span key={aspect} className="wf-chip">
              {aspect}
            </span>
          ))}
        </p>
        )}
        <ul className="wf-options-grid">
          {decision.options.map((option) => (
            <li key={option.label} className="wf-option">
              <span className="wf-task-top">
                <strong>{option.label}</strong>
                {decision.recommendation?.label === option.label && <span className="wf-pill wf-pill--ai">おすすめ</span>}
              </span>
              <ul className="wf-tradeoff" aria-label={`「${option.label}」を選ぶと`}>
                {option.gains.map((gain) => (
                  <li key={gain.aspect + gain.detail} className="wf-tradeoff--gain">
                    <strong>{gain.aspect}</strong>
                    <span>{gain.detail}</span>
                  </li>
                ))}
                {option.costs.map((cost) => (
                  <li key={cost.aspect + cost.detail} className="wf-tradeoff--cost">
                    <strong>{cost.aspect}</strong>
                    <span>{cost.detail}</span>
                  </li>
                ))}
              </ul>
              {option.unclear.length > 0 && <p className="wf-sub">判断できなかった観点: {option.unclear.join("・")}</p>}
              <p className="wf-sub">
                {option.then.type === "planned" ? `このあと: ${titlesOf(option.then.plan).join(" → ")}` : "このあと: AI が計画を考える"}
              </p>
              {canChoose && (
                <Button onClick={() => ctx.act(choose(ctx.plan, decision.id, option.label))}>
                  これにする
                </Button>
              )}
            </li>
          ))}
        </ul>
    </>
  );
  // 番待ちの分かれ道は、まだ選べない将来の分かれ道なので、題と「〇〇のあと」だけを出して閉じておく（押せば選択肢を開ける）
  if (!canChoose) {
    return (
      <div className="wf-decision wf-decision--waiting">
        <div className="wf-node-head">
          <span>
            <span>{decision.title}</span> {ctx.markOnce(5)}
          </span>
        </div>
        <Waiting turn={turn} ctx={ctx} />
        <details className="wf-abandoned">
          <summary>選択肢を見る（{decision.options.length} 件）</summary>
          {body}
        </details>
        <Abandoned branches={abandoned} ctx={ctx} />
      </div>
    );
  }
  return (
    <div className="wf-decision wf-decision--now">
      <div className="wf-node-head">
        <span>
          <strong className="wf-node-title">{decision.title}</strong> {ctx.markOnce(5)}
        </span>
      </div>
      {body}
      <Abandoned branches={abandoned} ctx={ctx} />
    </div>
  );
}

function Abandoned({ branches, ctx }: { branches: PlanDecision["branches"]; ctx: Ctx }) {
  if (branches.length === 0) return null;
  return (
    <details className="wf-abandoned">
      <summary>取りやめた枝 {branches.length} 本</summary>
      {branches.map((branch, index) => (
        <div key={`${branch.option}-${index}`} className="wf-branch wf-branch--abandoned">
          <p className="wf-branch-label">枝「{branch.option}」（取りやめた）</p>
          {branch.plan ? <Track group={branch.plan} ctx={ctx} /> : <p className="wf-task-reason">計画を考える前に取りやめた</p>}
        </div>
      ))}
    </details>
  );
}

function titlesOf(node: PlanNode): string[] {
  if (node.type === "item" || node.type === "decision") return [node.title];
  if (node.type === "group") return node.items.flatMap(titlesOf);
  return [`完了したら: ${node.title}`];
}

export const PLAN_NOTES = [
  { n: 1, text: "今できる数と、全体のうちいくつ済んだかだけを先に出す。並列なら今できるものが複数になる" },
  { n: 2, text: "番が来ている項目だけを黒い丸と太い線にし、操作ボタンもここにだけ出す" },
  { n: 3, text: "番待ちの項目は「〇〇のあと」と、すぐ前のまだの項目だけを名指しする（遠い祖先までは並べない）" },
  { n: 4, text: "並列は 1 つの囲みに横に並べ、どれからでも手を付けられる（今できるものが同時に複数ある）。囲みの印が番を示すので、中の項目には印を付けない" },
  { n: 5, text: "分かれ道は人が決めないと進まない場所なので、決めるための情報を出す。確かめる分かれ道（事実を確かめれば答えが決まる）は、確かめ方と選択肢だけを出す。選ぶ分かれ道は、何を決めるか、AI のおすすめと理由、比べている観点、選択肢ごとの得るもの（＋）・失うもの（−）と判断できなかった観点、選んだあとの流れ。観点は決め打ちの一覧で、選択肢ごと・観点ごとに Decisions が良くなるか悪くなるかを判定し、中身（理由）は Generation が書く。おすすめは Decisions が決めきれたときだけ出す（決めきれなければ、そう書く）。番が来るまで選べないので、番待ちの分かれ道は題と「〇〇のあと」だけを出して閉じておき、押せば選択肢を開ける" },
  { n: 6, text: "選んだ枝は字下げして続け、選び直したら前の枝は「取りやめた枝」として閉じて残す（済んだことは消さない）" },
  { n: 7, text: "並列の中の直列の枝は、それぞれのペースで進む。枝の頭に枝ごとの進み具合を出し、並列の後ろの項目は、枝それぞれの最後のまだの項目を待つ" },
  { n: 8, text: "書き込みの項目には書き込む中身の要約を出しておき、「承認して〇〇する」の 1 回で頼んで承認する（中身を見てから承認する決まりは守れるので、確認の画面を挟まない）" },
  { n: 9, text: "事実から計画に足した項目には、もとの事実を添え、「別の Task に切り出す」を出す。届いた事実は新しい Task より既存の Task の計画に足す方に倒す（ADR-0025）ので、寄せすぎを 1 回の操作で直せるように" },
];
