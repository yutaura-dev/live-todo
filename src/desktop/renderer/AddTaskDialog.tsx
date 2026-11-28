import { useEffect, useRef, useState } from "react";
import { Button } from "../../design/components.js";

/** 手で Task を足す。題だけ要る（今の状況は書かなくてよい） */
export function AddTaskDialog(props: { open: boolean; onClose: () => void; onSubmit: (input: { title: string; brief: string | null }) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      // showModal がない環境（テストの DOM）では open 属性だけ付ける
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  const submit = () => {
    if (title.trim() === "") return;
    props.onSubmit({ title: title.trim(), brief: brief.trim() === "" ? null : brief.trim() });
    setTitle("");
    setBrief("");
  };

  return (
    <dialog ref={ref} className="ui-dialog" aria-labelledby="add-task-title" onClose={props.onClose}>
      <form
        className="ui-dialog-body"
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 id="add-task-title" className="ui-dialog-title">
          Task を足す
        </h2>
        <label className="ui-field">
          何をするか
          <input className="ui-input" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        </label>
        <label className="ui-field">
          今の状況（書かなくてよい）
          <textarea className="ui-textarea" value={brief} onChange={(event) => setBrief(event.target.value)} rows={3} />
        </label>
        <div className="ui-row ui-row--end">
          <Button tone="quiet" type="button" onClick={props.onClose}>
            やめる
          </Button>
          <Button tone="primary" type="submit" disabled={title.trim() === ""}>
            足す
          </Button>
        </div>
      </form>
    </dialog>
  );
}
