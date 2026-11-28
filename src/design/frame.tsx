import type { Decorator } from "@storybook/react-vite";
import { SchemeProvider, type SchemeChoice } from "./scheme.js";
import "./tokens.css";
import "./components.css";
import "./screens.css";

/**
 * Storybook で、アプリの窓（hiddenInset のタイトルバー）に見せる枠。
 * 信号の 3 つのボタンは Storybook の中だけに描く。アプリでは macOS が描く。
 * 配色は Storybook のツールバー（globals.scheme）で切り替え、color-scheme を窓に付けて light-dark() に選ばせる。
 */
export const windowed: Decorator = (Story, context) => {
  const scheme = (context.globals as { scheme?: string }).scheme ?? "light";
  return (
    <div lang="ja" className="ui ui-window" style={{ colorScheme: scheme === "system" ? "light dark" : scheme }}>
      <span className="ui-traffic" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <SchemeProvider scheme={scheme as SchemeChoice}>
        <Story />
      </SchemeProvider>
    </div>
  );
};

const schemeOf = (globals: unknown) => {
  const scheme = (globals as { scheme?: string }).scheme ?? "light";
  return scheme === "system" ? "light dark" : scheme;
};

/** 詳細（右に並ぶ 480 の板）だけを見るときの枠。紙の上に板を 1 枚置く */
export const windowedPanel: Decorator = (Story, context) => (
  <div lang="ja" className="ui ui-panel-stage" style={{ colorScheme: schemeOf(context.globals) }}>
    <div className="ui-inspector ui-panel">
      <SchemeProvider scheme={((context.globals as { scheme?: string }).scheme ?? "light") as SchemeChoice}>
        <Story />
      </SchemeProvider>
    </div>
  </div>
);
