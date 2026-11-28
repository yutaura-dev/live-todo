import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CSSProperties, ReactNode } from "react";
import { AiText, AttentionPill, Button, Icon, Kbd, Pill, Problem, Quote, SourceMarks, WorkingPill } from "./components.js";
import { windowed } from "./frame.js";

const meta = {
  title: "UI デザイン/はじめに",
  decorators: [windowed],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Page({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <div className="ui-doc">
      <header className="ui-doc-head">
        <h1 className="ui-title">{title}</h1>
        <p className="ui-doc-lead">{lead}</p>
      </header>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ui-doc-section">
      <h2 className="ui-settings-title">{title}</h2>
      {children}
    </section>
  );
}

const COLORS: Array<{ name: string; token: string; use: string }> = [
  { name: "紙", token: "--c-paper", use: "画面の地" },
  { name: "白", token: "--c-sheet", use: "カード・詳細の板" },
  { name: "墨", token: "--c-ink", use: "本文" },
  { name: "鈍", token: "--c-ink-sub", use: "補いの文・遠い目盛り" },
  { name: "罫", token: "--c-rule", use: "区切りの線" },
  { name: "瑠璃", token: "--c-ruri", use: "自分の番・主要操作・選択・新着" },
  { name: "青磁", token: "--c-seiji", use: "AI が書いたもの・AI が作業中" },
  { name: "弁柄", token: "--c-bengara", use: "失敗・書き込めなかったものだけ" },
];

const RULER = ["今すぐ", "今日中", "3 日以内", "10 日以内", "30 日以内", "それより先"];

/** このデザインが何を大事にしているか。画面を直すときは、まずここと食い違っていないかを見る */
export const デザインの考え方: Story = {
  render: () => (
    <div className="ui ui-app ui-app--doc" lang="ja">
      <main className="ui-main">
        <Page title="見通しの遠近法" lead="毎朝開いて「今日やることは何か」が分かる道具。近いものは大きく濃く、遠いものは小さく淡く見せる。">
          <Section title="いちばん目立たせるのは、時の物差し 1 つだけ">
            <p>
              見通しの左端に縦の物差しを引き、今すぐからそれより先へ進むほど、目盛りの文字と線を細く淡くする。ワイヤーフレームの「遠いまとまりほど小さく見せる」を、そのまま形にしたもの。ほかの部分は静かに抑え、目立つ場所を増やさない。
            </p>
            <ol className="ui-doc-ruler">
              {RULER.map((label, depth) => (
                <li key={label} className="ui-band ui-band--doc" style={{ "--depth": depth } as CSSProperties}>
                  <span className="ui-ruler">
                    <span className="ui-ruler-label">{label}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Section>
          <Section title="近さで形を変える">
            <ul className="ui-doc-list">
              <li>今すぐ: 開かずに手を付けられるカード。理由と、今できることごとの操作まで出す</li>
              <li>今日中・3 日以内: 罫線で区切った 1 行。今できることが 1 つなら、その操作だけを右に置く</li>
              <li>10 日以内より先: 閉じておき、開くと題だけが並ぶ</li>
            </ul>
          </Section>
          <Section title="色は 3 つの意味にだけ使う">
            <ul className="ui-swatches">
              {COLORS.map((color) => (
                <li key={color.token}>
                  <span className="ui-swatch" style={{ background: `var(${color.token})` }} />
                  <span className="ui-stack-4">
                    <strong>{color.name}</strong>
                    <span className="ui-sub">{color.use}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="ui-sub">色だけで状態を伝えない。どの状態にも文言か形（印・線の種類）を添える。ダークモードでは同じ名前の色を明るく置き換える（ツールバーの「配色」で切り替えられる）。</p>
          </Section>
          <Section title="誰が書いた文かを、面で分ける">
            <div className="ui-doc-grid">
              <AiText label="AI が書いた">
                <p>CI は通過。破壊的変更はないと AI が判断した</p>
              </AiText>
              <Quote from="外の人が書いた（元の文面）">来週のメンテ、火曜の夜で大丈夫そうですか？</Quote>
              <figure className="ui-outgoing">
                <figcaption>外に出る中身（承認するもの）</figcaption>
                <div className="ui-outgoing-body">
                  <p>火曜の 10 時で大丈夫です。</p>
                </div>
              </figure>
            </div>
          </Section>
          <Section title="文字">
            <p>
              macOS の純正の書体（欧文は SF、和文は Hiragino Sans）を使う。ローカルで完結するアプリなので Web フォントを持ち込まず、OS の文字と並んだときに浮かないことを優先した。見出しは仮名を詰め（palt）、文節で折り返す。時刻と件数は等幅の数字にする。
            </p>
            <div className="ui-type-scale">
              <p style={{ fontSize: 26, fontWeight: 600 }}>26 画面の題</p>
              <p style={{ fontSize: 20, fontWeight: 600 }}>20 Task の題（詳細）・目盛りの今すぐ</p>
              <p style={{ fontSize: 16, fontWeight: 600 }}>16 Task の題（カード）</p>
              <p style={{ fontSize: 14 }}>14 本文</p>
              <p style={{ fontSize: 13 }} className="ui-sub">
                13 補いの文・ボタン
              </p>
              <p style={{ fontSize: 12 }} className="ui-sub">
                12 印・件数
              </p>
            </div>
          </Section>
        </Page>
      </main>
    </div>
  ),
};

/** 画面で使う部品。新しい画面を作るときは、まずここにあるものを使う */
export const 部品: Story = {
  render: () => (
    <div className="ui ui-app ui-app--doc" lang="ja">
      <main className="ui-main">
        <Page title="部品" lead="塗りのボタンは、1 つの塊に 1 つだけ。ほかは線か文字だけにする。">
          <Section title="ボタン">
            <div className="ui-row">
              <Button tone="primary">承認して merge する</Button>
              <Button>Claude Code に頼む</Button>
              <Button tone="quiet">やらないことにする</Button>
              <Button tone="danger">止めて完了にする</Button>
              <Button disabled>聞く</Button>
            </div>
            <div className="ui-row">
              <Button tone="primary" size="lg">
                新しい Task にする <Kbd>N</Kbd>
              </Button>
              <Button size="sm">
                <Icon name="check" size={14} />
                完了にする
              </Button>
              <Button size="sm" tone="quiet">
                <Icon name="open" size={14} />
                開く
              </Button>
            </div>
          </Section>
          <Section title="印">
            <div className="ui-row">
              <AttentionPill attention={{ kind: "新着" }} />
              <AttentionPill attention={{ kind: "更新" }} />
              <Pill tone="outline">完了待ち</Pill>
              <Pill tone="seiji">新しい Task の提案</Pill>
              <WorkingPill />
              <Pill tone="ruri">優先度を決めてください</Pill>
              <Pill tone="bengara">認証が通らない</Pill>
              <SourceMarks sources={["github", "slack", "gmail", "calendar", "notion", "outlook", "teams", "manual"]} />
            </div>
          </Section>
          <Section title="優先度を選ぶ">
            <div className="ui-card">
              <div className="ui-segmented" role="group" aria-label="優先度">
                {["今すぐ", "今日中", "3 日以内", "10 日以内", "30 日以内", "それより先でよい"].map((level) => (
                  <button key={level} type="button" aria-pressed={level === "今日中"}>
                    {level}
                  </button>
                ))}
              </div>
            </div>
          </Section>
          <Section title="失敗">
            <Problem
              title="書き込めませんでした（権限が足りない）"
              actions={
                <Button tone="primary" size="sm">
                  頼み直す
                </Button>
              }
            >
              <p>GitHub のトークンに workflow の権限がありません。設定でトークンを入れ直すと書き込めます</p>
            </Problem>
          </Section>
          <Section title="AI が考えている">
            <p className="ui-thinking">AI が計画を考えています</p>
          </Section>
        </Page>
      </main>
    </div>
  ),
};
