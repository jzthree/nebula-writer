/// <reference types="chrome" />
/**
 * Content script on Google Docs pages. The Docs REST API knows nothing about
 * the cursor, so the side panel asks this script for the current selection:
 * from a live DOM selection, or from Docs' export after the user copies a
 * canvas selection. Locate uses Docs' visible Find controls and remembers
 * their verified result; a comment is left on that passage with Insert > Comment. Captured passages clear on the next editor action.
 */

import { createDocsSelectionReader } from "./selection";
import { googleDocId } from "./documentTab";
import { locateDocsPassage } from "./locateUi";
import { commentOnSelection } from "./commentUi";
import type { DocsLocatePlan } from "./locate";
import { accountEmailFromLabels } from "./docsAccess";

const selectionReader = createDocsSelectionReader(document);
let locating = false;
let disposed = false;

chrome.runtime.onMessage.addListener((message: { type?: string; docId?: string; plan?: DocsLocatePlan; text?: string }, _sender, respond) => {
  if (message?.type === "nebula-selection") {
    respond({ text: selectionReader.read(), url: location.href });
    return true;
  }
  if (message?.type === "nebula-account") {
    const labels = Array.from(document.querySelectorAll("[aria-label]"), (element) => element.getAttribute("aria-label"));
    respond({ email: accountEmailFromLabels(labels) });
    return true;
  }
  if (message?.type === "nebula-locate" || message?.type === "nebula-comment") {
    const commenting = message.type === "nebula-comment";
    const current = () => !disposed && googleDocId(location.href) === message.docId;
    if (!message.docId || !current() || !message.plan || locating || (commenting && typeof message.text !== "string")) {
      respond({ ok: false, url: location.href, error: locating ? "Writer is already working in this document. Try again after it finishes." : "The document changed. Reopen Writer beside the intended Google Doc." });
      return true;
    }
    locating = true;
    void locateDocsPassage(document, message.plan, current).then(async (text) => {
      selectionReader.rememberLocatedText(text);
      if (commenting) await commentOnSelection(document, message.text!, current);
      respond({ ok: true, url: location.href });
    }).catch((error: unknown) => {
      respond({ ok: false, url: location.href, error: error instanceof Error ? error.message : commenting ? "Google Docs could not add the comment." : "Google Docs could not locate the passage." });
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
