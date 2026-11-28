import { createContext, useContext, type ReactNode } from "react";
import { BRAND_ICONS, type BrandIcon } from "./brand-icons.js";
import { useScheme } from "./scheme.js";

/**
 * 取得元のサービスのアイコン。各社が配っているファイルを、手を加えずに使う（出どころは assets/brands/README.md）。
 * 色を文字に合わせて塗り替えない理由: どの社もロゴの色の変更を禁じているため。
 */
const BrandIconsContext = createContext<Record<string, BrandIcon>>(BRAND_ICONS);

/** 使うアイコンを差し替える（テストで、あるサービスのアイコンを置いていない状態を作るときなど） */
export function BrandIconsProvider({ icons, children }: { icons: Record<string, BrandIcon>; children: ReactNode }) {
  return <BrandIconsContext.Provider value={icons}>{children}</BrandIconsContext.Provider>;
}

export function useBrandIcon(source: string): string | null {
  const scheme = useScheme();
  const icon = useContext(BrandIconsContext)[source];
  return icon ? icon[scheme] : null;
}

export function SourceIcon({ src, size = 16 }: { src: string; size?: number }) {
  return <img className="ui-source-icon" src={src} width={size} height={size} alt="" draggable={false} />;
}
