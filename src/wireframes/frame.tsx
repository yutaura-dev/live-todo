import type { Decorator } from "@storybook/react-vite";
import type { ReactNode } from "react";
import "./wireframe.css";

export type WfNotes = {
  /** 番号付きの注釈。番号は画面の中の Mark と対応させる */
  notes?: Array<{ n: number; text: string }>;
  /** 要素に結び付かない、未解決の問い */
  questions?: string[];
  /** 窓の大きさ（既定は PC の 1440×900） */
  width?: number;
  height?: number;
};

/**
 * 実寸の窓（Electron のアプリの窓を簡略化したもの）と、窓の外に並べる注釈の一覧。
 * 注釈を窓の中に書かない理由: 画面の情報と、検討のための情報が混ざらないように。
 */
export function WfFrame({ notes = [], questions = [], width = 1440, height = 900, children }: WfNotes & { children: ReactNode }) {
  return (
    <div className="wf wf-sheet">
      <div className="wf-window" style={{ inlineSize: width, blockSize: height }}>
        <div className="wf-titlebar" aria-hidden="true">
          <span className="wf-titlebar-dot" />
          <span className="wf-titlebar-dot" />
          <span className="wf-titlebar-dot" />
          <span>live-todo</span>
        </div>
        <div className="wf-window-body">{children}</div>
      </div>
      {(notes.length > 0 || questions.length > 0) && (
        <section className="wf-notes" aria-label="注釈">
          {notes.length > 0 && (
            <>
              <h2>注釈</h2>
              <ol>
                {notes.map((note) => (
                  <li key={note.n} data-wf-note={note.n}>
                    <span className="wf-mark">{note.n}</span>
                    <span>{note.text}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
          {questions.length > 0 && (
            <>
              <h2>未解決の問い</h2>
              <ul>
                {questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** story の parameters.wf を読んで、実寸の窓に入れるデコレーター */
export const framed: Decorator = (Story, context) => (
  <WfFrame {...((context.parameters as { wf?: WfNotes }).wf ?? {})}>
    <Story />
  </WfFrame>
);
