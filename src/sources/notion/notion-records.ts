/** 表（block・notification など）ごとの、ID からレコードの中身への対応。中身はまだ検証していない */
export type NotionRecordMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * レコードの入れ子を外す。古い形は { role, value: {...} }、新しい形は { spaceId, value: { value: {...}, role } }。
 * 両方を受ける理由: 同じ API でも、アカウントや時期によってどちらで返るかが違う（react-notion-x の issue #682）
 */
function unwrapRecord(record: unknown): Record<string, unknown> | undefined {
  if (!isObject(record) || !isObject(record["value"])) return undefined;
  const value = record["value"];
  return isObject(value["value"]) && "role" in value ? value["value"] : value;
}

/** 応答の recordMap から、レコードの中身だけの対応を作る。中身のないレコード（見られないページなど）は捨てる */
export function unwrapRecordMap(recordMap: unknown): NotionRecordMap {
  const result: Record<string, Record<string, unknown>> = {};
  if (!isObject(recordMap)) return result;
  for (const [table, records] of Object.entries(recordMap)) {
    if (!isObject(records)) continue;
    const unwrapped: Record<string, unknown> = {};
    for (const [id, record] of Object.entries(records)) {
      const value = unwrapRecord(record);
      if (value !== undefined) unwrapped[id] = value;
    }
    result[table] = unwrapped;
  }
  return result;
}

export type RichTextNames = { users: ReadonlyMap<string, string>; pages: ReadonlyMap<string, string> };

// メンションや日付の位置には、この文字が本文として入り、中身は装飾（["u", ユーザー ID] など）に入る
const INLINE_PLACEHOLDER = "‣";

function inlineText(decorations: unknown, names: RichTextNames): string | undefined {
  if (!Array.isArray(decorations)) return undefined;
  for (const decoration of decorations) {
    if (!Array.isArray(decoration)) continue;
    const [kind, target] = decoration as [unknown, unknown];
    if (kind === "u" && typeof target === "string") return `@${names.users.get(target) ?? "だれか"}`;
    if (kind === "p" && typeof target === "string") return names.pages.get(target) ?? "ページ";
    if (kind === "d" && isObject(target) && typeof target["start_date"] === "string") return target["start_date"];
  }
  return undefined;
}

/** Notion のリッチテキスト（[["文字列", 装飾?], ...]）を、メンションを名前に直した文字列にする */
export function richTextToPlain(richText: unknown, names: RichTextNames): string {
  if (!Array.isArray(richText)) return "";
  let text = "";
  for (const segment of richText) {
    if (!Array.isArray(segment) || typeof segment[0] !== "string") continue;
    const [value, decorations] = segment as [string, unknown];
    text += value === INLINE_PLACEHOLDER ? (inlineText(decorations, names) ?? "") : value;
  }
  return text;
}

export const compactId = (id: string) => id.replaceAll("-", "");
