import { useEffect, useState } from "react";
import { routingItems, tasks, type RoutingItem } from "../fixtures.js";
import type { WireTask } from "../model.js";
import { Box, Button, Mark, SourceMarks } from "../parts.js";
import { AppFrame, ScreenHead, type View } from "./AppFrame.js";

type Selected = { kind: "事実"; id: number } | { kind: "Task"; id: number };

/**
 * 仕分け。自分が決めないと先に進まないものを、1 件ずつ大きく出して決める。2 種類あり、決めることが違う。
 * - 振り分けを待っている事実（specs/routing.spec.ts の「ユーザー待ち」）: 新しい Task にする・既存の Task の事実にする・対象外にする
 * - 要確認の Task（specs/task.spec.ts の needs_review）: Todo に移す・やらないことにする・完了にする
 * 一覧のカードに並べない理由: 判断に要るのは元の文面で、1 件ずつ読んで決めるほうが速く、取り違えない。
 */
export function Triage(props: { facts?: RoutingItem[]; reviews?: WireTask[]; select?: Selected; onNavigate?: (view: View) => void }) {
  const [facts, setFacts] = useState(props.facts ?? routingItems);
  const [reviews, setReviews] = useState(props.reviews ?? tasks.filter((task) => task.status === "needs_review"));
  const first: Selected | null = facts[0] ? { kind: "事実", id: facts[0].id } : reviews[0] ? { kind: "Task", id: reviews[0].id } : null;
  const [selected, setSelected] = useState<Selected | null>(props.select ?? first);
  const fact = selected?.kind === "事実" ? facts.find((item) => item.id === selected.id) : undefined;
  const review = selected?.kind === "Task" ? reviews.find((task) => task.id === selected.id) : undefined;

  const next = (restFacts: RoutingItem[], restReviews: WireTask[]) =>
    setSelected(restFacts[0] ? { kind: "事実", id: restFacts[0].id } : restReviews[0] ? { kind: "Task", id: restReviews[0].id } : null);
  // 直前に決めたもの。決めた結果を画面に出し、元に戻せるようにする（次の 1 件へ自動で進むので、押し間違いに気づける場所が要る）
  const [last, setLast] = useState<{ message: string; undo: () => void } | null>(null);
  const decideFact = (item: RoutingItem, outcome: string) => {
    const rest = facts.filter((candidate) => candidate.id !== item.id);
    setFacts(rest);
    next(rest, reviews);
    setLast({
      message: `「${item.title}」を${outcome}`,
      undo: () => {
        setFacts((current) => [item, ...current]);
        setSelected({ kind: "事実", id: item.id });
        setLast(null);
      },
    });
  };
  const decideReview = (task: WireTask, outcome: string) => {
    const rest = reviews.filter((candidate) => candidate.id !== task.id);
    setReviews(rest);
    next(facts, rest);
    setLast({
      message: `「${task.title}」を${outcome}`,
      undo: () => {
        setReviews((current) => [task, ...current]);
        setSelected({ kind: "Task", id: task.id });
        setLast(null);
      },
    });
  };

  return (
    <AppFrame current="仕分け" counts={{ 仕分け: facts.length + reviews.length }} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}>
      <ScreenHead title="仕分け" />
      {last && (
        <p className="wf-box wf-box--quiet wf-banner" role="status">
          <span>{last.message}</span>
          <Mark n={5} />
          <span className="wf-button-row">
            <Button tone="quiet" onClick={last.undo}>
              元に戻す
            </Button>
          </span>
        </p>
      )}
      {fact === undefined && review === undefined ? (
        <div className="wf-stack" style={{ justifyItems: "start" }}>
          <p className="wf-horizon-empty" style={{ inlineSize: "100%" }}>
            仕分けるものはありません。新しく届いたものは、同期のたびにここに入ります
          </p>
          <Button tone="primary" onClick={() => props.onNavigate?.("見通し")}>
            見通しに戻る
          </Button>
        </div>
      ) : (
        <div className="wf-split">
          <div className="wf-stack">
            <Mark n={1} />
            <QueueSection
              title="振り分けを待っている事実"
              items={facts.map((item) => ({ key: { kind: "事実", id: item.id }, source: item.source, title: item.title }))}
              selected={selected}
              onSelect={setSelected}
            />
            <QueueSection
              title="要確認の Task"
              items={reviews.map((task) => ({ key: { kind: "Task", id: task.id }, source: task.sources[0] ?? "manual", title: task.title }))}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
          <div className="wf-stack">
            {fact && <FactCard item={fact} onDecide={(outcome) => decideFact(fact, outcome)} />}
            {review && <ReviewCard task={review} onDecide={(outcome) => decideReview(review, outcome)} />}
          </div>
        </div>
      )}
    </AppFrame>
  );
}

function QueueSection(props: { title: string; items: Array<{ key: Selected; source: string; title: string }>; selected: Selected | null; onSelect: (key: Selected) => void }) {
  if (props.items.length === 0) return null;
  return (
    <section className="wf-section" aria-label={props.title}>
      <h2 className="wf-section-title">
        {props.title} <span className="wf-horizon-count">{props.items.length}</span>
      </h2>
      <ul className="wf-queue">
        {props.items.map((item) => {
          const current = props.selected?.kind === item.key.kind && props.selected.id === item.key.id;
          return (
            <li key={`${item.key.kind}-${item.key.id}`}>
              <button type="button" className="wf-queue-item" aria-current={current ? "true" : undefined} onClick={() => props.onSelect(item.key)}>
                <SourceMarks sources={[item.source]} />
                <span>{item.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * 主な操作のキー。毎朝 1 件ずつ繰り返す判断なので、マウスに持ち替えずに進められるようにする（ボタンでもできる。キーでしかできない操作は作らない）。
 * 文字を打つ欄がない画面なので、日本語入力の確定と取り違えることはない。
 */
function useKeys(keys: Record<string, () => void>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const action = keys[event.key.toLowerCase()];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys]);
}

function KeyHint({ k }: { k: string }) {
  return <kbd className="wf-kbd">{k}</kbd>;
}

function FactCard({ item, onDecide }: { item: RoutingItem; onDecide: (outcome: string) => void }) {
  useKeys({ n: () => onDecide("新しい Task にしました"), x: () => onDecide("対象外にしました") });
  return (
    <Box className="wf-focus-card">
      <div className="wf-task-top">
        <SourceMarks sources={[item.source]} />
        <span className="wf-task-reason">{item.from}</span>
      </div>
      <h2 className="wf-task-title">{item.title}</h2>
      <p className="wf-quote">
        {item.excerpt} <Mark n={2} />
      </p>
      <section className="wf-section" aria-label="どこに入れるか">
        <div className="wf-big-actions">
          <Button tone="primary" onClick={() => onDecide("新しい Task にしました")}>
            新しい Task にする <KeyHint k="N" />
          </Button>
          <Button onClick={() => onDecide("対象外にしました")}>
            対象外にする <KeyHint k="X" />
          </Button>
          <Button tone="quiet">元のツールで開く</Button>
        </div>
        {item.candidates.length > 0 && (
          <>
            <p className="wf-sub">
              既存の Task に入れる <Mark n={3} />
            </p>
            <ul className="wf-stack" style={{ gap: 6 }}>
              {item.candidates.map((candidate) => (
                <li key={candidate.taskId}>
                  <button type="button" className="wf-queue-item" onClick={() => onDecide(`#${candidate.taskId}「${candidate.title}」の事実にしました`)}>
                    <span className="wf-pill">#{candidate.taskId}</span>
                    <span>{candidate.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <Button tone="quiet">ほかの Task を探す</Button>
      </section>
    </Box>
  );
}

function ReviewCard({ task, onDecide }: { task: WireTask; onDecide: (outcome: string) => void }) {
  useKeys({ t: () => onDecide("Todo に移しました"), x: () => onDecide("やらないことにしました") });
  return (
    <Box className="wf-focus-card">
      <div className="wf-task-top">
        <span className="wf-pill">要確認</span>
        <SourceMarks sources={task.sources} />
      </div>
      <h2 className="wf-task-title">{task.title}</h2>
      {task.brief && <p className="wf-quote">{task.brief}</p>}
      <Mark n={4} />
      <div className="wf-big-actions">
        <Button tone="primary" onClick={() => onDecide("Todo に移しました")}>
          Todo に移す <KeyHint k="T" />
        </Button>
        <Button onClick={() => onDecide("やらないことにしました")}>
          やらないことにする <KeyHint k="X" />
        </Button>
        <Button tone="quiet" onClick={() => onDecide("完了にしました")}>
          完了にする
        </Button>
      </div>
    </Box>
  );
}

export const TRIAGE_NOTES = [
  { n: 1, text: "AI が迷った事実と、要確認の Task を分けて並べる。決めることが違う（事実はどの Task に入れるか、Task は Todo にするか）" },
  { n: 2, text: "AI の判定（確率）は出さない。AI が迷った・判定できなかったものだけがここに来るので、元の文面を読んで決める" },
  { n: 3, text: "既存の Task の候補は AI が絞ったもの。AI が自動で紐づけるのは 1 つの Task だけなので、2 つ目以降は自分で足す" },
  { n: 4, text: "要確認の Task は完了条件を満たしても自動では終わらない。ここで Todo にするか、やらないことにする" },
  { n: 5, text: "決めると次の 1 件へ自動で進むので、直前に決めた結果をここに出し、押し間違えたら「元に戻す」で戻せる。主な操作にはキー（N・X・T）を付け、マウスに持ち替えずに続けられる" },
];
