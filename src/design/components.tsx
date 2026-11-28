import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Attention } from "../wireframes/horizon.js";
import { SourceIcon, useBrandIcon } from "./source-icons.js";

export type Tone = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  tone = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "sm" | "md" | "lg" }) {
  return <button type="button" className={`ui-button ui-button--${tone} ui-button--${size}${className ? ` ${className}` : ""}`} {...rest} />;
}

/** 線だけの小さな印。絵文字や外部のアイコン集を使わない理由: 線の太さと大きさを文字にそろえたいため */
const ICON_PATHS = {
  check: "M3.5 8.5l3 3 6-7",
  close: "M4 4l8 8M12 4l-8 8",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  plus: "M8 3v10M3 8h10",
  open: "M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5",
  warn: "M8 2.5l6 11H2zM8 7v3M8 12h.01",
  chevron: "M6 4l4 4-4 4",
  undo: "M5.5 4L2.5 7l3 3M3 7h6.5a3.5 3.5 0 010 7H7",
  pencil: "M10.5 3l2.5 2.5L6 12.5 3 13l.5-3z",
} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg className="ui-icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export type PillTone = "neutral" | "ruri" | "seiji" | "bengara" | "outline";

export function Pill({ tone = "neutral", live = false, children }: { tone?: PillTone; live?: boolean; children: ReactNode }) {
  return (
    <span className={`ui-pill ui-pill--${tone}`}>
      {live && <span className="ui-pill-pulse" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function AttentionPill({ attention }: { attention: Attention }) {
  if (attention.kind === "なし") return null;
  return (
    <span className="ui-attention">
      <span className="ui-attention-dot" aria-hidden="true" />
      {attention.kind}
    </span>
  );
}

export function WorkingPill() {
  return (
    <Pill tone="seiji" live>
      AI 作業中
    </Pill>
  );
}

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

export const sourceName = (source: string) => SOURCE_NAMES[source] ?? source;

/**
 * 取得元の印。ロゴを使えるサービスはロゴで、使えないサービスと知らない取得元は名前の文字で見せる。
 * 手で足した Task は鉛筆の印にする。名前は読み上げとツールチップにも持たせる。
 */
export function SourceMarks({ sources, size = 16 }: { sources: string[]; size?: number }) {
  return (
    <span className="ui-sources" role="list" aria-label="事実の取得元">
      {sources.map((source) => (
        <SourceMark key={source} source={source} size={size} />
      ))}
    </span>
  );
}

function SourceMark({ source, size }: { source: string; size: number }) {
  const name = sourceName(source);
  const icon = useBrandIcon(source);
  const textual = source !== "manual" && icon === null;
  return (
    <span role="listitem" className={textual ? "ui-source ui-source--text" : "ui-source"} title={name} aria-label={name}>
      {source === "manual" ? <Icon name="pencil" size={size} /> : icon ? <SourceIcon src={icon} size={size} /> : <span aria-hidden="true">{name}</span>}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

/** AI が書いた文。青磁の面に置き、誰が書いたかを添える（自分や外の人の文と取り違えないように） */
export function AiText({ label = "AI が書いた", children }: { label?: string; children: ReactNode }) {
  return (
    <div className="ui-ai">
      <p className="ui-ai-label">{label}</p>
      <div className="ui-ai-body">{children}</div>
    </div>
  );
}

/** 外の人が書いた文（元の文面の抜粋）。かぎ括弧を大きく添え、アプリや AI の文と見分ける */
export function Quote({ children, from }: { children: ReactNode; from?: string }) {
  return (
    <figure className="ui-quote">
      <blockquote>{children}</blockquote>
      {from && <figcaption>{from}</figcaption>}
    </figure>
  );
}

/** 失敗・書き込めなかったもの。弁柄はここでしか使わない */
export function Problem({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ui-problem" role="alert">
      <p className="ui-problem-title">
        <Icon name="warn" />
        {title}
      </p>
      {children && <div className="ui-problem-body">{children}</div>}
      {actions && <div className="ui-row">{actions}</div>}
    </div>
  );
}

/**
 * 操作の結果のお知らせ。popover="manual" にする理由: ほかの場所を押しても消えないようにし、元に戻す前に閉じてしまわないため。
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
    <div ref={ref} className="ui-toast" {...({ popover: "manual" } as object)} role="status">
      <span className="ui-toast-message">{props.message}</span>
      {props.action && (
        <Button tone="quiet" size="sm" className="ui-toast-action" onClick={props.action.onClick}>
          <Icon name="undo" />
          {props.action.label}
        </Button>
      )}
      <Button tone="quiet" size="sm" onClick={props.onClose} aria-label="お知らせを閉じる">
        <Icon name="close" />
      </Button>
    </div>
  );
}

/**
 * AI の作業を止めるかを確かめるダイアログ。初めのフォーカスは「止めない」に置く。
 * 止めると途中までの報告だけが残り、元に戻せないため。
 */
export function StopWorkButton(props: { label: string; tone?: Tone; size?: "sm" | "md"; what: string; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <>
      <Button tone={props.tone ?? "quiet"} size={props.size ?? "md"} onClick={() => ref.current?.showModal()}>
        {props.label}
      </Button>
      <dialog
        ref={ref}
        className="ui ui-dialog"
        aria-labelledby={titleId}
        {...({ closedby: "any" } as object)}
        onClose={(event) => {
          const dialog = event.currentTarget;
          if (dialog.returnValue === "stop") props.onConfirm();
          dialog.returnValue = "";
        }}
      >
        <form method="dialog" className="ui-dialog-body">
          <h1 id={titleId} className="ui-dialog-title">
            作業を止めますか
          </h1>
          <p>{props.what}。止めると、途中までの報告だけが残ります。</p>
          <div className="ui-row ui-row--end">
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

/** 「…」のメニュー。めったに使わない操作をしまう */
export function Menu({ label, items, note }: { label: string; items: Array<{ label: string; disabled?: boolean; tone?: "danger" }>; note?: string }) {
  return (
    <details className="ui-menu">
      <summary aria-label={label} className="ui-button ui-button--quiet ui-button--md ui-button--icon">
        <Icon name="more" />
      </summary>
      <ul className="ui-menu-list">
        {items.map((item) => (
          <li key={item.label}>
            <button type="button" className={item.tone === "danger" ? "ui-menu-item ui-menu-item--danger" : "ui-menu-item"} disabled={item.disabled === true}>
              {item.label}
            </button>
          </li>
        ))}
        {note && <li className="ui-menu-note">{note}</li>}
      </ul>
    </details>
  );
}

/** アプリの印。地平線の上に、半分だけ出た丸（見通し） */
export function Logo() {
  return (
    <svg className="ui-logo" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M5 13a5 5 0 0110 0" />
      <path d="M2 13h16" />
      <path d="M4 16.5h12" opacity="0.55" />
    </svg>
  );
}
