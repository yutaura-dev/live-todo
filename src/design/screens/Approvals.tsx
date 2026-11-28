import { useState } from "react";
import { autoWrites, writeRequests, writeTroubles, type WriteRequest, type WriteTrouble } from "../../wireframes/fixtures.js";
import { AppShell, ScreenHead, type View } from "../AppShell.js";
import { Button, Icon, Problem, SourceMarks, sourceName } from "../components.js";

export type Freshness = "見せたとおり" | "版が変わった" | "書き込めない状態";

type Stage = "確認中" | "書き込み中" | "書き込んだ" | "取りやめた";

type Selected = { kind: "頼む"; id: number } | { kind: "困った"; id: number };

const joinJa = (head: string, tail: string) => (/^[A-Za-z0-9]/.test(tail) ? `${head} ${tail}` : `${head}${tail}`);

/**
 * 承認。外への書き込みは、承認がなければしない（charter）。あなたが動かないと進まない書き込みを集める。
 * 書き込む中身は「外に出る紙」として白い板に置き、アプリの説明（灰色）と見分ける。
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
  const empty = requests.length === 0 && troubles.length === 0;

  return (
    <AppShell current="承認" counts={{ 承認: requests.length + troubles.length }} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}>
      <ScreenHead title="承認" subtitle="外への書き込みは、ここで承認するまでしません" />
      <div className="ui-split">
        <nav className="ui-queue-nav" aria-label="書き込み">
          {requests.length > 0 && (
            <section className="ui-queue" aria-label="頼むのを待っている書き込み">
              <h2 className="ui-queue-title">
                頼むのを待っている書き込み
                <span className="ui-num">{requests.length}</span>
              </h2>
              <ul>
                {requests.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="ui-queue-item ui-queue-item--two" aria-current={isCurrent({ kind: "頼む", id: item.id }) ? "true" : undefined} onClick={() => setSelected({ kind: "頼む", id: item.id })}>
                      <SourceMarks sources={[item.source]} />
                      <span className="ui-queue-text">
                        <span>{item.operation}</span>
                        <span className="ui-sub">{stages[item.id] ?? item.target}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {troubles.length > 0 && (
            <section className="ui-queue" aria-label="書き込めなかったもの">
              <h2 className="ui-queue-title">
                書き込めなかったもの
                <span className="ui-num">{troubles.length}</span>
              </h2>
              <ul>
                {troubles.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="ui-queue-item ui-queue-item--two" aria-current={isCurrent({ kind: "困った", id: item.id }) ? "true" : undefined} onClick={() => setSelected({ kind: "困った", id: item.id })}>
                      <SourceMarks sources={[item.source]} />
                      <span className="ui-queue-text">
                        <span>{item.operation}</span>
                        <span className={item.stage === "失敗" ? "ui-queue-problem" : "ui-sub"}>{item.stage === "失敗" ? "書き込めませんでした" : "書けたか分からない"}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <details className="ui-disclosure ui-auto-writes">
            <summary>
              <Icon name="chevron" size={14} />
              <span>今日、自動で書き込んだもの</span>
              <span className="ui-sub ui-num">{autoWrites.length} 件</span>
            </summary>
            <ol className="ui-auto-list">
              {autoWrites.map((write) => (
                <li key={write.what}>
                  <span className="ui-num ui-sub">{write.at}</span>
                  <span className="ui-stack-4">
                    <span>{write.what}</span>
                    <span className="ui-sub">自動でやってよい範囲: {write.policy}</span>
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </nav>
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
        {empty && (
          <div className="ui-empty">
            <p className="ui-empty-title">あなたを待っている書き込みはありません</p>
            <p className="ui-sub">書き込みで果たす項目に番が来ると、ここに並びます</p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function RequestDetail(props: { request: WriteRequest; stage: Stage; freshness: Freshness; onStage: (stage: Stage) => void }) {
  const { request, stage, freshness } = props;
  return (
    <article className="ui-focus" aria-labelledby="ui-write-title">
      <p className="ui-focus-from">
        <SourceMarks sources={[request.source]} />
        Task「{request.taskTitle}」の計画から
      </p>
      <h2 id="ui-write-title" className="ui-focus-title">
        {request.operation}
      </h2>
      <dl className="ui-write-meta">
        <dt>書き込む先</dt>
        <dd>
          {sourceName(request.source)}の {request.target}
        </dd>
        <dt>すること</dt>
        <dd>{request.summary}</dd>
      </dl>
      <figure className="ui-outgoing">
        <figcaption>書き込む中身</figcaption>
        <div className="ui-outgoing-body">
          {request.content.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </figure>
      {stage === "確認中" && freshness === "版が変わった" && (
        <Problem
          title="承認できません"
          actions={
            <Button tone="primary" size="sm">
              頼み直す（今の中身を見る）
            </Button>
          }
        >
          <p>見せたあとに PR に commit が足されました。今の中身で確かめ直してください</p>
        </Problem>
      )}
      {stage === "確認中" && freshness === "書き込めない状態" && (
        <Problem title="今は書き込めません">
          <p>CI が落ちたので、merge できない状態です。CI が通ったら、もう一度頼んでください</p>
        </Problem>
      )}
      {stage === "書き込み中" && <p className="ui-thinking">書き込んでいます。書き込めたら、Task の計画が次に進みます</p>}
      {stage === "書き込んだ" && (
        <p className="ui-result-done">
          <Icon name="check" />
          書き込みました。Task の履歴に残しました
        </p>
      )}
      {stage === "取りやめた" && <p className="ui-sub">やめました。書き込んでいません。計画の項目は、番が来たままです</p>}
      {stage === "確認中" && freshness === "見せたとおり" && (
        <div className="ui-decide-actions">
          <Button tone="primary" size="lg" onClick={() => props.onStage("書き込み中")}>
            {joinJa("承認して", request.verb)}
          </Button>
          <Button tone="quiet" size="lg" onClick={() => props.onStage("取りやめた")}>
            やめる
          </Button>
        </div>
      )}
    </article>
  );
}

function TroubleDetail({ trouble }: { trouble: WriteTrouble }) {
  return (
    <article className="ui-focus" aria-labelledby="ui-trouble-title">
      <p className="ui-focus-from">
        <SourceMarks sources={[trouble.source]} />
        Task「{trouble.taskTitle}」から
      </p>
      <h2 id="ui-trouble-title" className="ui-focus-title">
        {trouble.operation}
      </h2>
      <p className="ui-sub">{trouble.target}</p>
      {trouble.stage === "書けたか分からない" ? (
        <div className="ui-unsure">
          <p className="ui-thinking">書けたか確かめています</p>
          <p>書き込みの途中でアプリが止まりました。二重に書き込まないよう、やり直さずに外の様子を確かめています。分かりしだい、ここに出します</p>
        </div>
      ) : (
        <Problem
          title={`書き込めませんでした（${trouble.failure?.kind}）`}
          actions={
            <>
              <Button tone="primary" size="sm">
                頼み直す（中身を確かめ直す）
              </Button>
              {trouble.failure?.kind === "権限が足りない" && <Button size="sm">設定を開く</Button>}
            </>
          }
        >
          <p>{trouble.failure?.message}</p>
        </Problem>
      )}
    </article>
  );
}
