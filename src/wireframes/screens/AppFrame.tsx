import type { ReactNode } from "react";
import { routingItems, tasks, writeRequests, writeTroubles } from "../fixtures.js";
import "../wireframe.css";

export type View = "見通し" | "仕分け" | "承認" | "カンバン" | "設定";

const VIEWS: View[] = ["見通し", "仕分け", "承認", "カンバン", "設定"];

export type Counts = Partial<Record<View, number>>;

/** 件数はサンプルデータから 1 か所で数える（画面ごとに持つと、画面によって数が食い違うため） */
const DEFAULT_COUNTS: Counts = {
  仕分け: routingItems.length + tasks.filter((task) => task.status === "needs_review").length,
  承認: writeRequests.length + writeTroubles.length,
};

export type SyncView = { state: "ok" | "problem"; text: string };

/**
 * 画面の骨組み。左のレールで画面を切り替え、右に詳細（inspector）を出す。
 * 詳細をドロワー（モーダル）にしない理由: 一覧を見比べながら次々に Task を開くので、
 * 一覧を不活性にせず、並べて置いたまま操作できるほうがよい。
 * locked のときは設定しか開けない（specs/ai-settings.spec.ts: AI が使えないあいだは設定の画面だけ出す）。
 */
export function AppFrame(props: {
  current: View;
  counts?: Counts;
  sync?: SyncView;
  locked?: boolean;
  onNavigate?: (view: View) => void;
  inspector?: ReactNode;
  children: ReactNode;
}) {
  // 同期がうまくいっているときは何も出さない（問題があるときだけ知らせる）
  const sync = props.sync ?? null;
  const counts = props.counts ?? DEFAULT_COUNTS;
  return (
    <div className="wf wf-app">
      <nav className="wf-rail" aria-label="画面">
        <p className="wf-wordmark">live-todo</p>
        {VIEWS.map((view) => {
          const disabled = props.locked === true && view !== "設定";
          return (
            <button
              key={view}
              type="button"
              className="wf-rail-item"
              aria-current={props.current === view ? "page" : undefined}
              disabled={disabled}
              onClick={() => props.onNavigate?.(view)}
            >
              <span>{view}</span>
              {!disabled && (counts[view] ?? 0) > 0 && <span className="wf-rail-count">{counts[view]}</span>}
            </button>
          );
        })}
        <div className="wf-rail-foot">
          {props.locked ? (
            <p className="wf-pill wf-pill--mine">AI を設定するまで止めています</p>
          ) : (
            sync?.state === "problem" && (
              <p className="wf-pill wf-pill--mine" role="alert">
                取り込めていません
              </p>
            )
          )}
        </div>
      </nav>
      <main className="wf-main">{props.children}</main>
      {props.inspector && (
        <aside className="wf-inspector" aria-label="Task の詳細">
          {props.inspector}
        </aside>
      )}
    </div>
  );
}

export function ScreenHead(props: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="wf-main-head">
      <div>
        <h1 className="wf-title">{props.title}</h1>
        {props.subtitle && <p className="wf-subtitle">{props.subtitle}</p>}
      </div>
      {props.actions && <div className="wf-head-actions">{props.actions}</div>}
    </header>
  );
}
