import type { Condition, Subject } from "./condition.value.ts";
import type { Place } from "./place.value.ts";
import type { DueDate } from "./due-date.value.ts";
import type { WaitEstimate } from "./wait-estimate.value.ts";

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
  /** 待つ条件が成り立って果たされる。アプリ（Watcher）が見張る。どれくらい待つ見込みか（分からなければ null）を持ち、優先度の材料にする */
  | { type: "condition"; condition: Condition; expectedWait: WaitEstimate | null }
  /** 外への書き込み（merge する・メールに返信する など）が承認されて成功すると果たされる。何に・どの操作で・どの中身を・作る操作ならどこに作るか（作る場所。元の事実の URI が作る場所の URI の中にあるとき「同じ場所」）と、計画を立てたときの対象の版を持つ（自動でやってよい範囲に入るなら、この中身と版のまま自動で書き込む。書き込み 1 回は、頼んだときにできて、この Action Item を指す） */
  | { type: "write"; subject: Subject; operation: string; params: unknown; version: string | null; trigger: Trigger; place: Subject | null }
  /** ユーザーが選択肢から 1 つ選んで果たす。選ぶと、選んだ選択肢の先が計画に差し込まれる */
  | Decision;

/**
 * 分かれ道。人が決めないと先に進まない。決めるのに要る情報は、分かれ道の種類で違う。
 * - 確かめる: 事実を確かめれば答えが決まる（そのログインは自分の操作か・PR がもう開いているか）。どう確かめるかを持ち、得るもの・失うもの・おすすめは持たない（好みで選ぶものではないので、比べる材料を作らない）
 * - 選ぶ: 天秤にかけて決める（会員を続けるか・どの直し方にするか）。選択肢ごとの得るもの・失うものと、AI のおすすめを持つ
 * 種類は、計画を立てるとき Generation が決める。
 */
export type Decision = {
  type: "decision";
  /** 分かれ道の種類 */
  kind: DecisionKind;
  /** 何を決めるか（決めるために読むもの・選択肢の比べ方など） */
  question: string;
  /** どう確かめるか（何を見ればよいか）。確かめる分かれ道だけ持つ */
  howToCheck: string | null;
  /** 選択肢 */
  options: Option[];
  /**
   * AI のおすすめ（なければ null）。選ぶ分かれ道だけ持つ。
   * Decisions が選択肢から 1 つを選び、確率が閾値以上のときだけ持つ。理由は Generation が、得るもの・失うものを踏まえて書く。
   * 閾値の間・断られた・形に合わないときは持たない（迷ったまま勧めない）。おすすめがあっても、選ぶのはユーザー。
   */
  recommendation: { label: string; reason: string } | null;
};

export const DecisionKind = {
  /** 事実を確かめれば答えが決まる */
  check: "確かめる",
  /** 天秤にかけて決める */
  choose: "選ぶ",
} as const;
export type DecisionKind = (typeof DecisionKind)[keyof typeof DecisionKind];

/**
 * 分かれ道の選択肢。
 * 選ぶ分かれ道では、選択肢ごとに「得るもの」と「失うもの」を持たせ、選ぶ人が比べられるようにする（確かめる分かれ道では、どちらも空）。
 * 観点は決め打ちの一覧（Aspect）にし、選択肢どうしで同じ観点を天秤にかけられるようにする。
 * 比べる相手はほかの選択肢。選択肢ごと・観点ごとに、Decisions が「ほかの選択肢より良い・差がない・悪い」を判定する（同じ入力に対する問いなので、1 回のリクエストにまとめる）。
 * 「良い」の確率が閾値以上の観点を得るもの、「悪い」の確率が閾値以上の観点を失うものにする。多すぎると読めないので、それぞれ確率の高い順に 3 件までにする。具体的な中身（理由）は Generation が書く。
 * どれの確率も閾値に届かない・断られた観点は、得るもの・失うもののどちらにも入れず、判断できなかった観点として見せる（迷ったら黙って決めない）。「差がない」と判定された観点は、どこにも出さない。
 */
export type Option = {
  /** 選択肢の名前（そのまま merge する・ひとまず調査する など） */
  label: string;
  /** ほかの選択肢より良い観点と、その具体的な中身（確率の高い順に 3 件まで） */
  gains: Point[];
  /** ほかの選択肢より悪い観点と、その具体的な中身（確率の高い順に 3 件まで） */
  costs: Point[];
  /** Decisions が良くなるか悪くなるかを判断できなかった観点 */
  unclear: Aspect[];
  /** 選んだら、どう進めるか */
  then: OptionThen;
};

/** 得るもの・失うもの 1 つ */
export type Point = {
  /** 何の観点か */
  aspect: Aspect;
  /** 具体的にどうなるか（「鍵が漏れても 1 時間で無効にできる」「数十分の作業が要る」など）。Generation が書く */
  detail: string;
};

/** 比べる観点（決め打ち）。選ぶ分かれ道の選択肢を、この観点ごとに比べる。Decisions が迷わないよう、観点どうしが重ならないように定義する */
export const Aspect = {
  /** いつ終わるか・期日に間に合うか（暦の上の時間。自分の作業量は手間） */
  deadline: "期日",
  /** 今、自分が手を動かす量 */
  effort: "手間",
  /** あとで払う手間（保守・やり直し・手入れ） */
  laterBurden: "あとの負担",
  /** かかるお金・立て替え */
  money: "お金",
  /** うまくいく見込み（本番が壊れる・失敗するおそれも含む） */
  certainty: "確実さ",
  /** あとから元に戻せるか */
  reversibility: "取り返し",
  /** アカウント・個人情報・権限の守り */
  security: "セキュリティ",
  /** ほかの人を待たせる・頼む・負担をかける・相手との関係 */
  others: "ほかの人",
  /** 期限で失うもの・受け取れる特典や価値 */
  opportunity: "機会",
  /** 規程・契約・約束に沿うか */
  rules: "決まり",
  /** 仕上がりの質・受け手にとっての良さ */
  quality: "出来",
} as const;
export type Aspect = (typeof Aspect)[keyof typeof Aspect];

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
  "選ぶ分かれ道では、どれかの選択肢に得るものか失うものがある（比べる材料のない分かれ道を出さない）": (definition: ActionDefinition) =>
    definitions(definition).every((d) => d.how.type !== "decision" || d.how.kind !== "選ぶ" || d.how.options.some((o) => o.gains.length + o.costs.length > 0)),
  "確かめる分かれ道は、確かめ方を持ち、得るもの・失うもの・判断できなかった観点・おすすめを持たない": (definition: ActionDefinition) =>
    definitions(definition).every(
      (d) =>
        d.how.type !== "decision" ||
        d.how.kind !== "確かめる" ||
        (d.how.howToCheck !== null && d.how.howToCheck.trim() !== "" && d.how.recommendation === null && d.how.options.every((o) => o.gains.length + o.costs.length + o.unclear.length === 0)),
    ),
  "選ぶ分かれ道は、確かめ方を持たない": (definition: ActionDefinition) =>
    definitions(definition).every((d) => d.how.type !== "decision" || d.how.kind !== "選ぶ" || d.how.howToCheck === null),
  "得るもの・失うものは、それぞれ 3 件まで（多すぎると読めない）": (definition: ActionDefinition) =>
    definitions(definition).every((d) => d.how.type !== "decision" || d.how.options.every((o) => o.gains.length <= 3 && o.costs.length <= 3)),
  "得るもの・失うものには、具体的な中身がある": (definition: ActionDefinition) =>
    definitions(definition).every((d) => d.how.type !== "decision" || d.how.options.every((o) => [...o.gains, ...o.costs].every((p) => p.detail.trim() !== ""))),
  "1 つの選択肢の中で、同じ観点は得るもの・失うもの・判断できなかった観点のどれか 1 か所にだけ出る": (definition: ActionDefinition) =>
    definitions(definition).every(
      (d) =>
        d.how.type !== "decision" ||
        d.how.options.every((o) => {
          const aspects = [...o.gains.map((p) => p.aspect), ...o.costs.map((p) => p.aspect), ...o.unclear];
          return new Set(aspects).size === aspects.length;
        }),
    ),
  "おすすめは、選択肢のどれか": (definition: ActionDefinition) =>
    definitions(definition).every((d) => {
      if (d.how.type !== "decision" || d.how.recommendation === null) return true;
      const label = d.how.recommendation.label;
      return d.how.options.some((o) => o.label === label);
    }),
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
        kind: "選ぶ",
        howToCheck: null,
        question: "型エラーが出ている。直してから merge するか",
        recommendation: { label: "ひとまず調査する", reason: "型エラーが本番に出ると取り返しがつかず、遅れは 1 日で済むため" },
        options: [
          { label: "そのまま merge する", gains: [{ aspect: "期日", detail: "今日中にリリースできる" }], costs: [{ aspect: "確実さ", detail: "型エラーが本番で問題になるかもしれない" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "ひとまず調査する", gains: [{ aspect: "確実さ", detail: "影響が分かってから決められる" }], costs: [{ aspect: "期日", detail: "merge が 1 日ほど遅れる" }], unclear: [], then: { type: "planLater", direction: "型エラーの原因と影響範囲を調べる" } },
        ],
      },
    },
    "確かめる分かれ道": {
      title: "心当たりのないログインがないか確かめる",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "確かめる",
        howToCheck: "Google アカウントの「デバイス」で、11/22 の Mac のログイン 3 件の場所と端末を見る",
        question: "11/22 の Mac のログイン 3 件は、すべて自分の操作か",
        recommendation: null,
        options: [
          { label: "すべて自分の操作だった", gains: [], costs: [], unclear: [], then: { type: "planned", plan: { type: "serial", items: [{ title: "通知を閉じる", effort: "easy", due: null, completes: true, how: { type: "human", place: null } }] } } },
          { label: "心当たりのないログインがある", gains: [], costs: [], unclear: [], then: { type: "planLater", direction: "パスワードを変えて、ほかのセッションを切る" } },
        ],
      },
    },
    "分かれ道の先に、また分かれ道がある": {
      title: "配信を続けるか決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "このメルマガを読み続けるか",
        recommendation: null,
        options: [
          { label: "続ける", gains: [{ aspect: "出来", detail: "必要な告知を見落とさない" }], costs: [{ aspect: "手間", detail: "受信箱が週に 5 通ほど埋まる" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [{ title: "フォルダに振り分ける", effort: "easy", due: null, completes: true, how: { type: "human", place: null } }] } } },
          {
            label: "やめる",
            gains: [{ aspect: "手間", detail: "受信箱が静かになる" }],
            costs: [{ aspect: "出来", detail: "必要な告知も届かなくなる" }],
            unclear: [],
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
                      kind: "選ぶ",
                      howToCheck: null,
                      question: "どうやって配信を止めるか",
                      recommendation: null,
                      options: [
                        { label: "配信を解除する", gains: [{ aspect: "確実さ", detail: "送り元に届かなくなる" }], costs: [{ aspect: "手間", detail: "解除のページを探して数分かかる" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [{ title: "解除のページで解除する", effort: "easy", due: null, completes: true, how: { type: "human", place: null } }] } } },
                        { label: "迷惑メールにする", gains: [{ aspect: "手間", detail: "ワンクリックで済む" }], costs: [{ aspect: "確実さ", detail: "正規の送り元を迷惑メールに数えてしまう" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [{ title: "迷惑メールに振り分ける", effort: "easy", due: null, completes: true, how: { type: "human", place: null } }] } } },
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
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: null,
        options: [
          { label: "merge する", gains: [{ aspect: "期日", detail: "早く進む" }], costs: [{ aspect: "確実さ", detail: "見落としが出るかもしれない" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [{ title: "PR を読む", effort: "easy", due: null, completes: false, how: { type: "human", place: null } }] } } },
          { label: "ひとまず調査する", gains: [{ aspect: "確実さ", detail: "影響が分かってから決められる" }], costs: [{ aspect: "期日", detail: "merge が 1 日ほど遅れる" }], unclear: [], then: { type: "planLater", direction: "調べる" } },
        ],
      },
    },
    "何をするかが空": { title: " ", effort: "easy", due: null, completes: false, how: { type: "human", place: null } },
    "選択肢が 1 つしかない": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: { type: "decision", kind: "選ぶ", howToCheck: null, question: "どうするか", recommendation: null, options: [{ label: "merge する", gains: [{ aspect: "期日", detail: "早く進む" }], costs: [{ aspect: "確実さ", detail: "見落としが出るかもしれない" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } }] },
    },
    "選択肢の名前が同じ": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: null,
        options: [
          { label: "merge する", gains: [{ aspect: "期日", detail: "早く進む" }], costs: [{ aspect: "確実さ", detail: "見落としが出るかもしれない" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "merge する", gains: [{ aspect: "期日", detail: "早く進む" }], costs: [{ aspect: "確実さ", detail: "見落としが出るかもしれない" }], unclear: [], then: { type: "planLater", direction: "調べる" } },
        ],
      },
    },
    "選択肢の先の並びが空": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: null,
        options: [
          { label: "merge する", gains: [{ aspect: "期日", detail: "早く進む" }], costs: [{ aspect: "確実さ", detail: "見落としが出るかもしれない" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [] } } },
          { label: "閉じる", gains: [{ aspect: "手間", detail: "手が空く" }], costs: [{ aspect: "取り返し", detail: "あとで必要になったら開き直す" }], unclear: [], then: { type: "planLater", direction: "閉じる理由を書く" } },
        ],
      },
    },
    "比べる材料のない選ぶ分かれ道": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: null,
        options: [
          { label: "merge する", gains: [], costs: [], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "ひとまず調査する", gains: [], costs: [], unclear: [], then: { type: "planLater", direction: "調べる" } },
        ],
      },
    },
    "中身のない得るもの": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: null,
        options: [
          { label: "merge する", gains: [{ aspect: "期日", detail: " " }], costs: [{ aspect: "確実さ", detail: "見落としが出るかもしれない" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "ひとまず調査する", gains: [{ aspect: "確実さ", detail: "影響が分かってから決められる" }], costs: [{ aspect: "期日", detail: "1 日遅れる" }], unclear: [], then: { type: "planLater", direction: "調べる" } },
        ],
      },
    },
    "おすすめが選択肢にない": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: { label: "閉じる", reason: "手が空く" },
        options: [
          { label: "merge する", gains: [{ aspect: "期日", detail: "早く進む" }], costs: [{ aspect: "確実さ", detail: "見落としが出るかもしれない" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "ひとまず調査する", gains: [{ aspect: "確実さ", detail: "影響が分かってから決められる" }], costs: [{ aspect: "期日", detail: "1 日遅れる" }], unclear: [], then: { type: "planLater", direction: "調べる" } },
        ],
      },
    },
    "同じ観点が得るものと失うものの両方にある": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: null,
        options: [
          { label: "merge する", gains: [{ aspect: "期日", detail: "早く進む" }], costs: [{ aspect: "期日", detail: "あとで直す時間がかかる" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "ひとまず調査する", gains: [{ aspect: "確実さ", detail: "影響が分かってから決められる" }], costs: [], unclear: ["期日"], then: { type: "planLater", direction: "調べる" } },
        ],
      },
    },
    "得るものが 4 件ある": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: null,
        options: [
          {
            label: "merge する",
            gains: [
              { aspect: "期日", detail: "今日中に出せる" },
              { aspect: "手間", detail: "押すだけで済む" },
              { aspect: "ほかの人", detail: "レビュアーを待たせない" },
              { aspect: "機会", detail: "今週のリリースに乗る" },
            ],
            costs: [],
            unclear: [],
            then: { type: "planned", plan: { type: "serial", items: [merge] } },
          },
          { label: "ひとまず調査する", gains: [{ aspect: "確実さ", detail: "影響が分かってから決められる" }], costs: [], unclear: [], then: { type: "planLater", direction: "調べる" } },
        ],
      },
    },
    "確かめ方のない確かめる分かれ道": {
      title: "確かめる",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "確かめる",
        howToCheck: null,
        question: "PR はもう開いているか",
        recommendation: null,
        options: [
          { label: "開いている", gains: [], costs: [], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "まだない", gains: [], costs: [], unclear: [], then: { type: "planLater", direction: "実装する" } },
        ],
      },
    },
    "得るものを持つ確かめる分かれ道": {
      title: "確かめる",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "確かめる",
        howToCheck: "GitHub で PR の一覧を見る",
        question: "PR はもう開いているか",
        recommendation: null,
        options: [
          { label: "開いている", gains: [{ aspect: "期日", detail: "すぐ merge できる" }], costs: [], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "まだない", gains: [], costs: [], unclear: [], then: { type: "planLater", direction: "実装する" } },
        ],
      },
    },
    "選んでから考える選択肢に方針がない": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: null,
        options: [
          { label: "merge する", gains: [{ aspect: "期日", detail: "早く進む" }], costs: [{ aspect: "確実さ", detail: "見落としが出るかもしれない" }], unclear: [], then: { type: "planned", plan: { type: "serial", items: [merge] } } },
          { label: "ひとまず調査する", gains: [{ aspect: "確実さ", detail: "影響が分かってから決められる" }], costs: [{ aspect: "期日", detail: "merge が 1 日ほど遅れる" }], unclear: [], then: { type: "planLater", direction: "" } },
        ],
      },
    },
    "入れ子の分かれ道の選択肢が 1 つしかない": {
      title: "決める",
      effort: "easy", due: null,
      completes: false,
      how: {
        type: "decision",
        kind: "選ぶ",
        howToCheck: null,
        question: "どうするか",
        recommendation: null,
        options: [
          {
            label: "やめる",
            gains: [{ aspect: "手間", detail: "受信箱が静かになる" }],
            costs: [{ aspect: "出来", detail: "必要な告知も届かなくなる" }],
            unclear: [],
            then: { type: "planned", plan: { type: "serial", items: [{ title: "方法を決める", effort: "easy", due: null, completes: false, how: { type: "decision", kind: "選ぶ", howToCheck: null, question: "どうやって", recommendation: null, options: [{ label: "解除する", gains: [{ aspect: "確実さ", detail: "送り元に届かなくなる" }], costs: [{ aspect: "手間", detail: "解除の方法を探す手間がかかる" }], unclear: [], then: { type: "planLater", direction: "解除の方法を調べる" } }] } }] } },
          },
          { label: "続ける", gains: [{ aspect: "出来", detail: "告知を受け取り続けられる" }], costs: [{ aspect: "手間", detail: "受信箱が週に 5 通ほど埋まる" }], unclear: [], then: { type: "planLater", direction: "振り分けを考える" } },
        ],
      },
    },
  },
} satisfies { valid: Record<string, ActionDefinition>; invalid: Record<string, ActionDefinition> };
