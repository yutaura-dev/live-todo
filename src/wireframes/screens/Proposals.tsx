import { useEffect, useState } from "react";
import { autoActions, proposals as sampleProposals, undecidedFacts as sampleFacts, type ProposalView, type UndecidedFact } from "../fixtures.js";
import { Box, Button, Mark, SourceMarks } from "../parts.js";
import { AppFrame, ScreenHead, type View } from "./AppFrame.js";

type Selected = { kind: "提案"; id: number } | { kind: "事実"; id: number };

const KIND_HEADINGS: Record<ProposalView["kind"], string> = {
  "新しい Task": "新しい Task の提案",
  "既存の Task に足す": "既存の Task に足す提案",
  切り出す: "切り出す提案",
};

/**
 * 提案（specs/task-proposal.spec.ts）。AI が決めきれなかったものを、1 件ずつ大きく出して決める。
 * - 提案: 新しい Task を作る・既存の Task の計画に足す・既存の Task から切り出す。受け入れる・別の形で受け入れる・見送る
 * - AI が判断できなかった事実（specs/routing.spec.ts の「ユーザー待ち」）: 新しい Task にする・既存の Task に入れる・対象外にする
 * 提案は Task ではないので、ここに溜まっても Task の数は増えない。AI が自動でしたこと（作った・足した）も閉じて並べ、寄せたことに気づけるようにする。
 */
export function Proposals(props: { proposals?: ProposalView[]; facts?: UndecidedFact[]; select?: Selected; onNavigate?: (view: View) => void }) {
  const [items, setItems] = useState(props.proposals ?? sampleProposals);
  const [facts, setFacts] = useState(props.facts ?? sampleFacts);
  const open = items.filter((item) => item.status === "提案中");
  const declined = items.filter((item) => item.status === "見送った");
  const firstOf = (rest: ProposalView[], restFacts: UndecidedFact[]): Selected | null => {
    const nextProposal = rest.find((item) => item.status === "提案中");
    return nextProposal ? { kind: "提案", id: nextProposal.id } : restFacts[0] ? { kind: "事実", id: restFacts[0].id } : null;
  };
  const [selected, setSelected] = useState<Selected | null>(props.select ?? firstOf(items, facts));
  const proposal = selected?.kind === "提案" ? open.find((item) => item.id === selected.id) : undefined;
  const fact = selected?.kind === "事実" ? facts.find((item) => item.id === selected.id) : undefined;
  // 直前に決めたもの。決めると次の 1 件へ自動で進むので、押し間違いに気づけて戻せる場所が要る
  const [last, setLast] = useState<{ message: string; undo: () => void } | null>(null);

  const decideProposal = (item: ProposalView, outcome: string, status: ProposalView["status"] | "受け入れた") => {
    const rest = status === "受け入れた" ? items.filter((candidate) => candidate.id !== item.id) : items.map((candidate) => (candidate.id === item.id ? { ...candidate, status } : candidate));
    setItems(rest);
    setSelected(firstOf(rest, facts));
    setLast({
      message: `「${item.title}」を${outcome}`,
      undo: () => {
        setItems((current) => [item, ...current.filter((candidate) => candidate.id !== item.id)]);
        setSelected({ kind: "提案", id: item.id });
        setLast(null);
      },
    });
  };
  const decideFact = (item: UndecidedFact, outcome: string) => {
    const rest = facts.filter((candidate) => candidate.id !== item.id);
    setFacts(rest);
    setSelected(firstOf(items, rest));
    setLast({
      message: `「${item.title}」を${outcome}`,
      undo: () => {
        setFacts((current) => [item, ...current]);
        setSelected({ kind: "事実", id: item.id });
        setLast(null);
      },
    });
  };

  const queue = (["既存の Task に足す", "新しい Task", "切り出す"] as const).map((kind) => ({ kind, items: open.filter((item) => item.kind === kind) }));
  const isCurrent = (key: Selected) => selected?.kind === key.kind && selected.id === key.id;

  return (
    <AppFrame current="提案" counts={{ 提案: open.length + facts.length }} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}>
      <ScreenHead title="提案" subtitle="AI が決めきれなかったものです。受け入れると Task になるか、計画に足されます" />
      {last && (
        <p className="wf-box wf-box--quiet wf-banner" role="status">
          <span>{last.message}</span>
          <Mark n={6} />
          <span className="wf-button-row">
            <Button tone="quiet" onClick={last.undo}>
              元に戻す
            </Button>
          </span>
        </p>
      )}
      <div className="wf-split">
        <div className="wf-stack">
          <Mark n={1} />
          {queue.map(
            (group) =>
              group.items.length > 0 && (
                <section key={group.kind} className="wf-section" aria-label={KIND_HEADINGS[group.kind]}>
                  <h2 className="wf-section-title">
                    {KIND_HEADINGS[group.kind]} <span className="wf-horizon-count">{group.items.length}</span>
                  </h2>
                  <ul className="wf-queue">
                    {group.items.map((item) => (
                      <li key={item.id}>
                        <button type="button" className="wf-queue-item" aria-current={isCurrent({ kind: "提案", id: item.id }) ? "true" : undefined} onClick={() => setSelected({ kind: "提案", id: item.id })}>
                          <SourceMarks sources={[...new Set(item.facts.map((f) => f.source))]} />
                          <span>{item.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
          )}
          {facts.length > 0 && (
            <section className="wf-section" aria-label="AI が判断できなかった事実">
              <h2 className="wf-section-title">
                AI が判断できなかった事実 <span className="wf-horizon-count">{facts.length}</span> <Mark n={5} />
              </h2>
              <ul className="wf-queue">
                {facts.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="wf-queue-item" aria-current={isCurrent({ kind: "事実", id: item.id }) ? "true" : undefined} onClick={() => setSelected({ kind: "事実", id: item.id })}>
                      <SourceMarks sources={[item.source]} />
                      <span>{item.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {declined.length > 0 && (
            <details className="wf-more">
              <summary>
                <span className="wf-section-title">見送った提案</span>
                <span className="wf-horizon-count">{declined.length} 件</span>
                <Mark n={7} />
              </summary>
              <ul className="wf-now-list" style={{ padding: "0 16px" }}>
                {declined.map((item) => (
                  <li key={item.id}>
                    <span>{item.title}</span>
                    <span className="wf-sub">事実が変われば、もう一度提案されます</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details className="wf-more">
            <summary>
              <span className="wf-section-title">AI が自動でしたこと（今日）</span>
              <span className="wf-horizon-count">{autoActions.length} 件</span>
              <Mark n={8} />
            </summary>
            <ul className="wf-history" style={{ padding: "8px 16px 16px" }}>
              {autoActions.map((action) => (
                <li key={action.what} style={{ gridTemplateColumns: "4em 7em minmax(0, 1fr)" }}>
                  <span>{action.at}</span>
                  <span>{action.kind}</span>
                  <span>{action.what}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
        <div className="wf-stack">
          {proposal && <ProposalCard item={proposal} onDecide={(outcome, status) => decideProposal(proposal, outcome, status)} />}
          {fact && <FactCard item={fact} onDecide={(outcome) => decideFact(fact, outcome)} />}
          {!proposal && !fact && (
            <div className="wf-stack" style={{ justifyItems: "start" }}>
              <p className="wf-horizon-empty" style={{ inlineSize: "100%" }}>
                決めるものはありません。AI が決めきれなかったものは、取り込むたびにここに入ります
              </p>
              <Button tone="primary" onClick={() => props.onNavigate?.("見通し")}>
                見通しに戻る
              </Button>
            </div>
          )}
        </div>
      </div>
    </AppFrame>
  );
}

/**
 * 主な操作のキー。毎朝 1 件ずつ繰り返す判断なので、マウスに持ち替えずに進められるようにする（キーでしかできない操作は作らない）。
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

const ACCEPT_LABELS: Record<ProposalView["kind"], string> = {
  "新しい Task": "Task にする",
  "既存の Task に足す": "計画に足す",
  切り出す: "切り出して Task にする",
};

const ALTERNATIVE_LABELS: Record<ProposalView["kind"], string | null> = {
  "新しい Task": "既存の Task に足す…",
  "既存の Task に足す": "新しい Task にする",
  切り出す: null,
};

function ProposalCard({ item, onDecide }: { item: ProposalView; onDecide: (outcome: string, status: "見送った" | "受け入れた") => void }) {
  const accept = () => onDecide(item.kind === "新しい Task" ? "Task にしました" : item.kind === "既存の Task に足す" ? `「${item.target?.title}」の計画に足しました` : "切り出して Task にしました", "受け入れた");
  useKeys({ a: accept, x: () => onDecide("見送りました", "見送った") });
  const alternative = ALTERNATIVE_LABELS[item.kind];
  return (
    <Box className="wf-focus-card">
      <div className="wf-task-top">
        <span className="wf-pill">{KIND_HEADINGS[item.kind]}</span>
        {item.target && <span className="wf-task-reason">寄せ先: Task「{item.target.title}」</span>}
        <Mark n={2} />
      </div>
      <h2 className="wf-task-title">{item.title}</h2>
      <Box kind="ai" label="なぜ提案するか">
        <p>{item.brief}</p>
      </Box>
      <section className="wf-section" aria-label={item.kind === "新しい Task" ? "計画の案" : "足す・切り出す項目"}>
        <h3 className="wf-section-title">
          {item.kind === "新しい Task" ? "計画の案" : item.kind === "既存の Task に足す" ? "計画に足す項目" : "切り出す項目"} <Mark n={3} />
        </h3>
        <ol className="wf-stack" style={{ gap: 4 }}>
          {item.plan.map((step) => (
            <li key={step}>・{step}</li>
          ))}
        </ol>
      </section>
      <section className="wf-section" aria-label="もとの事実">
        <h3 className="wf-section-title">
          もとの事実 <span className="wf-horizon-count">{item.facts.length}</span> <Mark n={4} />
        </h3>
        {item.facts.map((f) => (
          <div key={f.title} className="wf-stack" style={{ gap: 4 }}>
            <span className="wf-task-top">
              <SourceMarks sources={[f.source]} />
              {f.title}
              <Button tone="quiet">元のツールで開く</Button>
            </span>
            <p className="wf-quote">{f.excerpt}</p>
          </div>
        ))}
      </section>
      <div className="wf-big-actions">
        <Button tone="primary" onClick={accept}>
          {ACCEPT_LABELS[item.kind]} <KeyHint k="A" />
        </Button>
        {alternative && <Button onClick={() => onDecide(item.kind === "新しい Task" ? "既存の Task に足しました" : "新しい Task にしました", "受け入れた")}>{alternative}</Button>}
        <Button tone="quiet" onClick={() => onDecide("見送りました", "見送った")}>
          見送る <KeyHint k="X" />
        </Button>
      </div>
    </Box>
  );
}

function FactCard({ item, onDecide }: { item: UndecidedFact; onDecide: (outcome: string) => void }) {
  useKeys({ n: () => onDecide("新しい Task にしました"), x: () => onDecide("対象外にしました") });
  return (
    <Box className="wf-focus-card">
      <div className="wf-task-top">
        <SourceMarks sources={[item.source]} />
        <span className="wf-task-reason">{item.from}</span>
        <span className="wf-pill">AI が判断できなかった</span>
      </div>
      <h2 className="wf-task-title">{item.title}</h2>
      <p className="wf-quote">{item.excerpt}</p>
      <div className="wf-big-actions">
        <Button tone="primary" onClick={() => onDecide("新しい Task にしました")}>
          新しい Task にする <KeyHint k="N" />
        </Button>
        <Button onClick={() => onDecide("対象外にしました")}>
          対象外にする <KeyHint k="X" />
        </Button>
        <Button tone="quiet">元のツールで開く</Button>
      </div>
      <Button tone="quiet">既存の Task に入れる…</Button>
    </Box>
  );
}

export const PROPOSAL_QUESTIONS = [
  "「確率が中間」の幅（提案にする範囲）と、自動で受け入れる閾値は、ベンチマークで決める（specs/task-proposal.spec.ts の questions）。提案が毎朝いくつも溜まるようなら、幅を狭める",
];

export const PROPOSAL_NOTES = [
  { n: 1, text: "提案を種類ごとに並べる（既存の Task に足す・新しい Task・切り出す）。提案は Task ではないので、溜まっても Task の数は増えない。足す提案を先頭にするのは、既存の Task を育てる方に寄せる方針（ADR-0025）だから" },
  { n: 2, text: "何の提案かと、寄せ先の Task を最初に出す。足す提案の既定の操作は「計画に足す」（寄せる力を残す）" },
  { n: 3, text: "受け入れたら何ができるか（作る Task の計画の案・足す項目）を先に見せる。受け入れる前に中身が分かるように" },
  { n: 4, text: "もとの事実は複数のことがある（同じ件の事実が続けて届くと、新しい提案は作らず、ここに足される。確信が上がれば AI が自動で受け入れる）" },
  { n: 5, text: "AI が見たのに決められなかった事実（refusal・答えが形に合わない）。提案にもできなかったので、事実のまま出して自分で決める。AI に届かなかった事実は、ここに出さずに次の同期でやり直す" },
  { n: 6, text: "決めると次の 1 件へ自動で進むので、直前に決めた結果をここに出し、押し間違えたら「元に戻す」で戻せる。主な操作にはキー（A・X・N）を付ける" },
  { n: 7, text: "見送った提案は、期限を置かずに、もとの事実が開いている間は残す（閉じておく）。事実が行動を求めるように変われば、もう一度提案される。事実が片付いたら消える" },
  { n: 8, text: "AI が自動でしたこと（確信が高く、Task を作った・計画に足した）も閉じて並べ、寄せたことに気づけるようにする。間違いは、その Task の詳細で切り出す・外すで直す" },
];
