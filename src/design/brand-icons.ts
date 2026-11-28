/**
 * 取得元のサービスのアイコンのファイル（assets/brands/）。ファイル名は取得元の名前（github.svg）で、
 * ダークの配色で別のファイルを使うときは名前に -dark を付ける（github-dark.svg）。
 * ファイルを置くだけで使えるように、名前から読み込む（置いていないサービスは名前の文字で示す）。
 */
export type BrandIcon = { light: string; dark: string };

const FILE_PATTERN = /\/([a-z0-9]+?)(-dark)?\.(svg|png)$/;

export function brandIconsFrom(files: Record<string, string>): Record<string, BrandIcon> {
  const found: Record<string, { light?: string; dark?: string }> = {};
  for (const [path, url] of Object.entries(files)) {
    const match = FILE_PATTERN.exec(path);
    if (!match?.[1]) continue;
    const entry = (found[match[1]] ??= {});
    if (match[2]) entry.dark = url;
    else entry.light = url;
  }
  const icons: Record<string, BrandIcon> = {};
  for (const [source, entry] of Object.entries(found)) {
    const light = entry.light ?? entry.dark;
    if (light === undefined) continue;
    icons[source] = { light, dark: entry.dark ?? light };
  }
  return icons;
}

export const BRAND_ICONS = brandIconsFrom(import.meta.glob<string>("./assets/brands/*.{svg,png}", { eager: true, query: "?url", import: "default" }));
