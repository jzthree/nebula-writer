/// <reference types="chrome" />
/**
 * Content script on Google Docs pages. The Docs REST API knows nothing about
 * the cursor, so the side panel asks this script for the current selection:
 * from a live DOM selection, or from Docs' export after the user copies a
 * canvas selection. Copied passages are cleared on the next editor action.
 */

import { createDocsSelectionReader } from "./selection";

const selectionReader = createDocsSelectionReader(document);

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, respond) => {
  if (message?.type === "nebula-selection") {
    respond({ text: selectionReader.read(), url: location.href });
    return true;
  }
  return false;
});

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    selectionReader.dispose();
  }
});
