import type { AutonomyView, InboxCommand } from "../shared/api.js";

const LEVELS = ["調べる", "ローカルの書き込み", "外への書き込み（下書き）", "外への書き込み（本番）"] as const;

/** 自動でやってよい範囲（ADR-0023）。操作ごとに、どの段まで承認なしでやってよいかを選ぶ。決めていない操作は、ローカルの書き込みまで */
export function Autonomy(props: { rows: ReadonlyArray<AutonomyView>; onInbox: (command: InboxCommand) => Promise<string | null> }) {
  return (
    <section className="ui-settings-section" aria-labelledby="settings-autonomy">
      <h2 id="settings-autonomy" className="ui-settings-title">
        自動でやってよい範囲
      </h2>
      <p className="ui-sub">
        選んだ段までは、計画の「自動でやる」項目の番が来たら、確かめずに書き込みます。自動で書き込むのは、その Task が追っている事実そのものだけです。決めていない操作は、外へは自動で書き込みません
      </p>
      <ul className="ui-stack-4">
        {props.rows.map((row) => {
          const id = `autonomy-${row.operation.replace(/[^a-z0-9]/gi, "-")}`;
          return (
            <li key={row.operation} className="ui-row">
              <label htmlFor={id}>{row.label}</label>
              <select
                id={id}
                className="ui-select"
                value={row.limit ?? ""}
                onChange={(event) => void props.onInbox({ _tag: "SetOperationLimit", operation: row.operation, limit: event.target.value === "" ? null : (event.target.value as (typeof LEVELS)[number]) })}
              >
                <option value="">決めていない（ローカルの書き込みまで）</option>
                {LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}まで
                  </option>
                ))}
              </select>
              <span className="ui-sub">この操作は「{row.level}」</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
