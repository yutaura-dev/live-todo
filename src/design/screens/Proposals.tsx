import { useEffect, useState } from "react";
import { autoActions, proposals as sampleProposals, undecidedFacts as sampleFacts, type ProposalView, type UndecidedFact } from "../../wireframes/fixtures.js";
import { AppShell, ScreenHead, type View } from "../AppShell.js";
import { AiText, Button, Icon, Kbd, Pill, Quote, SourceMarks, sourceName } from "../components.js";

type Selected = { kind: "提案"; id: number } | { kind: "事実"; id: number };

const KIND_HEADINGS: Record<ProposalView["kind"], string> = {
  "既存の Task に足す": "既存の Task に足す",
  "新しい Task": "新しい Task",
  切り出す: "切り出す",
};

const KIND_PILLS: Record<ProposalView["kind"], string> = {
  "既存の Task に足す": "既存の Task に足す提案",
  "新しい Task": "新しい Task の提案",
  切り出す: "切り出す提案",
};

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

/**
 * 提案。AI が決めきれなかったものを、1 件ずつ大きく出して決める。
 * 提案は Task ではないので、ここに溜まっても Task の数は増えない。受け入れると Task になるか、既存の Task の計画に足される。
 * 足す提案を一覧の先頭にするのは、届いた事実を既存の Task の計画に寄せる方針（ADR-0025）だから。
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
  const [last, setLast] = useState<{ message: string; undo: () => void } | null>(null);
  const proposal = selected?.kind === "提案" ? open.find((item) => item.id === selected.id) : undefined;
  const fact = selected?.kind === "事実" ? facts.find((item) => item.id === selected.id) : undefined;
  const total = open.length + facts.length;

  const decideProposal = (item: ProposalView, outcome: string, status: "受け入れた" | "見送った") => {
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
  const isCurrent = (key: Selected) => selected?.kind === key.kind && selected.id === key.id;
  const groups = (["既存の Task に足す", "新しい Task", "切り出す"] as const).map((kind) => ({ kind, items: open.filter((item) => item.kind === kind) }));

  return (
    <AppShell current="提案" counts={{ 提案: total }} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}>
      <ScreenHead title="提案" subtitle={total > 0 ? `AI が決めきれなかったものが ${total} 件あります。受け入れると Task になるか、計画に足されます` : undefined} />
      {last && (
        <div className="ui-last" role="status">
          <Icon name="check" />
          <span>{last.message}</span>
          <Button tone="quiet" size="sm" onClick={last.undo}>
            <Icon name="undo" />
            元に戻す
          </Button>
        </div>
      )}
      <div className="ui-split">
        <nav className="ui-queue-nav" aria-label="提案">
          {groups.map(
            (group) =>
              group.items.length > 0 && (
                <section key={group.kind} className="ui-queue" aria-label={KIND_PILLS[group.kind]}>
                  <h2 className="ui-queue-title">
                    {KIND_HEADINGS[group.kind]}
                    <span className="ui-num">{group.items.length}</span>
                  </h2>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.id}>
                        <button type="button" className="ui-queue-item ui-queue-item--two" aria-current={isCurrent({ kind: "提案", id: item.id }) ? "true" : undefined} onClick={() => setSelected({ kind: "提案", id: item.id })}>
                          <SourceMarks sources={[...new Set(item.facts.map((f) => f.source))]} />
                          <span className="ui-queue-text">
                            <span>{item.title}</span>
                            {item.target && <span className="ui-sub">→ {item.target.title}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
          )}
          {facts.length > 0 && (
            <section className="ui-queue" aria-label="AI が判断できなかった事実">
              <h2 className="ui-queue-title">
                AI が判断できなかった事実
                <span className="ui-num">{facts.length}</span>
              </h2>
              <ul>
                {facts.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="ui-queue-item" aria-current={isCurrent({ kind: "事実", id: item.id }) ? "true" : undefined} onClick={() => setSelected({ kind: "事実", id: item.id })}>
                      <SourceMarks sources={[item.source]} />
                      <span>{item.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {declined.length > 0 && (
            <details className="ui-disclosure ui-auto-writes">
              <summary>
                <Icon name="chevron" size={14} />
                <span>見送った提案</span>
                <span className="ui-sub ui-num">{declined.length} 件</span>
              </summary>
              <ul className="ui-auto-list">
                {declined.map((item) => (
                  <li key={item.id} className="ui-declined">
                    <span>{item.title}</span>
                    <span className="ui-sub">事実が変われば、もう一度提案されます</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details className="ui-disclosure ui-auto-writes">
            <summary>
              <Icon name="chevron" size={14} />
              <span>AI が自動でしたこと（今日）</span>
              <span className="ui-sub ui-num">{autoActions.length} 件</span>
            </summary>
            <ol className="ui-auto-list">
              {autoActions.map((action) => (
                <li key={action.what}>
                  <span className="ui-num ui-sub">{action.at}</span>
                  <span className="ui-stack-4">
                    <span className="ui-sub">{action.kind}</span>
                    <span>{action.what}</span>
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </nav>
        {proposal && <ProposalCard item={proposal} onDecide={(outcome, status) => decideProposal(proposal, outcome, status)} />}
        {fact && <FactCard item={fact} onDecide={(outcome) => decideFact(fact, outcome)} />}
        {!proposal && !fact && (
          <div className="ui-empty">
            <p className="ui-empty-title">決めるものはありません</p>
            <p className="ui-sub">AI が決めきれなかったものは、取り込むたびにここに入ります</p>
            <Button tone="primary" onClick={() => props.onNavigate?.("見通し")}>
              見通しに戻る
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/** 毎朝 1 件ずつ繰り返す判断なので、主な操作にキーを付ける（キーでしかできない操作は作らない） */
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

function ProposalCard({ item, onDecide }: { item: ProposalView; onDecide: (outcome: string, status: "受け入れた" | "見送った") => void }) {
  const accept = () => onDecide(item.kind === "新しい Task" ? "Task にしました" : item.kind === "既存の Task に足す" ? `「${item.target?.title}」の計画に足しました` : "切り出して Task にしました", "受け入れた");
  const decline = () => onDecide("見送りました", "見送った");
  useKeys({ a: accept, x: decline });
  const alternative = ALTERNATIVE_LABELS[item.kind];
  return (
    <article className="ui-focus" aria-labelledby="ui-proposal-title">
      <div className="ui-focus-from">
        <Pill tone="seiji">{KIND_PILLS[item.kind]}</Pill>
        {item.target && (
          <span className="ui-target">
            寄せ先 <strong>{item.target.title}</strong>
          </span>
        )}
      </div>
      <h2 id="ui-proposal-title" className="ui-focus-title">
        {item.title}
      </h2>
      <AiText label="なぜ提案するか（AI が書いた）">
        <p>{item.brief}</p>
      </AiText>
      <section className="ui-section" aria-labelledby="ui-draft-title">
        <h3 id="ui-draft-title" className="ui-section-title">
          {item.kind === "新しい Task" ? "計画の案" : item.kind === "既存の Task に足す" ? "計画に足す項目" : "切り出す項目"}
        </h3>
        <ol className="ui-draft">
          {item.plan.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>
      <section className="ui-section" aria-labelledby="ui-facts-title">
        <h3 id="ui-facts-title" className="ui-section-title">
          もとの事実 <span className="ui-sub ui-num">{item.facts.length}</span>
        </h3>
        {item.facts.map((f) => (
          <div key={f.title} className="ui-stack-8">
            <p className="ui-focus-from">
              <SourceMarks sources={[f.source]} />
              {f.title}
              <Button tone="quiet" size="sm" className="ui-push-end">
                <Icon name="open" size={14} />
                開く
              </Button>
            </p>
            <Quote from={`${sourceName(f.source)}の元の文面から`}>{f.excerpt}</Quote>
          </div>
        ))}
      </section>
      <div className="ui-decide-actions">
        <Button tone="primary" size="lg" onClick={accept}>
          {ACCEPT_LABELS[item.kind]} <Kbd>A</Kbd>
        </Button>
        {alternative && (
          <Button size="lg" onClick={() => onDecide(item.kind === "新しい Task" ? "既存の Task に足しました" : "新しい Task にしました", "受け入れた")}>
            {alternative}
          </Button>
        )}
        <Button tone="quiet" size="lg" className="ui-push-end" onClick={decline}>
          見送る <Kbd>X</Kbd>
        </Button>
      </div>
    </article>
  );
}

function FactCard({ item, onDecide }: { item: UndecidedFact; onDecide: (outcome: string) => void }) {
  useKeys({ n: () => onDecide("新しい Task にしました"), x: () => onDecide("対象外にしました") });
  return (
    <article className="ui-focus" aria-labelledby="ui-fact-title">
      <div className="ui-focus-from">
        <SourceMarks sources={[item.source]} />
        {item.from}
        <Pill tone="outline">AI が判断できなかった</Pill>
        <Button tone="quiet" size="sm" className="ui-push-end">
          <Icon name="open" size={14} />
          元のツールで開く
        </Button>
      </div>
      <h2 id="ui-fact-title" className="ui-focus-title">
        {item.title}
      </h2>
      <Quote from={`${sourceName(item.source)}の元の文面から`}>{item.excerpt}</Quote>
      <p className="ui-sub">AI はこの事実を判断できませんでした（判定を断られた・答えが読めなかった）。どうするかを決めてください</p>
      <div className="ui-decide-actions">
        <Button tone="primary" size="lg" onClick={() => onDecide("新しい Task にしました")}>
          新しい Task にする <Kbd>N</Kbd>
        </Button>
        <Button size="lg" onClick={() => onDecide("対象外にしました")}>
          対象外にする <Kbd>X</Kbd>
        </Button>
        <Button tone="quiet" size="lg" className="ui-push-end">
          既存の Task に入れる…
        </Button>
      </div>
    </article>
  );
}
