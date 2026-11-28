import { Bars } from "./parts.js";
import "./wireframe.css";

/**
 * 見通し（ホーム）の構造の案。仕組みの違う 3 案を小さく並べて比べる（thumbnail ボード）。
 * 段落の長さは問いに関係しないので、ここでだけ本文を線で代用する。
 */
export function HorizonDirections() {
  return (
    <div className="wf" style={{ padding: 24, display: "grid", gap: 24 }}>
      <h1 className="wf-title">見通しの構造の案</h1>
      <p>問い: 毎朝開いたとき、どの構造で「今やること」を見せるか</p>
      <div className="wf-thumbs">
        <Thumb
          name="A. 優先度でまとめた一覧 + 右に詳細"
          recommended
          tradeoff="上から読めば今やることが分かり、詳細を開いても一覧が残る。進み具合（列）は別の画面（カンバン）で見る"
        >
          <div style={{ display: "grid", gridTemplateColumns: "48px 1fr 96px", gap: 4, blockSize: "100%" }}>
            <Zone label="画面" />
            <div style={{ display: "grid", gap: 4, alignContent: "start" }}>
              <Zone label="承認で止まっている書き込み" />
              <strong>今すぐ</strong>
              <Zone label="大きいカード（次の一手まで）" tall />
              <strong>今日中</strong>
              <Zone label="1 行（次の一手）" />
              <Zone label="1 行（次の一手）" />
              <span>10 日以内（閉じている）</span>
            </div>
            <Zone label="詳細" tall />
          </div>
        </Thumb>
        <Thumb name="B. 優先度の段を列にしたボード" tradeoff="どの段に何件あるかが一目で分かる。6 列並ぶと 1 列が狭く、次の一手が読めない">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4, blockSize: "100%" }}>
            {["今すぐ", "今日中", "3 日", "10 日", "30 日", "先"].map((label) => (
              <div key={label} style={{ display: "grid", gap: 4, alignContent: "start" }}>
                <strong>{label}</strong>
                <Zone label="" />
                <Zone label="" />
              </div>
            ))}
          </div>
        </Thumb>
        <Thumb name="C. 自分が動くものを 1 件ずつ片付けるキュー" tradeoff="承認・提案・今すぐを 1 列に混ぜ、上から片付けるので朝の処理は速い。3 日以内より先の見通しが見えない">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 4, blockSize: "100%" }}>
            <div style={{ display: "grid", gap: 4, alignContent: "start" }}>
              <span>次に片付けるもの</span>
              <Zone label="承認" />
              <Zone label="提案" />
              <Zone label="ラベル未定" />
              <Zone label="今すぐ" />
            </div>
            <div style={{ display: "grid", gap: 4, alignContent: "start", padding: 4, border: "1px solid #26262e" }}>
              <strong>1 件を大きく</strong>
              <Bars count={3} />
              <span>［ 決める ］［ 次へ ］</span>
            </div>
          </div>
        </Thumb>
      </div>
      <p>推奨: A。毎朝の問い「今日やることは何か」に上から答えられ、提案・承認は別の画面に分けても件数を最上段で知らせられる。C の「1 件ずつ片付ける」は、提案の画面に取り入れている。</p>
    </div>
  );
}

function Thumb(props: { name: string; tradeoff: string; recommended?: boolean; children: React.ReactNode }) {
  return (
    <section className={`wf-thumb${props.recommended ? " wf-thumb--recommended" : ""}`}>
      <div className="wf-thumb-canvas">{props.children}</div>
      <h2 className="wf-section-title">
        {props.name}
        {props.recommended && "（推奨）"}
      </h2>
      <p className="wf-sub">{props.tradeoff}</p>
    </section>
  );
}

function Zone({ label, tall = false }: { label: string; tall?: boolean }) {
  return <div style={{ minBlockSize: tall ? 64 : 24, padding: 4, border: "1px solid #c9c9d1", color: "#62626b" }}>{label}</div>;
}

/** 画面のつながり（breadboard）。すべての操作の行き先を書き切り、行き止まりがないかを見る */
const PLACES: Array<{ name: string; items: string[] }> = [
  {
    name: "［見通し］",
    items: [
      "承認で止まっている書き込み → ［承認］",
      "ラベル未定の Task → ［Task の詳細］で優先度を決める",
      "Task の行 → ［Task の詳細］（右に並ぶ）",
      "次の一手「済んだ」「Claude Code に頼む」 → その場で計画が進む",
      "やらないことにする → お知らせ（元に戻す）",
      "Task を追加 → ［追加のダイアログ］ → Todo に入る",
      "取り込めていない → ［設定］のアカウント",
      "一度に大量に消えた → 消えたことにする／反映しない",
    ],
  },
  {
    name: "［Task の詳細］",
    items: [
      "完了にする → 完了したときにすることがあれば完了待ち、なければ終わる",
      "やらないことにする（作業中なら［作業を止めますか］）",
      "別の Task にまとめる（作業中はできない）",
      "計画の項目: 事実から足した項目を別の Task に切り出す → 新しい Task ができる",
      "優先度を自分で決める／アプリに任せる・期日を直す",
      "計画の項目: 済んだ・Claude Code に頼む・書き込みを頼む → ［承認］・選ぶ・選び直す・戻す",
      "事実: 開く（元のツール）・外す・別の Task に移す",
      "AI に聞く → 回答がここに出る",
      "定期の Task にする → ［設定］の定期の Task に足される",
    ],
  },
  {
    name: "［提案］",
    items: [
      "提案（新しい Task・既存の Task に足す・切り出す）: 受け入れる・別の形で受け入れる・見送る → 次の 1 件",
      "AI が判断できなかった事実: 新しい Task にする・既存の Task に入れる・対象外にする → 次の 1 件",
      "見送った提案・AI が自動でしたこと（閉じた一覧）",
      "元のツールで開く",
      "0 件 → 見通しに戻る",
    ],
  },
  {
    name: "［承認］",
    items: [
      "頼むのを待っている書き込み → 中身を確かめる → 承認して〇〇する／やめる",
      "版が変わった → 頼み直す",
      "書き込めなかった → 頼み直す（権限なら［設定］）",
      "書けたか分からない → 外を確かめるまで待つ",
    ],
  },
  { name: "［カンバン］", items: ["カードをドラッグで列を移す", "カード → ［Task の詳細］", "定期の Task の予告 → 今すぐ作る"] },
  {
    name: "［設定］",
    items: ["AI の 3 つを設定（そろうまで、ほかの画面は開けない）", "自動でやってよい範囲を操作ごとに選ぶ", "アカウント: つなぐ・つなぎ直す・範囲を変える・外す・戻す", "定期の Task: 足す・直す・止める・また使う・消す"],
  },
];

export function Breadboard() {
  return (
    <div className="wf" style={{ padding: 24, display: "grid", gap: 24 }}>
      <h1 className="wf-title">画面のつながり</h1>
      <p>左のレールの行き先は［見通し］［提案］［承認］［カンバン］［設定］の 5 つで、どの画面からも行ける。</p>
      <div className="wf-breadboard">
        {PLACES.map((place) => (
          <section key={place.name} className="wf-place">
            <h2>{place.name}</h2>
            <ul>
              {place.items.map((item) => (
                <li key={item}>・{item}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
