import type { Schema } from "effect";
import type { Decision } from "effect/ai";

/**
 * Decisions への問いの定義。アプリとベンチマークは同じ定義を import する（I/F をずらさないため）。
 * - purpose: 問いの ID。判定の記録とベンチマークの結果を、これで突き合わせる
 * - version: 問いの文面・criteria・入力の形を変えたら上げる。記録に残り、どの版で判定したかを追える
 * - decisions: 入力ごとに問いを組み立てる（選択肢ごとに問いが増える判定もあるため、関数にする）
 * 入力に外の人が書いた文を入れ、問いと criteria にはアプリが書いた文だけを入れる（取り違えを防ぐ）。
 */
/** 文字の入力に答える判定（画像の Locate は使わない） */
export type TextDecision = Decision.Classify<string> | Decision.Rate<string> | Decision.Probability;

/** 入力の Schema。エンコードにサービスを要らないものだけ（判定の呼び出し口が依存を持たないように） */
export type QuestionInput = Schema.Constraint & { readonly EncodingServices: never };

export interface DecisionQuestion<S extends QuestionInput, D extends Record<string, TextDecision>> {
  readonly purpose: string;
  readonly version: number;
  readonly input: S;
  readonly decisions: (input: S["Type"]) => D;
}

export const defineQuestion = <S extends QuestionInput, D extends Record<string, TextDecision>>(question: DecisionQuestion<S, D>): DecisionQuestion<S, D> =>
  question;
