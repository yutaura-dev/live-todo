// @vitest-environment happy-dom
import { assert, describe, it } from "@effect/vitest";
import { act, render } from "@testing-library/react";
import { useDrawerFocus } from "./use-drawer-focus.js";

function Drawer(props: { taskId: number; onClose: () => void }) {
  const closeButton = useDrawerFocus(props.taskId, props.onClose);
  return (
    <div>
      <button ref={closeButton}>閉じる</button>
      <textarea aria-label="質問" />
    </div>
  );
}

describe("useDrawerFocus（ドロワーのフォーカス）", () => {
  it("開いたときは閉じるボタンにフォーカスを移す", () => {
    const view = render(<Drawer taskId={1} onClose={() => {}} />);
    assert.strictEqual(document.activeElement, view.getByText("閉じる"));
    view.unmount();
  });

  it("カンバンを読み直して閉じる処理が作り直されても、入力中の欄からフォーカスを外さない", () => {
    const view = render(<Drawer taskId={1} onClose={() => {}} />);
    const input = view.getByLabelText("質問");
    act(() => (input as HTMLTextAreaElement).focus());

    view.rerender(<Drawer taskId={1} onClose={() => {}} />);

    assert.strictEqual(document.activeElement, input);
    view.unmount();
  });

  it("別の Task を開いたときは、閉じるボタンにフォーカスを移し直す", () => {
    const view = render(<Drawer taskId={1} onClose={() => {}} />);
    act(() => (view.getByLabelText("質問") as HTMLTextAreaElement).focus());
    view.rerender(<Drawer taskId={2} onClose={() => {}} />);
    assert.strictEqual(document.activeElement, view.getByText("閉じる"));
    view.unmount();
  });

  it("Escape で、そのときの閉じる処理を呼ぶ", () => {
    let closed = "";
    const view = render(<Drawer taskId={1} onClose={() => (closed = "first")} />);
    view.rerender(<Drawer taskId={1} onClose={() => (closed = "latest")} />);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    assert.strictEqual(closed, "latest");
    view.unmount();
  });
});
