import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

export type SchemeChoice = "light" | "dark" | "system";

const SchemeContext = createContext<SchemeChoice>("system");

/**
 * 画面の配色を子に伝える。CSS の色は light-dark() で決まるが、画像（各社の公式アイコン）は
 * 配色ごとに別のファイルを選ぶ必要があり、CSS からは選べないので、配色を React でも持つ。
 */
export function SchemeProvider({ scheme, children }: { scheme: SchemeChoice; children: ReactNode }) {
  return <SchemeContext.Provider value={scheme}>{children}</SchemeContext.Provider>;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

const subscribe = (onChange: () => void) => {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

const systemIsDark = () => typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;

/** いま使われている配色。「OS に合わせる」なら OS の設定を見て、変わったら追いかける */
export function useScheme(): "light" | "dark" {
  const choice = useContext(SchemeContext);
  const dark = useSyncExternalStore(subscribe, systemIsDark, () => false);
  if (choice === "system") return dark ? "dark" : "light";
  return choice;
}
