/// <reference types="chrome" />
/**
 * Content script on Google Docs pages. The Docs REST API knows nothing about
 * the cursor, so the side panel asks this script for the current selection:
 * best effort, from the page's DOM selection or from the hidden text-event
 * frame Docs keeps the selected text in for copying. Empty when nothing is
 * selected or the editor hides it.
 */

function readSelection(): string {
  const domSelection = document.getSelection()?.toString() ?? "";
  if (domSelection.trim()) {
    return domSelection;
  }
  const frame = document.querySelector<HTMLIFrameElement>(".docs-texteventtarget-iframe");
  try {
    const body = frame?.contentDocument?.body;
    const text = body ? body.innerText || body.textContent || "" : "";
    return text;
  } catch {
    return "";
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, respond) => {
  if (message?.type === "nebula-selection") {
    respond({ text: readSelection(), url: location.href });
    return true;
  }
  return false;
});
