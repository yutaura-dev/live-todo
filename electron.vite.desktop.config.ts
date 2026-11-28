import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

// 作り直しのアプリ（src/desktop）。今のアプリの electron.vite.config.ts と並べ、切り替えたら一本にする
// CSP を本番のビルドにだけ入れる理由: 開発サーバーは React の Fast Refresh のためにインラインのスクリプトを差し込むため
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";
const cspInProduction = (): Plugin => ({
  name: "live-todo-csp",
  apply: "build",
  transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`),
});

export default defineConfig({
  main: {
    build: { outDir: "out-desktop/main", rollupOptions: { input: resolve(import.meta.dirname, "src/desktop/main/index.ts") } },
  },
  preload: {
    build: {
      outDir: "out-desktop/preload",
      // sandbox を有効にした preload は CommonJS でしか読み込めないため
      rollupOptions: { input: resolve(import.meta.dirname, "src/desktop/preload/index.ts"), output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/desktop/renderer"),
    build: { outDir: resolve(import.meta.dirname, "out-desktop/renderer"), rollupOptions: { input: resolve(import.meta.dirname, "src/desktop/renderer/index.html") } },
    plugins: [react(), cspInProduction()],
  },
});
