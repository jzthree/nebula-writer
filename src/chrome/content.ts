/// <reference types="chrome" />
/**
 * Content script on Google Docs pages. The Docs REST API knows nothing about
 * the cursor, so the side panel asks this script for the current selection:
 * from a live DOM selection, or from Docs' export after the user copies a
 * canvas selection. Locate uses Docs' visible Find controls and remembers
 * their verified result. Captured passages clear on the next editor action.
 */

import { createDocsSelectionReader } from "./selection";
import { googleDocId } from "./documentTab";
import { locateDocsPassage } from "./locateUi";
import type { DocsLocatePlan } from "./locate";

const selectionReader = createDocsSelectionReader(document);
let locating = false;
let disposed = false;

chrome.runtime.onMessage.addListener((message: { type?: string; docId?: string; plan?: DocsLocatePlan }, _sender, respond) => {
  if (message?.type === "nebula-selection") {
    respond({ text: selectionReader.read(), url: location.href });
    return true;
  }
  if (message?.type === "nebula-locate") {
    const current = () => !disposed && googleDocId(location.href) === message.docId;
    if (!message.docId || !current() || !message.plan || locating) {
      respond({ ok: false, url: location.href, error: locating ? "Locate is already running. Try again after it finishes." : "The document changed. Reopen Writer beside the intended Google Doc." });
      return true;
    }
    locating = true;
    void locateDocsPassage(document, message.plan, current).then((text) => {
      selectionReader.rememberLocatedText(text);
      respond({ ok: true, url: location.href });
    }).catch((error: unknown) => {
      respond({ ok: false, url: location.href, error: error instanceof Error ? error.message : "Google Docs could not locate the passage." });
    }).finally(() => { locating = false; });
    return true;
  }
  return false;
});

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    disposed = true;
    selectionReader.dispose();
  }
});
