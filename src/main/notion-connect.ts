import { app, BrowserWindow, session, shell } from "electron";
import { Option } from "effect";
import { isNotionUrl, type NotionSession, notionSessionFrom } from "../app/notion-session.js";
import { browserUserAgent } from "../app/slack-session.js";
import { isAllowedExternalUrl } from "./ipc.js";

export type CapturedNotionSession = NotionSession & { userAgent: string };

const POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Notion のログイン画面を開き、ログインが済んだらセッション（Cookie の token_v2 とユーザー）と User-Agent を読み取る（ADR-0015）。
 * Slack と同じく、保存先を持たないセッションで開き、Node の機能も preload も渡さない
 */
export function captureNotionSession(): Promise<CapturedNotionSession> {
  const partition = `notion-connect-${Date.now()}`;
  const loginSession = session.fromPartition(partition, { cache: false });
  const userAgent = browserUserAgent(app.userAgentFallback);
  loginSession.setUserAgent(userAgent);

  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    title: "Notion にログイン（live-todo）",
    webPreferences: { session: loginSession, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isNotionUrl(url)) void window.loadURL(url);
    else if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // SSO（Google など）でログインできるよう、https のページへの移動は許す
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("https://")) event.preventDefault();
  });

  return new Promise<CapturedNotionSession>((resolve, reject) => {
    let finished = false;
    const finish = (result: { ok: true; value: CapturedNotionSession } | { ok: false; message: string }) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      clearTimeout(timeout);
      if (!window.isDestroyed()) window.close();
      void loginSession.clearStorageData();
      if (result.ok) resolve(result.value);
      else reject(new Error(result.message));
    };

    const timer = setInterval(() => {
      if (window.isDestroyed()) return;
      void loginSession.cookies.get({}).then((cookies) => {
        const found = notionSessionFrom(cookies);
        if (Option.isSome(found)) finish({ ok: true, value: { ...found.value, userAgent } });
      });
    }, POLL_INTERVAL_MS);
    const timeout = setTimeout(() => finish({ ok: false, message: "10 分たってもログインが終わらなかった" }), LOGIN_TIMEOUT_MS);
    window.on("closed", () => finish({ ok: false, message: "ログインが終わる前にウィンドウが閉じられた" }));

    void window.loadURL("https://www.notion.so/login");
  });
}
