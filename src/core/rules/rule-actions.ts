import { Effect, Result, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";
import type { GmailRuleActions } from "./rule.js";

export const TASK_ACTIONS = {
  done: "Task を完了にする（終わったものとして片付ける）",
  dismissed: "Task を対象外にする（自分がやらなくてよいものとして片付ける）",
  todo: "Task をやること（todo）にする",
  none: "Task の状態は変えない（メールの既読・ラベルなど、Task 以外への操作だけ）",
} as const;
export type TaskAction = Exclude<keyof typeof TASK_ACTIONS, "none">;
// 「いい感じにして」を何かの操作に読まないよう、はっきりしないことを選べるようにする（ADR-0019 の spike）
const TASK_ACTION_CHOICES = { ...TASK_ACTIONS, unclear: "何をするかがはっきり書かれていない" } as const;

export type RuleActionsInterpretation = {
  taskAction: { label: keyof typeof TASK_ACTIONS; probability: number } | undefined;
  hasCondition: number | undefined;
  markRead: number | undefined;
  archive: number | undefined;
  addLabel: number | undefined;
  /** 付けるラベルの名前（候補から選んだもの）。選べなければ undefined */
  label: string | undefined;
  unsupported: number | undefined;
};

const Input = Schema.Struct({ then: Schema.String });

/**
 * ルールの「何をする」を、Decisions でアプリの操作に読み取る（ADR-0019）。保存するときに 1 回だけ呼ぶ。
 * ラベルの名前は Decisions が文字を作れないので、labels（文の中の名前と Gmail のラベル）から選ばせる
 */
export const interpretRuleActions = Effect.fnUntraced(function* (request: { then: string; labels: ReadonlyArray<string> }) {
  const model = yield* DecisionModel.DecisionModel;
  const keys = request.labels.map((_, index) => `l${index}`);
  const labelCriteria = Object.fromEntries([
    ...request.labels.map((name, index) => [keys[index]!, `ラベル「${name}」`] as const),
    ["none", "ラベルを付けない、または上のどれでもない"] as const,
  ]);
  // 候補がないときはラベルを聞かない（選択肢が「付けない」1 つだけだと、Decision.classify が作れない）
  const labelDecision = request.labels.length === 0 ? {} : { label: Decision.classify({ instructions: "この指示で付けるラベルはどれか。", criteria: labelCriteria }) };
  const definition = Decision.make({
    input: Input,
    decisions: {
      ...labelDecision,
      taskAction: Decision.classify({ instructions: "この指示は、Task の状態をどうするか。", criteria: TASK_ACTION_CHOICES }),
      hasCondition: Decision.probability({
        instructions:
          "この指示の中に、操作をするかどうかを決める条件（「〜の場合は」「〜なら」「〜がないとき」「〜以外は」「〜だけ」など）が含まれているか。操作の理由（「〜なので」）は条件ではない。",
        criteria: { true: "条件が含まれている", false: "操作だけが書かれている" },
      }),
      markRead: Decision.probability({ instructions: "この指示は、メールを既読にすることを含むか。", criteria: { true: "既読にする", false: "既読にしない" } }),
      archive: Decision.probability({ instructions: "この指示は、メールをアーカイブする（受信トレイから外す）ことを含むか。", criteria: { true: "アーカイブする", false: "アーカイブしない" } }),
      addLabel: Decision.probability({ instructions: "この指示は、メールにラベルを付けることを含むか。", criteria: { true: "ラベルを付ける", false: "ラベルを付けない" } }),
      // 「どれでもない操作か」と否定で聞くと見落とした（approve・転送・返信が 0.05 以下）。肯定の形で例を挙げて聞く
      unsupported: Decision.probability({
        instructions: "この指示は、誰かに送る・外部に書き込む・消す操作（返信・送信・転送・メッセージ・コメント・削除・ゴミ箱・マージ・承認・approve など）を含むか。",
        criteria: { true: "送る・書き込む・消す操作を含む", false: "含まない" },
      }),
    },
  });
  const { outcomes } = yield* model.decideSettled(definition, { input: { then: request.then } });
  const probabilityOf = (outcome: Result.Result<{ probability: number }, unknown>) => (Result.isSuccess(outcome) ? outcome.success.probability : undefined);
  const task = outcomes.taskAction;
  const label = (outcomes as { label?: Result.Result<{ label: string; probabilities: Record<string, number> }, unknown> }).label;
  return {
    taskAction:
      Result.isSuccess(task) && task.success.label !== "unclear"
        ? { label: task.success.label, probability: task.success.probabilities[task.success.label] ?? 0 }
        : undefined,
    hasCondition: probabilityOf(outcomes.hasCondition),
    markRead: probabilityOf(outcomes.markRead),
    archive: probabilityOf(outcomes.archive),
    addLabel: probabilityOf(outcomes.addLabel),
    label: label !== undefined && Result.isSuccess(label) && label.success.label !== "none" && (label.success.probabilities[label.success.label] ?? 0) >= LABEL_PROBABILITY
      ? request.labels[keys.indexOf(label.success.label)]
      : undefined,
    unsupported: probabilityOf(outcomes.unsupported),
  } satisfies RuleActionsInterpretation;
});

// これ以上の確率で読み取れた操作だけを行う（自動で行うので、迷う操作は入れない）
const ACTION_PROBABILITY = 0.7;
const LABEL_PROBABILITY = 0.5;
// これ以上の確率で、条件が混ざっている・アプリにできない操作を求めていれば保存させない
const CONDITION_PROBABILITY = 0.5;
const UNSUPPORTED_PROBABILITY = 0.5;

export type RuleActions = { task?: TaskAction; gmail?: GmailRuleActions };
export type InterpretedRuleActions = { ok: true; actions: RuleActions } | { ok: false; reason: string };

/** 読み取った確率を、保存できる操作か、保存させない理由にする。答えが返らなかったものは保存させない側に倒す（fail closed） */
export function ruleActionsOf(interpretation: RuleActionsInterpretation): InterpretedRuleActions {
  if (interpretation.hasCondition === undefined || interpretation.hasCondition >= CONDITION_PROBABILITY) {
    return { ok: false, reason: "「何をする」に条件（「〜の場合は」など）が含まれています。条件は「どういう時」に書いてください" };
  }
  if (interpretation.unsupported === undefined || interpretation.unsupported >= UNSUPPORTED_PROBABILITY) {
    return { ok: false, reason: "ルールでは、Task の状態を変える・メールの既読・アーカイブ・ラベル以外の操作（返信・送信・削除など）はできない" };
  }
  const task = interpretation.taskAction;
  if (task === undefined || task.probability < ACTION_PROBABILITY) return { ok: false, reason: "何をするかを読み取れませんでした" };
  const sure = (probability: number | undefined) => probability !== undefined && probability >= ACTION_PROBABILITY;
  const labels = sure(interpretation.addLabel) ? (interpretation.label === undefined ? undefined : [interpretation.label]) : [];
  if (labels === undefined) return { ok: false, reason: "付けるラベルの名前が分かりません。「レシート」のように名前を書いてください" };
  const gmail = { labels, markRead: sure(interpretation.markRead), archive: sure(interpretation.archive) };
  const hasGmail = gmail.labels.length > 0 || gmail.markRead || gmail.archive;
  if (task.label === "none" && !hasGmail) return { ok: false, reason: "何をするかを読み取れませんでした" };
  return { ok: true, actions: { ...(task.label === "none" ? {} : { task: task.label }), ...(hasGmail ? { gmail } : {}) } };
}
