import { useCallback, useEffect, useState } from "react";
import type { RecurringTaskView } from "../../shared/api.js";
import { api } from "./api.js";
import { RecurrenceFields } from "./TaskDrawer.js";

const periodText = (period: string | null) => (period === null ? "まだ作っていない" : `${Number(period.slice(5))}月分まで作った`);

/** 定期の Task の決まり。ここでの変更は、設定の保存を待たずにすぐ反映する */
export function RecurringSettings() {
  const [rules, setRules] = useState<RecurringTaskView[] | null>(null);
  const reload = useCallback(async () => setRules(await api.recurringList()), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section className="settings-section" aria-labelledby="recurring-heading">
      <h3 id="recurring-heading" className="section-title">
        定期の Task
      </h3>
      <p className="field-hint">毎月決まった日に、決まった手順つきの Task を作ります。ここでの変更はすぐに反映します（「設定を保存」は要りません）</p>
      {rules === null ? <p className="field-hint">読み込んでいます</p> : rules.map((rule) => <RecurringEditor key={rule.id} rule={rule} onChanged={reload} />)}
      <AddRecurring onAdded={reload} />
    </section>
  );
}

function RecurringEditor({ rule, onChanged }: { rule: RecurringTaskView; onChanged: () => Promise<void> }) {
  const [title, setTitle] = useState(rule.title);
  const [note, setNote] = useState(rule.note);
  const [day, setDay] = useState(rule.schedule.day);
  const [leadDays, setLeadDays] = useState(rule.schedule.leadDays);
  const [message, setMessage] = useState<string | null>(null);
  const save = async (patch: Parameters<typeof api.recurringUpdate>[0]) => {
    const outcome = await api.recurringUpdate(patch);
    setMessage(outcome.ok ? "保存しました" : `保存できませんでした: ${outcome.message}`);
    await onChanged();
  };
  return (
    <details className="account">
      <summary className="account-header">
        <h4 className="account-name">{rule.title}</h4>
        <span className="field-hint">
          毎月 {rule.schedule.day} 日{rule.schedule.leadDays > 0 ? `（${rule.schedule.leadDays} 日前から）` : ""}・{rule.active ? periodText(rule.lastPeriod) : "止めている"}
        </span>
      </summary>
      <div className="account-body">
        <label className="field">
          <span className="field-label">タイトル</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <RecurrenceFields day={day} leadDays={leadDays} note={note} onDay={setDay} onLeadDays={setLeadDays} onNote={setNote} />
        <div className="merge-confirm-actions">
          <button type="button" className="primary-button" onClick={() => void save({ id: rule.id, title, note, schedule: { kind: "monthly", day, leadDays } })}>
            保存
          </button>
          <button type="button" className="quiet-button" onClick={() => void save({ id: rule.id, active: !rule.active })}>
            {rule.active ? "止める" : "再開する"}
          </button>
          {message && <span className="field-hint">{message}</span>}
        </div>
      </div>
    </details>
  );
}

function AddRecurring({ onAdded }: { onAdded: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [day, setDay] = useState(1);
  const [leadDays, setLeadDays] = useState(0);
  const [includeCurrent, setIncludeCurrent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submit = async () => {
    const outcome = await api.recurringCreate({ title, note, schedule: { kind: "monthly", day, leadDays }, includeCurrent });
    if (!outcome.ok) {
      setMessage(`登録できませんでした: ${outcome.message}`);
      return;
    }
    setTitle("");
    setNote("");
    setMessage("登録しました");
    await onAdded();
  };
  return (
    <div className="add-recurring">
      <label className="field">
        <span className="field-label">定期の Task を追加</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="請求書を送る" />
      </label>
      <RecurrenceFields
        day={day}
        leadDays={leadDays}
        note={note}
        includeCurrent={includeCurrent}
        onDay={setDay}
        onLeadDays={setLeadDays}
        onNote={setNote}
        onIncludeCurrent={setIncludeCurrent}
      />
      <div className="merge-confirm-actions">
        <button type="button" className="quiet-button" disabled={title.trim() === ""} onClick={() => void submit()}>
          追加する
        </button>
        {message && <span className="field-hint">{message}</span>}
      </div>
    </div>
  );
}
