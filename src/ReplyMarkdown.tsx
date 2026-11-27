import { useMemo, useState, type MouseEvent } from "react";
import { renderReplyMarkdown } from "./replyMarkdownHtml";
import "./replyMarkdown.css";

/** An agent reply's Markdown, rendered; a click on a file link copies its path. */
export function ReplyMarkdown(props: { text: string; className?: string }) {
  const html = useMemo(() => renderReplyMarkdown(props.text), [props.text]);
  const [copied, setCopied] = useState<string | null>(null);
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as HTMLElement).closest?.("a[data-path]");
    if (!link) {
      return;
    }
    event.preventDefault();
    const path = link.getAttribute("data-path") ?? "";
    void navigator.clipboard?.writeText(path).then(() => {
      setCopied(path);
      window.setTimeout(() => setCopied((current) => (current === path ? null : current)), 1800);
    }, () => undefined);
  };
  return (
    <>
      <div className={`reply-md${props.className ? ` ${props.className}` : ""}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {copied ? <p className="reply-md-copied" role="status">Copied {copied}</p> : null}
    </>
  );
}
