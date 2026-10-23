/// <reference types="chrome" />
/**
 * Content script on Google Docs pages. The Docs REST API knows nothing about
 * the cursor, so the side panel asks this script for the current selection:
 * from a live DOM selection, or from Docs' export after the user copies a
 * canvas selection. Copied passages are cleared on the next editor action.
 * It also carries out Locate, which only the page can do (see locate.ts).
 */

import { locateInPage, type LocateRequest } from "./locate";
import { createDocsSelectionReader } from "./selection";

const selectionReader = createDocsSelectionReader(document);

chrome.runtime.onMessage.addListener((message: { type?: string; request?: LocateRequest }, _sender, respond) => {
  if (message?.type === "nebula-selection") {
    respond({ text: selectionReader.read(), url: location.href });
    return true;
  }
  if (message?.type === "nebula-locate" && message.request) {
    locateInPage(document, message.request).then(
      (result) => respond({ ...result, url: location.href }),
      (error: unknown) => respond({ error: error instanceof Error ? error.message : String(error), url: location.href })
    );
    return true;
  }
  return false;
});

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    selectionReader.dispose();
  }
});
