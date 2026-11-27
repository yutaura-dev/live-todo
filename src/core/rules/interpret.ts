/**
 * 「何をする」の文から、付けるラベルの名前の候補を取り出す。Decisions は文字を作れないので、名前は候補から選ばせる
 * （Gmail にあるラベルと合わせて候補にする）
 */
export function labelCandidatesOf(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/「([^」]+)」/g)) found.add(match[1]!.trim());
  // 「」のすぐ後ろ（「経費」というラベル）は、上で取った名前なので取り直さない
  for (const match of text.matchAll(/(?<![」\p{L}\p{N}/])([^\s、。「」]+?)\s*(?:という)?ラベル/gu)) {
    const name = match[1]!.replace(/[をにのはが]$/, "").trim();
    if (name !== "" && name !== "という") found.add(name);
  }
  return [...found].filter((name) => name !== "");
}
