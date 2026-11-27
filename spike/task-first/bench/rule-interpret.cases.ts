import type { Reading } from "../rule-interpret.js";

// 作った例。実在の案件・人・リポジトリを書かない
export type InterpretCase = { id: string; then: string; expected: Reading; split?: "tuning" | "final" };

const ok = (taskAction: "done" | "dismissed" | "todo" | "none", o: { markRead?: boolean; archive?: boolean; addLabel?: boolean } = {}): Reading => ({
  ok: true,
  taskAction,
  markRead: o.markRead ?? false,
  archive: o.archive ?? false,
  addLabel: o.addLabel ?? false,
});

export const interpretCases: ReadonlyArray<InterpretCase> = [
  { id: "done-1", then: "完了にする", expected: ok("done") },
  { id: "done-2", then: "そのまま終わったことにしておいて", expected: ok("done") },
  { id: "done-3", then: "Done に移す", expected: ok("done") },
  { id: "dismiss-1", then: "対象外にする", expected: ok("dismissed") },
  { id: "dismiss-2", then: "自分がやることではないので片付ける", expected: ok("dismissed") },
  { id: "dismiss-3", then: "無視してよい", expected: ok("dismissed") },
  { id: "todo-1", then: "必ず todo に入れる", expected: ok("todo") },
  { id: "todo-2", then: "要確認にせず、やることとして扱う", expected: ok("todo") },
  { id: "gmail-1", then: "既読にしてアーカイブする", expected: ok("none", { markRead: true, archive: true }) },
  { id: "gmail-2", then: "「レシート」ラベルを付けて既読にする", expected: ok("none", { markRead: true, addLabel: true }) },
  { id: "gmail-3", then: "経費というラベルをつける", expected: ok("none", { addLabel: true }) },
  { id: "both-1", then: "既読にして、Task は完了にする", expected: ok("done", { markRead: true }) },
  { id: "both-2", then: "アーカイブして対象外にする", expected: ok("dismissed", { archive: true }) },
  { id: "cond-1", then: "YutaUra(または YutaUra を含むグループ宛て) にレビュー依頼がない場合はそのまま完了にする", expected: { ok: false, reason: "condition" } },
  { id: "cond-2", then: "金額が 1 万円以上なら todo にする", expected: { ok: false, reason: "condition" } },
  { id: "cond-3", then: "返信が来ていなければ既読にする", expected: { ok: false, reason: "condition" } },
  { id: "cond-4", then: "bot 以外の PR は対象外にする", expected: { ok: false, reason: "condition" } },
  { id: "unsup-1", then: "ゴミ箱に入れる", expected: { ok: false, reason: "unsupported" } },
  { id: "unsup-2", then: "「確認しました」と返信する", expected: { ok: false, reason: "unsupported" } },
  { id: "unsup-3", then: "PR を approve してマージする", expected: { ok: false, reason: "unsupported" } },
  { id: "unsup-4", then: "経理に転送して完了にする", expected: { ok: false, reason: "unsupported" } },
  { id: "unclear-1", then: "いい感じにしておいて", expected: { ok: false, reason: "unclear" } },
  { id: "unclear-2", then: "あとで考える", expected: { ok: false, reason: "unclear" } },

  { id: "f-done-1", split: "final", then: "クローズ扱いにする", expected: ok("done") },
  { id: "f-dismiss-1", split: "final", then: "自分には関係ないものとして消しておく", expected: ok("dismissed") },
  { id: "f-todo-1", split: "final", then: "やることリストに必ず残す", expected: ok("todo") },
  { id: "f-gmail-1", split: "final", then: "受信トレイから外して既読にする", expected: ok("none", { markRead: true, archive: true }) },
  { id: "f-both-1", split: "final", then: "「請求」ラベルを付けて、Task は終わったことにする", expected: ok("done", { addLabel: true }) },
  { id: "f-cond-1", split: "final", then: "自分がアサインされていないときは対象外にする", expected: { ok: false, reason: "condition" } },
  { id: "f-cond-2", split: "final", then: "週末に届いたものだけ既読にする", expected: { ok: false, reason: "condition" } },
  { id: "f-unsup-1", split: "final", then: "Slack で作成者にお礼を送る", expected: { ok: false, reason: "unsupported" } },
  { id: "f-unsup-2", split: "final", then: "メールを削除する", expected: { ok: false, reason: "unsupported" } },
];
