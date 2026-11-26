import { useEffect, useRef } from "react";

/**
 * ドロワーのフォーカスと Escape。閉じるボタンにフォーカスを移すのは、Task を開いたとき（taskId が変わったとき）だけにする。
 * onClose が変わるたびに移さない理由: カンバンを読み直すたびに onClose が作り直されるので、入力中の欄からフォーカスが外れてしまうため
 */
export function useDrawerFocus(taskId: number, onClose: () => void) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const latestOnClose = useRef(onClose);
  latestOnClose.current = onClose;

  useEffect(() => {
    closeButton.current?.focus();
  }, [taskId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && latestOnClose.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return closeButton;
}
