import type { ReactNode } from "react";
import { proposals, undecidedFacts, writeRequests, writeTroubles } from "../wireframes/fixtures.js";
import { Icon, Logo } from "./components.js";
import "./tokens.css";
import "./components.css";
import "./screens.css";

export type View = "見通し" | "提案" | "承認" | "カンバン" | "設定";

const VIEWS: View[] = ["見通し", "提案", "承認", "カンバン", "設定"];

export type Counts = Partial<Record<View, number>>;

/** 件数はサンプルデータから 1 か所で数える（画面ごとに持つと、画面によって数が食い違うため） */
const DEFAULT_COUNTS: Counts = {
  提案: proposals.filter((proposal) => proposal.status === "提案中").length + undecidedFacts.length,
  承認: writeRequests.length + writeTroubles.length,
};

export type SyncView = { state: "ok" | "problem"; text: string };

/**
 * 画面の骨組み。左のレールで画面を切り替え、右に詳細（inspector）を並べる。
 * 詳細をドロワー（モーダル）にしない理由: 一覧を見比べながら次々に Task を開くので、一覧を不活性にしたくない。
 * レールの上端を空けておく理由: 窓を titleBarStyle: "hiddenInset" にして、信号の 3 つのボタンをレールの上に置くため。
 */
export function AppShell(props: {
  current: View;
  counts?: Counts;
  sync?: SyncView;
  locked?: boolean;
  onNavigate?: (view: View) => void;
  inspector?: ReactNode;
  inspectorLabel?: string;
  children: ReactNode;
}) {
  const counts = props.counts ?? DEFAULT_COUNTS;
  return (
    <div lang="ja" className={`ui ui-app${props.inspector ? " ui-app--inspector" : ""}`}>
      <nav className="ui-rail" aria-label="画面">
        <p className="ui-wordmark">
          <Logo />
          live-todo
        </p>
        <ul className="ui-rail-list">
          {VIEWS.map((view) => {
            const disabled = props.locked === true && view !== "設定";
            const count = counts[view] ?? 0;
            return (
              <li key={view}>
                <button
                  type="button"
                  className="ui-rail-item"
                  aria-current={props.current === view ? "page" : undefined}
                  disabled={disabled}
                  onClick={() => props.onNavigate?.(view)}
                >
                  <span>{view}</span>
                  {!disabled && count > 0 && (
                    <span className="ui-rail-count ui-num" aria-label={`${count} 件`}>
                      {count}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="ui-rail-foot">
          {props.locked ? (
            <p className="ui-rail-status ui-rail-status--stopped">AI を設定するまで止めています</p>
          ) : props.sync?.state === "problem" ? (
            <p className="ui-rail-status ui-rail-status--problem" role="alert">
              <Icon name="warn" size={14} />
              取り込めていません
            </p>
          ) : (
            <p className="ui-rail-status ui-num">9:02 に取り込みました</p>
          )}
        </div>
      </nav>
      <main className="ui-main">
        <div className="ui-main-inner">{props.children}</div>
      </main>
      {props.inspector && (
        <aside className="ui-inspector" aria-label={props.inspectorLabel ?? "Task の詳細"}>
          {props.inspector}
        </aside>
      )}
    </div>
  );
}

export function ScreenHead(props: { title: string; subtitle?: string | undefined; actions?: ReactNode }) {
  return (
    <header className="ui-head">
      <div className="ui-head-text">
        <h1 className="ui-title">{props.title}</h1>
        {props.subtitle && <p className="ui-sub">{props.subtitle}</p>}
      </div>
      {props.actions && <div className="ui-row">{props.actions}</div>}
    </header>
  );
}
