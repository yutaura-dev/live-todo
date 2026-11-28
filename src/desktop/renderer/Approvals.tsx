import { ScreenHead } from "../../design/AppShell.js";
import { Button, Problem } from "../../design/components.js";
import type { InboxCommand, WriteView } from "../shared/api.js";

/** 承認。外への書き込みは、ここで承認するまでしない（charter）。承認を待つものと、書き込めなかったものを集める */
export function Approvals(props: { writes: ReadonlyArray<WriteView>; onCommand: (command: InboxCommand) => void }) {
  const waiting = props.writes.filter((write) => write.stage === "承認待ち");
  const failed = props.writes.filter((write) => write.stage === "失敗");
  return (
    <>
      <ScreenHead title="承認" subtitle="外への書き込みは、ここで承認するまでしません" />
      {props.writes.length === 0 && <p className="ui-empty">承認を待つ書き込みはありません。計画の書き込みを頼むと、ここに出ます</p>}
      {waiting.length > 0 && (
        <section className="ui-section" aria-label="承認を待っている書き込み">
          <h2 className="ui-section-title">承認を待っている書き込み</h2>
          {waiting.map((write) => (
            <article key={write.id} className="ui-focus" aria-label={write.summary}>
              <p className="ui-focus-from">Task「{write.taskTitle}」の計画から</p>
              <figure className="ui-outgoing">
                <figcaption>書き込む中身</figcaption>
                <div className="ui-outgoing-body">
                  <p>{write.summary}</p>
                </div>
              </figure>
              <div className="ui-decide-actions">
                <Button tone="primary" size="lg" onClick={() => props.onCommand({ _tag: "ApproveWrite", id: write.id })}>
                  承認して書き込む
                </Button>
                <Button tone="quiet" size="lg" onClick={() => props.onCommand({ _tag: "CancelWrite", id: write.id })}>
                  やめる
                </Button>
              </div>
            </article>
          ))}
        </section>
      )}
      {failed.length > 0 && (
        <section className="ui-section" aria-label="書き込めなかったもの">
          <h2 className="ui-section-title">書き込めなかったもの</h2>
          {failed.map((write) => (
            <article key={write.id} className="ui-focus" aria-label={write.summary}>
              <p className="ui-focus-from">Task「{write.taskTitle}」から</p>
              <Problem title={write.summary}>
                <p>{write.failure}</p>
                <p className="ui-sub">直したら、Task の計画からもう一度頼んでください</p>
              </Problem>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
