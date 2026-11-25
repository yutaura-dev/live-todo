import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * AI の回答（PR の本文などの影響を受ける、信頼できない文字列）を Markdown として表示する。
 * react-markdown は文字列中の HTML を要素にせず、javascript: などの URL も外す。
 * 画像は読み込まない: 外部の画像を読むと、開いたことが相手に伝わるため。
 * リンクは画面を移動させず、main の openExternal（github.com だけを許す）で開く。
 */
export function Markdown(props: { text: string; onOpenLink: (url: string) => void }) {
  const components: Components = {
    img: ({ alt }) => <span className="markdown-image">{alt ? `[画像: ${alt}]` : "[画像]"}</span>,
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          if (href) props.onOpenLink(href);
        }}
      >
        {children}
      </a>
    ),
  };
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {props.text}
      </ReactMarkdown>
    </div>
  );
}
