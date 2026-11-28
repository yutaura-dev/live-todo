import type { Schema } from "effect";

/** 入力の Schema。エンコードにサービスを要らないものだけ */
export type WritingInput = Schema.Constraint & { readonly EncodingServices: never };
/** 出力の Schema。Structured Output にするので、オブジェクトにエンコードでき、デコードにサービスを要らないものだけ */
export type WritingOutput = Schema.Codec<any, Record<string, any>, never, never>;

/**
 * Generation に頼む書き物の定義。アプリとベンチマークは同じ定義を import する（I/F をずらさないため）。
 * - purpose / version: 記録とベンチマークの結果を突き合わせる ID と版。指示・入出力の形を変えたら版を上げる
 * - instructions: system に入れる指示。アプリが書いた文だけにし、入力（外の人が書いた文を含む）は user の側に置く
 * 文章が要らない判定（真偽・分類・段階）は Generation にせず、Decisions の問いにする。
 */
export interface Writing<I extends WritingInput, O extends WritingOutput> {
  readonly purpose: string;
  readonly version: number;
  readonly objectName: string;
  readonly input: I;
  readonly output: O;
  readonly instructions: (input: I["Type"]) => string;
}

export const defineWriting = <I extends WritingInput, O extends WritingOutput>(writing: Writing<I, O>): Writing<I, O> => writing;
