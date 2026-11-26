import { app, BrowserWindow, session, shell } from "electron";
import { Option } from "effect";
import { browserUserAgent, isSlackLoginUrl, teamSessionFrom } from "../app/slack-session.js";
import { isAllowedExternalUrl } from "./ipc.js";

export type CapturedSlackSession = { token: string; cookie: string; userAgent: string; workspace: string; team: string };

const POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Slack のログイン画面を開き、ログインが済んだらセッション（xoxc- のトークン・d の Cookie）と User-Agent を読み取る（ADR-0010）。
 * ウィンドウは、アプリ本体とは別の、保存先を持たないセッションで開く（読み取ったあとに何も残さないため）。
 * Node の機能も preload も渡さない
 */
export function captureSlackSession(workspace: string): Promise<CapturedSlackSession> {
  const partition = `slack-connect-${Date.now()}`;
  const loginSession = session.fromPartition(partition, { cache: false });
  const userAgent = browserUserAgent(app.userAgentFallback);
  loginSession.setUserAgent(userAgent);

  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    title: "Slack にログイン（live-todo）",
    webPreferences: { session: loginSession, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // ログイン用のウィンドウから新しいウィンドウは開かない。Slack のページはこのウィンドウで、ほかは外部ブラウザで開く
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSlackLoginUrl(url)) void window.loadURL(url);
    else if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // SSO（Google など）でログインできるよう、https のページへの移動は許す。それ以外の種類の URL は開かない
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("https://")) event.preventDefault();
  });

  return new Promise<CapturedSlackSession>((resolve, reject) => {
    let finished = false;
    const finish = (result: { ok: true; value: CapturedSlackSession } | { ok: false; message: string }) => {
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
      if (window.isDestroyed() || !isSlackLoginUrl(window.webContents.getURL())) return;
      void (async () => {
        const localConfig = (await window.webContents.executeJavaScript("localStorage.getItem('localConfig_v2')").catch(() => null)) as string | null;
        const team = teamSessionFrom(localConfig, workspace);
        if (Option.isNone(team)) return;
        const [cookie] = await loginSession.cookies.get({ domain: "slack.com", name: "d" });
        if (cookie === undefined || cookie.value === "") return;
        finish({ ok: true, value: { token: team.value.token, cookie: decodeURIComponent(cookie.value), userAgent, workspace: team.value.workspace, team: team.value.team } });
      })();
    }, POLL_INTERVAL_MS);
    const timeout = setTimeout(() => finish({ ok: false, message: "10 分たってもログインが終わらなかった" }), LOGIN_TIMEOUT_MS);
    window.on("closed", () => finish({ ok: false, message: "ログインが終わる前にウィンドウが閉じられた" }));

    void window.loadURL(workspace === "" ? "https://slack.com/signin" : `https://${workspace}/`);
  });
}
