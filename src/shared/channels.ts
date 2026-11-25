/** main と preload で共有する IPC のチャンネル名。preload に依存を持ち込まないよう、このファイルは何も import しない */
export const IPC_CHANNELS = {
  board: "board:get",
  move: "board:move",
  seen: "board:seen",
  openExternal: "external:open",
  settings: "settings:get",
  saveConfig: "settings:save-config",
  setSecret: "settings:set-secret",
  removeSecret: "settings:remove-secret",
  previewFilter: "settings:preview-filter",
  taskDetail: "board:task-detail",
  mergePlan: "board:merge-plan",
  merge: "board:merge",
  requestReview: "board:request-review",
  completeStep: "board:complete-step",
  chooseOption: "board:choose-option",
} as const;
