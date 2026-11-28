import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { LiveTodoApi } from "../shared/api.js";
import { App } from "./App.js";
import "./app.css";

// window.liveTodo を global の型で宣言しない理由: 今のアプリ（src/renderer）が別の形で同じ名前を宣言していて、型がぶつかるため
const api = (window as unknown as { liveTodo: LiveTodoApi }).liveTodo;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
