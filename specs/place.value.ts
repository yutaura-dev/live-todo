/** 人がやる場所（公式のサイトなど）。画面に「開く」ボタンを出す */
export type Place = {
  /** 開く URL */
  url: string;
  /** 名前（〇〇を開く） */
  label: string;
  /** 公式のページか確かめたか */
  certainty: Certainty;
};

export const Certainty = {
  /** 公式のページか確かめた */
  confirmed: "confirmed",
  /** AI が手順の文から拾った（確かめていない） */
  guessed: "guessed",
} as const;
export type Certainty = (typeof Certainty)[keyof typeof Certainty];

export const invariants = {
  "URL は https で始まる": (place: Place) => place.url.startsWith("https://"),
  "名前が空でない": (place: Place) => place.label.trim() !== "",
};

export const examples = {
  valid: {
    "確かめた公式のサイト": { url: "https://www.nta.go.jp/", label: "国税庁のサイト", certainty: "confirmed" },
    "手順の文から拾った URL": { url: "https://example.com/form", label: "申込みフォーム", certainty: "guessed" },
  },
  invalid: {
    "https でない": { url: "http://example.com/", label: "サイト", certainty: "confirmed" },
    "javascript の URL": { url: "javascript:alert(1)", label: "開く", certainty: "guessed" },
    "名前が空": { url: "https://example.com/", label: " ", certainty: "confirmed" },
  },
} satisfies { valid: Record<string, Place>; invalid: Record<string, Place> };
