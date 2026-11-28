import { Box, Button, HowTag, Mark, SourceMarks, WorkingMark } from "./parts.js";
import "./wireframe.css";

export function Legend() {
  return (
    <div className="wf" style={{ padding: 24, display: "grid", gap: 24, maxInlineSize: 960 }}>
      <h1 className="wf-title">ワイヤーフレームの読み方</h1>
      <p>構造（何があり、どこにあり、何が一番重要か）を決めるためのものです。色・書体・最終の文言はまだ決めていません。</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
        <Box label="実線">自分の Task・事実（Source Item）</Box>
        <Box kind="ai" label="破線（白）">AI が書いたもの（今の状況・回答・書き込む中身）</Box>
        <Box kind="waiting" label="破線（灰色の面）">待っているもの・AI が作業中のもの</Box>
        <Box kind="mine" label="太い線">自分の手が要るもの（番が来ている項目・承認で止まっている書き込み）</Box>
        <Box kind="error" label="⚠ 赤い線">失敗・書き込めなかったもの</Box>
        <Box kind="quiet" label="灰色の面">補助の情報（元の文面・記録）</Box>
      </div>
      <section className="wf-section">
        <h2 className="wf-section-title">色を使う場所は 3 つだけ</h2>
        <div className="wf-button-row">
          <Button tone="primary">主要操作</Button>
          <Button>ほかの操作</Button>
          <Button tone="quiet">控えめな操作</Button>
          <Button tone="danger">止める・壊す操作</Button>
          <Mark n={1} />
          <span className="wf-sub">赤い破線の番号は注釈。説明は窓の外の一覧にある</span>
        </div>
      </section>
      <section className="wf-section">
        <h2 className="wf-section-title">次の一手が、何によって果たされるか</h2>
        <div className="wf-button-row">
          <HowTag how="human" />
          <HowTag how="claude" />
          <HowTag how="condition" />
          <HowTag how="write" />
          <HowTag how="decision" />
          <WorkingMark />
        </div>
      </section>
      <section className="wf-section">
        <h2 className="wf-section-title">事実の取得元</h2>
        <SourceMarks sources={["github", "slack", "gmail", "calendar", "notion", "outlook", "teams", "manual"]} />
      </section>
    </div>
  );
}

export const LEGEND_NOTES = [{ n: 1, text: "注釈の番号の例。各画面で 1 から振り直す" }];
