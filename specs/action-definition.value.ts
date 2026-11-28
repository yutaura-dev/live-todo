import type { Condition, Subject } from "./condition.value.ts";
import type { Place } from "./place.value.ts";
import type { DueDate } from "./due-date.value.ts";

/**
 * やることの中身（何をするか・何によって果たされるか）。Action Item はこれを持つ。
 * 分かれ道の選択肢の先の計画（まだ Action Item になっていない案）も、これで書く。選んだときに、中身から Action Item を作る。
 */
export type ActionDefinition = {
  /** 何をするか */
  title: string;
  /** 手間。Task の難易度は、いま着手できる Action Item のうち一番手間の少ないもので決まる。wait と分かれ道は手間を数えない */
  effort: Effort;
  /** 期日（ない・分からなければ null）。計画を立てるときに Generation が入れる。Task の優先度の材料になる */
  due: DueDate | null;
  /** 何によって果たされるか（誰が・何で済ませるか） */
  how: How;
  /** 完了条件か。完了条件の Action Item がすべて果たされると、Task の完了条件を満たす（まだ選んでいない分かれ道は、すべての枝の完了条件で） */
  completes: boolean;
};

/** 何によって果たされるか。種類（type）ごとに、要るものが違う */
export type How =
  /** 人が「済んだ」を押して果たす */
  | { type: "human"; place: Place | null }
  /** Claude Code が果たす（人が「済んだ」を押して済ませてもよい） */
  | { type: "claude"; trigger: Trigger; workspace: string | null; tools: "読むだけ" | "直す"; subject: Subject | null }
  /** 待つ条件が成り立って果たされる。アプリ（Watcher）が見張る */
  | { type: "condition"; condition: Condition }
  /** 外への書き込み（merge する・メールに返信する など）が承認されて成功すると果たされる。何に・どの操作で・どの中身を・作る操作ならどこに作るか（作る場所。元の事実の URI が作る場所の URI の中にあるとき「同じ場所」）と、計画を立てたときの対象の版を持つ（自動でやってよい範囲に入るなら、この中身と版のまま自動で書き込む。書き込み 1 回は、頼んだときにできて、この Action Item を指す） */
  | { type: "write"; subject: Subject; operation: string; params: unknown; version: string | null; trigger: Trigger; place: Subject | null }
  /** ユーザーが選択肢から 1 つ選んで果たす。選ぶと、選んだ選択肢の先が計画に差し込まれる */
  | Decision;

/** 分かれ道 */
export type Decision = {
  type: "decision";
  /** 何を決めるか（決めるために読むもの・選択肢の比べ方など） */
  question: string;
  /** 選択肢 */
  options: Option[];
};

/** 分かれ道の選択肢 */
export type Option = {
  /** 選択肢の名前（そのまま merge する・ひとまず調査する など） */
  label: string;
  /** 選んだら、どう進めるか */
  then: OptionThen;
};

/** 選んだら、どう進めるか */
export type OptionThen =
  /** 先の計画が決まっている。選ぶと、この計画の中身から Action Item を作って差し込む */
  | { type: "planned"; plan: DefinitionTree }
  /** 選んでから、AI が先の計画を考える。direction はその方針（ひとまず調査する など） */
  | { type: "planLater"; direction: string };

/** 中身の並び。入れ子にでき、中に分かれ道を置ける */
export type DefinitionTree = {
  /** 並べ方 */
  type: Arrangement;
  /** 並べる中身か、入れ子の並びか、完了したときにすること */
  items: Array<ActionDefinition | DefinitionTree | CompletionEffectDefinition>;
};

/**
 * 完了したときにすることの中身（Task が完了したら書き込むこと。レビュー依頼のメールをアーカイブする・Slack の To-do を済ませる など）。
 * やること（Action Item）ではないので、番に入らず、完了条件にもならない。計画の木のどこに置いたかで効くかが決まる（根元ならいつでも、分かれ道の枝の下なら、その枝を選んだときだけ）。
 */
export type CompletionEffectDefinition = {
  type: "completionEffect";
  /** 何をするか */
  title: string;
  /** 何に書き込むか（名指しする。完了のときに事実を探さない） */
  subject: Subject;
  /** どの操作か（provider が決めた名前） */
  operation: string;
  /** 操作ごとの中身（形は provider が決める） */
  params: unknown;
};

export const Arrangement = {
  /** 前のものが済んでから、次のものに番が来る */
  serial: "serial",
  /** すべてに同時に番が来る */
  parallel: "parallel",
} as const;
export type Arrangement = (typeof Arrangement)[keyof typeof Arrangement];

export const Trigger = {
  /** ボタンを押すとやる */
  on_request: "on_request",
  /** 番が来たら一度だけ自動でやる（書き込みなら、自動で書き込む）。ボタンで頼むこともできる。自動で始めるのは、その作業が自動でやってよい範囲（Autonomy Policy）に入るときだけで、入らなければボタンで頼むまで待つ */
  auto: "auto",
} as const;
export type Trigger = (typeof Trigger)[keyof typeof Trigger];

export const Effort = {
  /** すぐ済む */
  easy: "easy",
  /** ふつう */
  normal: "normal",
  /** 難しい */
  hard: "hard",
  /** 面倒（難しくはないが手間がかかる） */
  tedious: "tedious",
} as const;
export type Effort = (typeof Effort)[keyof typeof Effort];

const isTree = (item: ActionDefinition | DefinitionTree | CompletionEffectDefinition): item is DefinitionTree => "items" in item;
const isEffect = (item: ActionDefinition | DefinitionTree | CompletionEffectDefinition): item is CompletionEffectDefinition => "type" in item && item.type === "completionEffect";

function definitions(definition: ActionDefinition): ActionDefinition[] {
  if (definition.how.type !== "decision") return [definition];
  return [definition, ...definition.how.options.flatMap((option) => (option.then.type === "planned" ? treeDefinitions(option.then.plan) : []))];
}

function treeDefinitions(tree: DefinitionTree): ActionDefinition[] {
  return tree.items.flatMap((item) => (isEffect(item) ? [] : isTree(item) ? treeDefinitions(item) : definitions(item)));
}

function trees(definition: ActionDefinition): DefinitionTree[] {
  if (definition.how.type !== "decision") return [];
  return definition.how.options.flatMap((option) => (option.then.type === "planned" ? allTrees(option.then.plan) : []));
}

function allTrees(tree: DefinitionTree): DefinitionTree[] {
  return [tree, ...tree.items.flatMap((item) => (isEffect(item) ? [] : isTree(item) ? allTrees(item) : trees(item)))];
}

/** 並びの中に、完了条件があるか（分かれ道があれば、その枝の完了条件がこの並びの完了条件になる） */
function hasCompletion(tree: DefinitionTree): boolean {
  return tree.items.some((item) => (isEffect(item) ? false : isTree(item) ? hasCompletion(item) : item.completes || item.how.type === "decision"));
}

export const invariants = {
  "先の計画が決まっている選択肢には、完了条件がある": (definition: ActionDefinition) =>
    definitions(definition).every((d) => d.how.type !== "decision" || d.how.options.every((o) => o.then.type !== "planned" || hasCompletion(o.then.plan))),
  "何をするかが空でない": (definition: ActionDefinition) => definitions(definition).every((d) => d.title.trim() !== ""),
  "分かれ道には、名前の違う選択肢が 2 つ以上ある": (definition: ActionDefinition) =>
    definitions(definition).every((d) => d.how.type !== "decision" || (d.how.options.length >= 2 && new Set(d.how.options.map((o) => o.label)).size === d.how.options.length)),
  "選択肢の先の並びは空でない": (definition: ActionDefinition) => trees(definition).every((t) => t.items.length > 0),
  "選んでから考える選択肢には、方針がある": (definition: ActionDefinition) =>
    definitions(definition).every((d) => d.how.type !== "decision" || d.how.options.every((o) => o.then.type !== "planLater" || o.then.direction.trim() !== "")),
};

const merge: ActionDefinition = { title: "merge する", effort: "easy", due: null, completes: true, how: { type: "write", subject: { uri: "github://yutaura@github.com/acme/app/pull/42" }, operation: "github.merge", params: { method: "squash" }, version: "abc1234", trigger: "on_request", place: null } };

export const examples = {
  valid: {
    "人がやる": { title: "年末調整の書類を出す", effort: "normal", due: null, completes: false, how: { type: "human", place: { url: "https://www.nta.go.jp/", label: "国税庁のサイト", certainty: "confirmed" } } },
    "先が決まっている分かれ道と、選んでから考える分かれ道": {
      title: "修正してから merge するか決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        question: "型エラーが出ている。直してから merge するか",
        options: [
          { label: "そのまま merge する", then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "ひとまず調査する", then: { type: "planLater", direction: "型エラーの原因と影響範囲を調べる" } },
        ],
      },
    },
    "分かれ道の先に、また分かれ道がある": {
      title: "配信を続けるか決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        question: "このメルマガを読み続けるか",
        options: [
          { label: "続ける", then: { type: "planned", plan: { type: "serial", items: [{ title: "フォルダに振り分ける", effort: "easy", due: null, completes: true, how: { type: "human", place: null } }] } } },
          {
            label: "やめる",
            then: {
              type: "planned",
              plan: {
                type: "serial",
                items: [
                  {
                    title: "解除の方法を決める",
                    effort: "easy", due: null,
                    completes: false,
                    how: {
                      type: "decision",
                      question: "どうやって配信を止めるか",
                      options: [
                        { label: "配信を解除する", then: { type: "planned", plan: { type: "serial", items: [{ title: "解除のページで解除する", effort: "easy", due: null, completes: true, how: { type: "human", place: null } }] } } },
                        { label: "迷惑メールにする", then: { type: "planned", plan: { type: "serial", items: [{ title: "迷惑メールに振り分ける", effort: "easy", due: null, completes: true, how: { type: "human", place: null } }] } } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
  invalid: {
    "先が決まった選択肢に完了条件がない": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        question: "どうするか",
        options: [
          { label: "merge する", then: { type: "planned", plan: { type: "serial", items: [{ title: "PR を読む", effort: "easy", due: null, completes: false, how: { type: "human", place: null } }] } } },
          { label: "ひとまず調査する", then: { type: "planLater", direction: "調べる" } },
        ],
      },
    },
    "何をするかが空": { title: " ", effort: "easy", due: null, completes: false, how: { type: "human", place: null } },
    "選択肢が 1 つしかない": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: { type: "decision", question: "どうするか", options: [{ label: "merge する", then: { type: "planned", plan: { type: "serial", items: [merge] } } }] },
    },
    "選択肢の名前が同じ": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        question: "どうするか",
        options: [
          { label: "merge する", then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "merge する", then: { type: "planLater", direction: "調べる" } },
        ],
      },
    },
    "選択肢の先の並びが空": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        question: "どうするか",
        options: [
          { label: "merge する", then: { type: "planned", plan: { type: "serial", items: [] } } },
          { label: "閉じる", then: { type: "planLater", direction: "閉じる理由を書く" } },
        ],
      },
    },
    "選んでから考える選択肢に方針がない": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        question: "どうするか",
        options: [
          { label: "merge する", then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "ひとまず調査する", then: { type: "planLater", direction: "" } },
        ],
      },
    },
    "入れ子の分かれ道の選択肢が 1 つしかない": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        question: "どうするか",
        options: [
          {
            label: "やめる",
            then: { type: "planned", plan: { type: "serial", items: [{ title: "方法を決める", effort: "easy", due: null, completes: false, how: { type: "decision", question: "どうやって", options: [{ label: "解除する", then: { type: "planLater", direction: "解除の方法を調べる" } }] } }] } },
          },
          { label: "続ける", then: { type: "planLater", direction: "振り分けを考える" } },
        ],
      },
    },
  },
} satisfies { valid: Record<string, ActionDefinition>; invalid: Record<string, ActionDefinition> };
