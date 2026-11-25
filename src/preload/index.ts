import { contextBridge, ipcRenderer } from "electron";
import type { LiveTodoApi } from "../shared/api.js";
import { IPC_CHANNELS } from "../shared/channels.js";

const api: LiveTodoApi = {
  board: () => ipcRenderer.invoke(IPC_CHANNELS.board),
  moveTask: (taskId, status) => ipcRenderer.invoke(IPC_CHANNELS.move, { taskId, status }),
  markSeen: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.seen, taskId),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
};

contextBridge.exposeInMainWorld("liveTodo", api);
