/** 届いた事実（Source Item）。trusted はアプリが書いた情報、body は外から来た文字列 */
export type Fact = {
  id: string;
  source: string;
  /** 種類・リポジトリ・通知の理由・作成者など、アプリが API の値から書いた行 */
  trusted: ReadonlyArray<string>;
  /** タイトル・本文など、外の人が書いた文字列 */
  body: string;
  url?: string;
  at: string;
  state?: "open" | "resolved" | "removed";
};

export type TaskStatus = "todo" | "in_progress" | "done" | "needs_review" | "dismissed";

export type TaskDossier = {
  id: string;
  title: string;
  /** 今の状況と次の一手。AI が事実から書いたものなので、本文と同じく信頼しない */
  brief?: string;
  status: TaskStatus;
  /** Task の作られ方。アプリが知っている事実なので trusted として渡す */
  origin?: "manual" | "source" | "recurring";
  facts: ReadonlyArray<Fact>;
};

/** アプリが書いた情報。Decisions の instructions に入れる（本文に書かれた偽の行と区別するため） */
export const trustedOf = (task: TaskDossier) =>
  [
    `Task の状態: ${task.status}`,
    `紐づく事実の数: ${task.facts.length}`,
    ...task.facts.map((fact, index) => [`[事実 ${index + 1}] Source: ${fact.source}${fact.state === undefined ? "" : ` / 状態: ${fact.state}`}`, ...fact.trusted].join("\n")),
  ].join("\n\n");

/** 外から来た文字列。Decisions の input に入れる */
export const untrustedOf = (task: TaskDossier) => ({
  task: { title: task.title, ...(task.brief === undefined ? {} : { brief: task.brief }) },
  facts: task.facts.map((fact, index) => ({ fact: index + 1, body: fact.body })),
});
