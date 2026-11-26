const TITLE_LENGTH = 80;

/** Slack の書式（<@U…>、<#C…|name> など）の中で、名前を調べる必要のあるユーザーの ID */
export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((match) => match[1]!))];
}

function readable(line: string, names: { users: ReadonlyMap<string, string> }): string {
  return line
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, label?: string) => `@${label ?? names.users.get(id) ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `#${label === undefined || label === "" ? id : label}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label?: string) => label ?? "@group")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, word: string) => `@${word}`)
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, (_, _url: string, label: string) => label)
    .replace(/<(https?:[^>]+)>/g, (_, url: string) => url)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

// メンションと絵文字だけの行は、何をするかを表さないのでタイトルにしない
const hasContent = (line: string) => line.replace(/@\S+|:[a-z0-9_+'-]+:|\s/gi, "") !== "";

const cut = (line: string) => (line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH)}…` : line);

/** メッセージの本文から、Task のタイトルにする 1 行を作る */
export function slackTitleLine(text: string, names: { users: ReadonlyMap<string, string> }): string {
  const lines = text
    .split("\n")
    .map((line) => readable(line, names))
    .filter((line) => line !== "");
  return cut(lines.find(hasContent) ?? lines[0] ?? "");
}
