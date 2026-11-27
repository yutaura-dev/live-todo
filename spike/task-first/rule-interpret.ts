import { Effect, Result, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";

export const TASK_ACTIONS = {
  done: "Task を完了にする（終わったものとして片付ける）",
  dismissed: "Task を対象外にする（自分がやらなくてよいものとして片付ける）",
  todo: "Task をやること（todo）にする",
  none: "Task の状態は変えない（メールの既読・ラベルなど、Task 以外への操作だけ）",
} as const;
export type TaskAction = keyof typeof TASK_ACTIONS;
// 「いい感じにして」を何かの操作に読まないよう、はっきりしないことを選べるようにする
const TASK_ACTION_CHOICES = { ...TASK_ACTIONS, unclear: "何をするかがはっきり書かれていない" } as const;

export type Interpretation = {
  taskAction: { label: TaskAction; probability: number } | undefined;
  hasCondition: number | undefined;
  markRead: number | undefined;
  archive: number | undefined;
  addLabel: number | undefined;
  unsupported: number | undefined;
};

const Input = Schema.Struct({ then: Schema.String });

/** 「何をする」の文を、アプリの操作に読み取る（保存するときに 1 回） */
export const interpret = Effect.fnUntraced(function* (then: string) {
  const model = yield* DecisionModel.DecisionModel;
  const definition = Decision.make({
    input: Input,
    decisions: {
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
        instructions:
          "この指示は、誰かに送る・外部に書き込む・消す操作（返信・送信・転送・メッセージ・コメント・削除・ゴミ箱・マージ・承認・approve・close など）を含むか。",
        criteria: { true: "送る・書き込む・消す操作を含む", false: "含まない" },
      }),
    },
  });
  const { outcomes } = yield* model.decideSettled(definition, { input: { then } });
  const p = (outcome: Result.Result<{ probability: number }, unknown>) => (Result.isSuccess(outcome) ? outcome.success.probability : undefined);
  return {
    taskAction: Result.isSuccess(outcomes.taskAction) && outcomes.taskAction.success.label !== "unclear"
      ? { label: outcomes.taskAction.success.label as TaskAction, probability: outcomes.taskAction.success.probabilities[outcomes.taskAction.success.label] ?? 0 }
      : undefined,
    hasCondition: p(outcomes.hasCondition),
    markRead: p(outcomes.markRead),
    archive: p(outcomes.archive),
    addLabel: p(outcomes.addLabel),
    unsupported: p(outcomes.unsupported),
  } satisfies Interpretation;
});

// 確かなものだけ操作にする（今の Gmail のルールと同じ閾値）
const ACTION_PROBABILITY = 0.7;
const CONDITION_PROBABILITY = 0.5;
const UNSUPPORTED_PROBABILITY = 0.5;

export type Reading =
  | { ok: true; taskAction: TaskAction; markRead: boolean; archive: boolean; addLabel: boolean }
  | { ok: false; reason: "condition" | "unsupported" | "unclear" };

/** 読み取った確率を、保存できる操作か、保存させない理由にする。迷うものは保存させない（fail closed） */
export function readingOf(i: Interpretation): Reading {
  if (i.hasCondition === undefined || i.hasCondition >= CONDITION_PROBABILITY) return { ok: false, reason: "condition" };
  if (i.unsupported === undefined || i.unsupported >= UNSUPPORTED_PROBABILITY) return { ok: false, reason: "unsupported" };
  const sure = (p: number | undefined) => p !== undefined && p >= ACTION_PROBABILITY;
  const taskAction = i.taskAction !== undefined && i.taskAction.probability >= ACTION_PROBABILITY ? i.taskAction.label : undefined;
  if (taskAction === undefined) return { ok: false, reason: "unclear" };
  const reading = { ok: true as const, taskAction, markRead: sure(i.markRead), archive: sure(i.archive), addLabel: sure(i.addLabel) };
  if (taskAction === "none" && !reading.markRead && !reading.archive && !reading.addLabel) return { ok: false, reason: "unclear" };
  return reading;
}
