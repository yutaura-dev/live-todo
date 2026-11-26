import { contextBridge, ipcRenderer } from "electron";
import type { LiveTodoApi } from "../shared/api.js";
import { IPC_CHANNELS } from "../shared/channels.js";

const api: LiveTodoApi = {
  board: () => ipcRenderer.invoke(IPC_CHANNELS.board),
  moveTask: (taskId, status) => ipcRenderer.invoke(IPC_CHANNELS.move, { taskId, status }),
  markSeen: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.seen, taskId),
  taskDetail: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.taskDetail, taskId),
  mergePlan: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.mergePlan, taskId),
  merge: (taskId, approved) => ipcRenderer.invoke(IPC_CHANNELS.merge, { taskId, ...approved }),
  requestReview: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.requestReview, taskId),
  completeStep: (taskId, stepId) => ipcRenderer.invoke(IPC_CHANNELS.completeStep, { taskId, stepId }),
  chooseOption: (taskId, stepId, optionKey) => ipcRenderer.invoke(IPC_CHANNELS.chooseOption, { taskId, stepId, optionKey }),
  reopenStep: (taskId, stepId) => ipcRenderer.invoke(IPC_CHANNELS.reopenStep, { taskId, stepId }),
  replanNextActions: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.replanNextActions, taskId),
  resolveConflicts: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.resolveConflicts, taskId),
  conflictResolution: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.conflictResolution, taskId),
  pushConflictResolution: (taskId, commitSha) => ipcRenderer.invoke(IPC_CHANNELS.pushConflictResolution, { taskId, commitSha }),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  settings: () => ipcRenderer.invoke(IPC_CHANNELS.settings),
  saveConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.saveConfig, config),
  setSecret: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.setSecret, { key, value }),
  removeSecret: (key) => ipcRenderer.invoke(IPC_CHANNELS.removeSecret, key),
  addTask: (input) => ipcRenderer.invoke(IPC_CHANNELS.addTask, input),
  recurringList: () => ipcRenderer.invoke(IPC_CHANNELS.recurringList),
  recurringGhosts: () => ipcRenderer.invoke(IPC_CHANNELS.recurringGhosts),
  recurringCreateNow: (ruleId) => ipcRenderer.invoke(IPC_CHANNELS.recurringCreateNow, ruleId),
  recurringCreate: (input) => ipcRenderer.invoke(IPC_CHANNELS.recurringCreate, input),
  recurringFromTask: (input) => ipcRenderer.invoke(IPC_CHANNELS.recurringFromTask, input),
  recurringUpdate: (input) => ipcRenderer.invoke(IPC_CHANNELS.recurringUpdate, input),
  fixPullRequest: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.fixPullRequest, taskId),
  pullRequestFix: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.pullRequestFix, taskId),
  pushPullRequestFix: (taskId, commitSha) => ipcRenderer.invoke(IPC_CHANNELS.pushPullRequestFix, { taskId, commitSha }),
  slackAction: (taskId, action) => ipcRenderer.invoke(IPC_CHANNELS.slackAction, { taskId, action }),
  connectSlack: (accountId, workspace) => ipcRenderer.invoke(IPC_CHANNELS.connectSlack, { accountId, workspace }),
  testSlack: (accountId) => ipcRenderer.invoke(IPC_CHANNELS.testSlack, accountId),
  previewFilter: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewFilter, request),
};

contextBridge.exposeInMainWorld("liveTodo", api);
