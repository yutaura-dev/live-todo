import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

// CSP を本番のビルドにだけ入れる理由: 開発サーバーは React の Fast Refresh のためにインラインのスクリプトを差し込み、
// script-src 'self' だと動かなくなるため。
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";
const cspInProduction = (): Plugin => ({
  name: "live-todo-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`),
});

export default defineConfig({
  main: {},
  preload: {
    build: {
      // sandbox を有効にした preload は CommonJS でしか読み込めないため
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react(), cspInProduction()],
  },
});
