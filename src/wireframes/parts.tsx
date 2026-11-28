import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Attention } from "./horizon.js";
import type { How } from "./model.js";

/** 本文の代わりの線。案の比較（thumbnail ボード）で、段落の長さが問いに関係しないときだけ使う */
export function Bars({ count = 2 }: { count?: number }) {
  return (
    <span className="wf-placeholder-bars" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} style={{ inlineSize: `${index === count - 1 ? 60 : 100}%` }} />
      ))}
    </span>
  );
}

export type BoxKind = "fact" | "ai" | "mine" | "waiting" | "quiet" | "error";

export function Box(props: { kind?: BoxKind; label?: string; className?: string; children?: ReactNode }) {
  const kind = props.kind ?? "fact";
  const modifier = kind === "fact" ? "" : ` wf-box--${kind}`;
  return (
    <div className={`wf-box${modifier}${props.className ? ` ${props.className}` : ""}`}>
      {props.label && <span className="wf-box-label">{props.label}</span>}
      {props.children}
    </div>
  );
}

export function Button({ tone = "default", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "quiet" | "danger" }) {
  const modifier = tone === "default" ? "" : ` wf-button--${tone}`;
  return <button type="button" className={`wf-button${modifier}${className ? ` ${className}` : ""}`} {...rest} />;
}

/** 注釈の番号マーカー。要素の横に置く。説明は窓の外の注釈の一覧（WfFrame の notes）に書く */
export function Mark({ n }: { n: number }) {
  return (
    <span className="wf-mark" data-wf-mark={n} aria-label={`注釈 ${n}`}>
      {n}
    </span>
  );
}

const SOURCE_MARKS: Record<string, string> = {
  github: "GH",
  slack: "Sl",
  gmail: "Gm",
  calendar: "Ca",
  notion: "No",
  outlook: "Ol",
  teams: "Te",
  manual: "手",
};

const SOURCE_NAMES: Record<string, string> = {
  github: "GitHub",
  slack: "Slack",
  gmail: "Gmail",
  calendar: "Google Calendar",
  notion: "Notion",
  outlook: "Outlook",
  teams: "Teams",
  manual: "手で追加",
};

/** どの Source の事実を持つか。ロゴの代わりに 2 文字の箱で見せる */
export function SourceMarks({ sources }: { sources: string[] }) {
  return (
    <span className="wf-sources" role="list" aria-label="事実の取得元">
      {sources.map((source) => (
        <span key={source} role="listitem" className="wf-source" title={SOURCE_NAMES[source] ?? source} aria-label={SOURCE_NAMES[source] ?? source}>
          {SOURCE_MARKS[source] ?? source.slice(0, 2)}
        </span>
      ))}
    </span>
  );
}

export function AttentionMark({ attention }: { attention: Attention }) {
  if (attention.kind === "なし") return null;
  return <span className="wf-pill wf-pill--mine">{attention.kind}</span>;
}

export function WorkingMark() {
  return <span className="wf-pill wf-pill--waiting">AI 作業中</span>;
}

const HOW_LABELS: Record<How, string> = {
  human: "自分でやる",
  claude: "Claude Code がやる",
  condition: "待つ",
  write: "書き込む（承認）",
  decision: "選ぶ",
};

export const howLabel = (how: How) => HOW_LABELS[how];

/** 和文に続く語が英字で始まるときだけ空きを入れる（「承認して merge する」「承認して返信する」） */
export const joinJa = (head: string, tail: string) => (/^[A-Za-z0-9]/.test(tail) ? `${head} ${tail}` : `${head}${tail}`);

export function HowTag({ how }: { how: How }) {
  const modifier = how === "claude" ? " wf-pill--ai" : how === "condition" ? " wf-pill--waiting" : how === "write" ? " wf-pill--mine" : "";
  return <span className={`wf-pill${modifier}`}>{HOW_LABELS[how]}</span>;
}

/**
 * 操作の結果のお知らせ（「対象外にしました」と元に戻す）。
 * popover="manual" にする理由: ほかの場所を押しても消えないようにし、元に戻す前に閉じてしまわないため。
 * 同じことは Task の履歴からも分かるので、お知らせを見逃しても困らない。
 */
export function Toast(props: { message: string; action?: { label: string; onClick: () => void }; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    // happy-dom などテストの環境には showPopover がない
    if (element && typeof element.showPopover === "function" && !element.matches(":popover-open")) element.showPopover();
    const announce = (document as Document & { ariaNotify?: (message: string) => void }).ariaNotify;
    announce?.call(document, props.action ? `${props.message}。操作できます` : props.message);
  }, [props.message, props.action]);
  return (
    <div ref={ref} className="wf-toast" {...({ popover: "manual" } as object)} role="status">
      <span>{props.message}</span>
      {props.action && <Button onClick={props.action.onClick}>{props.action.label}</Button>}
      <Button tone="quiet" onClick={props.onClose} aria-label="お知らせを閉じる">
        閉じる
      </Button>
    </div>
  );
}

/**
 * AI の作業を止めるかを確かめるダイアログ（specs: 作業を止める・作業中に終える・選び直すときは「作業を止めますか」と確かめる）。
 * 初めのフォーカスは「止めない」に置く。止めると途中までの報告だけが残り、元に戻せないため。
 */
export function StopWorkButton(props: { label: string; tone?: "default" | "primary" | "quiet" | "danger"; what: string; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <>
      <Button tone={props.tone ?? "quiet"} onClick={() => ref.current?.showModal()}>
        {props.label}
      </Button>
      <dialog
        ref={ref}
        className="wf wf-dialog"
        aria-labelledby={titleId}
        {...({ closedby: "any" } as object)}
        onClose={(event) => {
          const dialog = event.currentTarget;
          if (dialog.returnValue === "stop") props.onConfirm();
          dialog.returnValue = "";
        }}
      >
        <form method="dialog">
          <h1 id={titleId}>Claude Code の作業を止めますか？</h1>
          <p>{props.what}。止めると、途中までの報告だけが残ります。</p>
          <div className="wf-button-row">
            <Button type="submit" value="keep" autoFocus>
              止めない
            </Button>
            <Button tone="danger" type="submit" value="stop">
              止めて{props.label}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
