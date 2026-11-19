/**
 * Saving a picture from a suggestion card, so the author can edit it
 * directly. The server sends it as a named download (?download=). In Word's
 * add-in panel a link cannot download anything, so there it opens in the
 * default browser, which downloads it.
 */

import { Download } from "lucide-react";
import type { AiSuggestion } from "./shared";

export function imageDownloadUrl(url: string, name: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}download=${encodeURIComponent(name)}`;
}

/** "writer-S3-proposed": the suggestion's reference (or title) and which picture it is. */
export function imageFileName(suggestion: Pick<AiSuggestion, "ref" | "title" | "id">, which: "proposed" | "current" | "figure"): string {
  const label = (suggestion.ref || suggestion.title || suggestion.id).replace(/[^\w-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "picture";
  return `writer-${label}-${which}`;
}

interface OfficeUi { context?: { ui?: { openBrowserWindow?: (url: string) => void }; requirements?: { isSetSupported?: (name: string, version?: string) => boolean } } }

function officeBrowserWindow(): ((url: string) => void) | null {
  const office = (globalThis as { Office?: OfficeUi }).Office;
  const ui = office?.context?.ui;
  if (!ui?.openBrowserWindow || office?.context?.requirements?.isSetSupported?.("OpenBrowserWindowApi", "1.1") === false) {
    return null;
  }
  return (url) => ui.openBrowserWindow!(url);
}

export function downloadImage(url: string, name: string): void {
  const href = new URL(imageDownloadUrl(url, name), window.location.href).toString();
  const openInBrowser = officeBrowserWindow();
  if (openInBrowser) {
    openInBrowser(href);
    return;
  }
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/** A picture in a suggestion card, with a button to save it. */
export function DownloadableImage(props: { url: string; alt: string; name: string; className?: string }) {
  return (
    <span className={`downloadable-image${props.className ? ` ${props.className}` : ""}`}>
      <img src={props.url} alt={props.alt} />
      <button
        type="button"
        className="image-download"
        onClick={(event) => {
          event.stopPropagation();
          downloadImage(props.url, props.name);
        }}
        title={`Save ${props.alt.toLowerCase()} to edit it`}
        aria-label={`Download ${props.alt.toLowerCase()}`}
      >
        <Download size={12} aria-hidden="true" /> Download
      </button>
    </span>
  );
}
