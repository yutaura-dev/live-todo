/** main と preload で共有する IPC のチャンネル名。preload に依存を持ち込まないよう、このファイルは何も import しない */
export const IPC_CHANNELS = {
  board: "board:get",
  move: "board:move",
  seen: "board:seen",
  openExternal: "external:open",
} as const;
