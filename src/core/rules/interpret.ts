import type { ActionInterpretation } from "../judge/mail-classifier.js";
import type { GmailRuleActions } from "./rule.js";

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

// これ以上の確率で読み取れた操作だけを行う（自動で書き込むので、迷う操作は入れない）
const ACTION_PROBABILITY = 0.7;
// これ以上の確率で、アプリにできない操作を求めていれば保存させない
const UNSUPPORTED_PROBABILITY = 0.5;

export type InterpretedActions = { ok: true; actions: { gmail: GmailRuleActions } } | { ok: false; reason: string };

/** Decisions が読み取った「何をする」を、アプリの操作にする。読み取れない・できない操作を含むなら、理由を返す */
export function actionsFromInterpretation(interpretation: ActionInterpretation): InterpretedActions {
  const sure = (probability: number | undefined) => probability !== undefined && probability >= ACTION_PROBABILITY;
  if (interpretation.unsupported === undefined || interpretation.unsupported >= UNSUPPORTED_PROBABILITY) {
    return { ok: false, reason: "ルールでは、既読・アーカイブ・ラベルを付ける以外の操作（ゴミ箱・削除・返信・送信など）はできない" };
  }
  const labels = sure(interpretation.addLabel) ? (interpretation.label === undefined ? undefined : [interpretation.label]) : [];
  if (labels === undefined) return { ok: false, reason: "付けるラベルの名前が分かりません。「レシート」のように名前を書いてください" };
  const gmail = { labels, markRead: sure(interpretation.markRead), archive: sure(interpretation.archive) };
  if (gmail.labels.length === 0 && !gmail.markRead && !gmail.archive) return { ok: false, reason: "何をするかを読み取れませんでした" };
  return { ok: true, actions: { gmail } };
}
