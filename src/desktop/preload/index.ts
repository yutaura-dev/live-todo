import { contextBridge, ipcRenderer } from "electron";
import type { LiveTodoApi } from "../shared/api.js";
import { CHANNELS } from "../shared/channels.js";

// renderer に渡すのは、この 4 つだけ（ipcRenderer そのものは渡さない）
const api: LiveTodoApi = {
  command: (command) => ipcRenderer.invoke(CHANNELS.command, command),
  board: () => ipcRenderer.invoke(CHANNELS.query, { _tag: "Board" }),
  task: (id) => ipcRenderer.invoke(CHANNELS.query, { _tag: "Task", id }),
  onChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(CHANNELS.changed, handler);
    return () => ipcRenderer.removeListener(CHANNELS.changed, handler);
  },
};

contextBridge.exposeInMainWorld("liveTodo", api);
