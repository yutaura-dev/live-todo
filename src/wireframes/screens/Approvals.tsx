import { useState } from "react";
import { autoWrites, writeRequests, writeTroubles, type WriteRequest, type WriteTrouble } from "../fixtures.js";
import { Box, Button, joinJa, Mark, SourceMarks } from "../parts.js";
import { AppFrame, ScreenHead, type View } from "./AppFrame.js";

/** 確認中の書き込みが、見せたあとにどうなったか（specs/write.spec.ts の approve の条件） */
export type Freshness = "見せたとおり" | "版が変わった" | "書き込めない状態";

type Stage = "確認中" | "書き込み中" | "書き込んだ" | "取りやめた";

type Selected = { kind: "頼む"; id: number } | { kind: "困った"; id: number };

/**
 * 承認。外への書き込みは、承認がなければしない（charter）。ここには、あなたが動かないと進まない書き込みを集める。
 * - 頼むのを待っている書き込み: 書き込みで果たす Action Item に番が来ていて、自動では書き込まないもの。開くと中身を見せる（確認中）
 * - 書き込めなかった・書けたか分からないもの: 理由と、次に何をすればよいかを出す
 * - 自動で書き込んだもの: 自動でやってよい範囲で、承認なしに書き込んだもの。そのときの範囲も残す
 */
export function Approvals(props: { requests?: WriteRequest[]; troubles?: WriteTrouble[]; select?: Selected; freshness?: Freshness; onNavigate?: (view: View) => void }) {
  const requests = props.requests ?? writeRequests;
  const troubles = props.troubles ?? writeTroubles;
  const first: Selected | null = requests[0] ? { kind: "頼む", id: requests[0].id } : troubles[0] ? { kind: "困った", id: troubles[0].id } : null;
  const [selected, setSelected] = useState<Selected | null>(props.select ?? first);
  const [stages, setStages] = useState<Record<number, Stage>>({});
  const request = selected?.kind === "頼む" ? requests.find((item) => item.id === selected.id) : undefined;
  const trouble = selected?.kind === "困った" ? troubles.find((item) => item.id === selected.id) : undefined;
  const isCurrent = (key: Selected) => selected?.kind === key.kind && selected.id === key.id;

  return (
    <AppFrame current="承認" counts={{ 承認: requests.length + troubles.length }} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}>
      <ScreenHead title="承認" />
      <div className="wf-split">
        <div className="wf-stack">
          {requests.length > 0 && (
            <section className="wf-section" aria-labelledby="wf-req-title">
              <h2 id="wf-req-title" className="wf-section-title">
                頼むのを待っている書き込み <span className="wf-horizon-count">{requests.length}</span> <Mark n={1} />
              </h2>
              <ul className="wf-queue">
                {requests.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="wf-approval-item" aria-current={isCurrent({ kind: "頼む", id: item.id }) ? "true" : undefined} onClick={() => setSelected({ kind: "頼む", id: item.id })}>
                      <strong>{item.operation}</strong>
                      <small>{item.target}</small>
                      {stages[item.id] && <small>{stages[item.id]}</small>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {troubles.length > 0 && (
            <section className="wf-section" aria-labelledby="wf-trouble-title">
              <h2 id="wf-trouble-title" className="wf-section-title">
                書き込めなかったもの <span className="wf-horizon-count">{troubles.length}</span> <Mark n={5} />
              </h2>
              <ul className="wf-queue">
                {troubles.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="wf-approval-item" aria-current={isCurrent({ kind: "困った", id: item.id }) ? "true" : undefined} onClick={() => setSelected({ kind: "困った", id: item.id })}>
                      <strong>{item.operation}</strong>
                      <small>{item.target}</small>
                      <small>{item.stage}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <details className="wf-more">
            <summary>
              <span className="wf-section-title">今日、自動で書き込んだもの</span>
              <span className="wf-horizon-count">{autoWrites.length} 件</span>
              <Mark n={6} />
            </summary>
            <ul className="wf-history" style={{ padding: "8px 16px 16px" }}>
              {autoWrites.map((write) => (
                <li key={write.what} style={{ gridTemplateColumns: "4em minmax(0, 1fr)" }}>
                  <span>{write.at}</span>
                  <span>{write.what}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
        <div className="wf-stack">
          {request && (
            <RequestDetail
              request={request}
              stage={stages[request.id] ?? "確認中"}
              freshness={props.freshness ?? "見せたとおり"}
              onStage={(stage) => {
                const next = { ...stages, [request.id]: stage };
                setStages(next);
                // 承認した・やめたら、まだ手を付けていない次の書き込みを開く（一覧から選び直さずに済む）
                if (stage === "書き込み中" || stage === "取りやめた") {
                  const rest = requests.find((candidate) => candidate.id !== request.id && next[candidate.id] === undefined);
                  if (rest) setSelected({ kind: "頼む", id: rest.id });
                }
              }}
            />
          )}
          {trouble && <TroubleDetail trouble={trouble} />}
          {!request && !trouble && <p className="wf-horizon-empty">あなたを待っている書き込みはありません</p>}
        </div>
      </div>
    </AppFrame>
  );
}

function RequestDetail(props: { request: WriteRequest; stage: Stage; freshness: Freshness; onStage: (stage: Stage) => void }) {
  const { request, stage, freshness } = props;
  return (
    <Box className="wf-focus-card">
      <div className="wf-task-top">
        <SourceMarks sources={[request.source]} />
        <span className="wf-task-reason">Task「{request.taskTitle}」の計画から</span>
      </div>
      <h2 className="wf-task-title">{request.operation}</h2>
      <p>
        {request.target}　{request.summary} <Mark n={2} />
      </p>
      <Box kind="ai" label="書き込む中身">
        <div className="wf-diff">
          {request.content.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </Box>
      {stage === "確認中" && freshness === "版が変わった" && (
        <Box kind="error" label="⚠ 承認できません">
          <Mark n={3} />
          <p>見せたあとに PR に commit が足されました。今の中身で確かめ直してください</p>
          <div className="wf-button-row" style={{ marginBlockStart: 12 }}>
            <Button tone="primary">頼み直す（今の中身を見る）</Button>
          </div>
        </Box>
      )}
      {stage === "確認中" && freshness === "書き込めない状態" && (
        <Box kind="error" label="⚠ 今は書き込めません">
          <p>CI が落ちたので、merge できない状態です。CI が通ったら、もう一度頼んでください</p>
        </Box>
      )}
      {stage === "書き込み中" && (
        <Box kind="waiting" label="書き込んでいます">
          <p>書き込めたら、Task の計画が次に進みます</p>
        </Box>
      )}
      {stage === "書き込んだ" && <Box label="書き込みました">Task の履歴に残しました</Box>}
      {stage === "取りやめた" && <Box kind="quiet" label="やめました">書き込んでいません。計画の項目は、番が来たままです</Box>}
      {stage === "確認中" && freshness === "見せたとおり" && (
        <div className="wf-big-actions">
          <Button tone="primary" onClick={() => props.onStage("書き込み中")}>
            {joinJa("承認して", request.verb)}
          </Button>
          <Mark n={4} />
          <Button tone="quiet" onClick={() => props.onStage("取りやめた")}>
            やめる
          </Button>
        </div>
      )}
    </Box>
  );
}

function TroubleDetail({ trouble }: { trouble: WriteTrouble }) {
  return (
    <Box className="wf-focus-card">
      <div className="wf-task-top">
        <SourceMarks sources={[trouble.source]} />
        <span className="wf-task-reason">Task「{trouble.taskTitle}」から</span>
      </div>
      <h2 className="wf-task-title">{trouble.operation}</h2>
      <p>{trouble.target}</p>
      {trouble.stage === "書けたか分からない" ? (
        <Box kind="waiting" label="書けたか分からない">
          <p>書き込みの途中でアプリが止まりました。二重に書き込まないよう、やり直さずに外を確かめています</p>
        </Box>
      ) : (
        <>
          <Box kind="error" label={`⚠ 書き込めませんでした（${trouble.failure?.kind}）`}>
            <p>{trouble.failure?.message}</p>
          </Box>
          <div className="wf-button-row">
            <Button tone="primary">頼み直す（中身を確かめ直す）</Button>
          </div>
        </>
      )}
    </Box>
  );
}

export const APPROVAL_NOTES = [
  { n: 1, text: "書き込みで果たす Action Item に番が来ていて、自動では書き込まないもの。一覧で選ぶと中身を見せる（確認中）" },
  { n: 2, text: "見せるのは「どこへ・何を」と書き込む中身だけ。自動で書き込まない理由や版は、ふだんは出さない" },
  { n: 3, text: "版は、見せたあとに変わったときだけ知らせる（PR に commit が足された など）。そのときは承認できず、頼み直して確かめ直す" },
  { n: 4, text: "承認のボタンには操作の名前（merge する・返信する）をそのまま書く。押すと書き込み中 → 書き込んだ／書き込めなかった が同じ場所に出る。承認したら、次の書き込みを自動で開く" },
  { n: 5, text: "失敗は理由ごとに次の一手を示し、頼み直す（中身を確かめ直す）。書けたか分からないものは、二重に書かないよう外を確かめる" },
  { n: 6, text: "自動で書き込んだものは閉じておき、気になったときに開いて確かめる" },
];

export const APPROVAL_QUESTIONS = [
  "書き込む事実を、ほかの開いている Task も持っているとき（メールのアーカイブなど）、この画面で知らせるか、自動では書き込まないか？（specs/routing.spec.ts の questions）",
];
