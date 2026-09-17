/// <reference types="chrome" />
/**
 * The extension's side panel: embeds the review pane served by the local
 * sidecar and answers its host calls (the same `nebula*` functions the Apps
 * Script add-in exposes) with the Google Docs REST API, authorised through
 * chrome.identity. Only the pane's origin may talk to this page.
 */

import { buildBatchPlan, imageContentUri, parseDocument, type ApiDocument, type ParsedDocument } from "./docsApi";
import { DOCS_SCRIPT_FUNCTIONS, type DocsFocusPayload, type DocsImageBytesPayload, type DocsOpOutcome, type DocsReplaceOp, type DocsScriptFunction } from "../gdocs/protocol";

declare const __PANE_ORIGIN__: string;

const PANE_ORIGIN = __PANE_ORIGIN__;
const DOCS_API = "https://docs.googleapis.com/v1/documents";
const DOC_URL = /^https:\/\/docs\.google\.com\/document\/d\/([^/?#]+)/;

const frame = document.getElementById("pane") as HTMLIFrameElement;
const notice = document.getElementById("notice") as HTMLDivElement;

function showNotice(html: string): void {
  notice.innerHTML = html;
  notice.className = "show";
}

/* ------------------------------------------------------------------------- */
/* Google auth + API                                                         */
/* ------------------------------------------------------------------------- */

async function token(interactive: boolean): Promise<string> {
  const result = await chrome.identity.getAuthToken({ interactive });
  const value = typeof result === "string" ? result : result?.token;
  if (!value) {
    throw new Error("Google did not grant access to the document. Click the Writer button again and approve access.");
  }
  return value;
}

async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const bearer = await token(true);
  const response = await fetch(`${DOCS_API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }
  });
  if (response.status === 401 && retry) {
    await chrome.identity.removeCachedAuthToken({ token: bearer });
    return api<T>(path, init, false);
  }
  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      detail = body.error?.message ?? detail;
    } catch {
      // Keep the status.
    }
    throw new Error(`Google Docs API: ${detail}`);
  }
  return response.json() as Promise<T>;
}

/* ------------------------------------------------------------------------- */
/* The document behind the active tab                                       */
/* ------------------------------------------------------------------------- */

async function activeDoc(): Promise<{ tabId: number; docId: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const match = tab?.url?.match(DOC_URL);
  if (tab?.id === undefined || !match) {
    throw new Error("Open a Google Doc in this window — Writer works on the document in the active tab.");
  }
  return { tabId: tab.id, docId: match[1] };
}

let lastParsed: { docId: string; parsed: ParsedDocument; raw: ApiDocument } | null = null;

async function fetchParsed(docId: string): Promise<ParsedDocument> {
  const raw = await api<ApiDocument>(`/${encodeURIComponent(docId)}`);
  const parsed = parseDocument(raw);
  lastParsed = { docId, parsed, raw };
  return parsed;
}

async function selectionText(tabId: number): Promise<string> {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "nebula-selection" }) as { text?: string } | undefined;
    return (reply?.text ?? "").replace(/\r\n?/g, "\n");
  } catch {
    return "";
  }
}

/** Locate the selected text in the cached document: paragraph coordinates, or null. */
function locateSelection(parsed: ParsedDocument, text: string): DocsFocusPayload["selection"] {
  const needle = text.trim();
  if (!needle) {
    return null;
  }
  const texts = parsed.payload.paragraphs.map((paragraph) => paragraph.text);
  const body = texts.join("\n");
  const at = body.indexOf(needle);
  if (at < 0 || body.indexOf(needle, at + 1) >= 0) {
    return null; // Missing or ambiguous: better no selection than the wrong one.
  }
  const end = at + needle.length;
  let offset = 0;
  let startParagraph = 0;
  let startOffset = 0;
  let endParagraph = 0;
  let endOffset = 0;
  texts.forEach((paragraphText, index) => {
    const paragraphEnd = offset + paragraphText.length;
    if (at >= offset && at <= paragraphEnd) {
      startParagraph = index;
      startOffset = at - offset;
    }
    if (end > offset && end <= paragraphEnd + 1) {
      endParagraph = index;
      endOffset = Math.min(end - offset, paragraphText.length);
    }
    offset = paragraphEnd + 1;
  });
  return { startParagraph, startOffset, endParagraph, endOffset, text: needle };
}

/* ------------------------------------------------------------------------- */
/* Host functions (same names and payloads as the Apps Script add-in)        */
/* ------------------------------------------------------------------------- */

const handlers: Record<DocsScriptFunction, (...args: unknown[]) => Promise<unknown>> = {
  async nebulaReadDocument() {
    const { docId } = await activeDoc();
    return (await fetchParsed(docId)).payload;
  },

  async nebulaFingerprint() {
    const { docId } = await activeDoc();
    const doc = await api<{ revisionId?: string }>(`/${encodeURIComponent(docId)}?fields=revisionId`);
    return doc.revisionId ?? "";
  },

  async nebulaReadFocus() {
    const { tabId, docId } = await activeDoc();
    const parsed = lastParsed?.docId === docId ? lastParsed.parsed : await fetchParsed(docId);
    const selection = locateSelection(parsed, await selectionText(tabId));
    const payload: DocsFocusPayload = {
      paragraphIndex: selection?.startParagraph ?? null,
      paragraphText: selection ? parsed.payload.paragraphs[selection.startParagraph]?.text ?? null : null,
      offset: selection?.startOffset ?? 0,
      selection,
      fingerprint: parsed.index.revisionId
    };
    return payload;
  },

  async nebulaFocusKey() {
    const { tabId, docId } = await activeDoc();
    const text = await selectionText(tabId);
    return `${docId}|${text.length}|${text.slice(0, 80)}`;
  },

  async nebulaSelect() {
    // The Docs API cannot move the reader's cursor; the card's preview shows the match instead.
    return null;
  },

  async nebulaApply(ops) {
    const { docId } = await activeDoc();
    const parsed = await fetchParsed(docId);
    const plan = buildBatchPlan(parsed, ops as DocsReplaceOp[]);
    const outcomes: DocsOpOutcome[] = [...plan.rejected];
    if (plan.requests.length) {
      try {
        await api(`/${encodeURIComponent(docId)}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: plan.requests }) });
        outcomes.push(...plan.accepted.map((id) => ({ id, ok: true })));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcomes.push(...plan.accepted.map((id) => ({ id, ok: false, error: message })));
      }
    } else {
      outcomes.push(...plan.accepted.map((id) => ({ id, ok: true })));
    }
    lastParsed = null;
    return outcomes;
  },

  async nebulaReadImage(index) {
    const { docId } = await activeDoc();
    const parsed = lastParsed?.docId === docId ? lastParsed.parsed : await fetchParsed(docId);
    const raw = lastParsed?.raw as ApiDocument;
    const uri = imageContentUri(raw, parsed.index, Number(index));
    if (!uri) {
      throw new Error(`The document has no inline image ${Number(index) + 1}.`);
    }
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`Could not read the image (${response.status}).`);
    }
    const blob = await response.blob();
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;base64,/, ""));
      reader.onerror = () => reject(new Error("Could not read the image bytes."));
      reader.readAsDataURL(blob);
    });
    const image = parsed.payload.images[Number(index)];
    const payload: DocsImageBytesPayload = { base64, mime: blob.type || "image/png", width: image?.width ?? null, height: image?.height ?? null };
    return payload;
  },

  async nebulaReplaceImage() {
    throw new Error("Replacing images is not available from the Chrome extension: the Docs API needs a public image URL. Use the Google Docs add-in for picture swaps.");
  },

  async nebulaSelectImage() {
    return null;
  }
};

/* ------------------------------------------------------------------------- */
/* Relay to the pane                                                         */
/* ------------------------------------------------------------------------- */

let announced = false;

function announce(): void {
  if (frame.contentWindow) {
    frame.contentWindow.postMessage({ nebula: "host-ready" }, PANE_ORIGIN);
    announced = true;
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== PANE_ORIGIN || !event.data || typeof event.data !== "object") {
    return;
  }
  const data = event.data as { nebula?: string; id?: string; fn?: string; args?: unknown[] };
  if (data.nebula === "pane-ready") {
    announce();
    return;
  }
  if (data.nebula !== "script-call" || typeof data.id !== "string" || !data.fn) {
    return;
  }
  const reply = (payload: Record<string, unknown>) => {
    (event.source as Window | null)?.postMessage({ nebula: "script-result", id: data.id, ...payload }, PANE_ORIGIN);
  };
  const fn = data.fn as DocsScriptFunction;
  if (!(DOCS_SCRIPT_FUNCTIONS as readonly string[]).includes(fn)) {
    reply({ ok: false, error: `Unknown host function ${data.fn}` });
    return;
  }
  handlers[fn](...(Array.isArray(data.args) ? data.args : []))
    .then((result) => reply({ ok: true, result: result === undefined ? null : result }))
    .catch((error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});

frame.addEventListener("load", announce);
frame.src = `${PANE_ORIGIN}/gdocs/pane.html`;
setTimeout(() => {
  if (!announced) {
    showNotice(`<p><strong>Writer is not reachable.</strong></p><p>Start the Nebula Writer sidecar on this computer (it serves the pane at <code>${PANE_ORIGIN}/gdocs/pane.html</code>), then reopen this panel.</p>`);
  }
}, 6000);
