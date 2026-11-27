/**
 * Markdown in agent replies, rendered as the agent meant it: bold, italics,
 * code, lists, tables, quotes and links, instead of raw asterisks and pipes.
 *
 * Safe by construction: raw HTML in a reply is shown as text (markdown-it
 * with html off), only http(s), mailto and file links are kept, and images
 * are not loaded (an agent's image link would fetch from wherever it
 * points). A file link cannot open from the pane's web page, so it keeps its
 * path in data-path for the host to copy. Single newlines stay line breaks,
 * as in the plain-text replies before.
 */

import MarkdownIt from "markdown-it";

const SAFE_LINK = /^(https?:|mailto:|file:)/i;

function filePath(href: string): string {
  try {
    return decodeURIComponent(new URL(href).pathname);
  } catch {
    return href.replace(/^file:\/\//i, "");
  }
}

function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
  md.disable(["image"]);
  md.validateLink = (url) => SAFE_LINK.test(url.trim());
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const href = token.attrGet("href") ?? "";
    if (/^file:/i.test(href)) {
      const path = filePath(href);
      token.attrs = [["href", "#"], ["data-path", path], ["title", `${path}\nClick to copy the path`], ["class", "md-file-link"]];
    } else {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
      token.attrSet("title", href);
    }
    return defaultLinkOpen(tokens, index, options, env, self);
  };
  // Wide tables scroll inside the narrow pane instead of widening it.
  md.renderer.rules.table_open = () => '<div class="md-table"><table>\n';
  md.renderer.rules.table_close = () => "</table></div>\n";
  return md;
}

let renderer: MarkdownIt | null = null;

/** The reply's Markdown as HTML that is safe to insert. */
export function renderReplyMarkdown(text: string): string {
  renderer ??= createRenderer();
  return renderer.render(text);
}
