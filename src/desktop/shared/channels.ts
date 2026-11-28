// preload からも読むので、何も import しない（sandbox の preload は外部のモジュールを require できないため）
export const CHANNELS = { command: "live-todo:command", query: "live-todo:query", changed: "live-todo:changed" } as const;
