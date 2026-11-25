import type { LiveTodoApi } from "../../shared/api.js";
import { mockApi } from "./mock.js";

declare global {
  interface Window {
    liveTodo?: LiveTodoApi;
  }
}

/** Electron の中では preload の API を、ブラウザで画面だけを確かめるときは偽のデータを使う */
export const api: LiveTodoApi = window.liveTodo ?? mockApi;
export const isMock = window.liveTodo === undefined;
