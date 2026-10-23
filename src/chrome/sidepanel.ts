/// <reference types="chrome" />
/**
 * The extension's side panel: embeds the review pane served by the local
 * sidecar and answers its host calls (the same `nebula*` functions the Apps
 * Script add-in exposes) with the Google Docs REST API, authorised through
 * chrome.identity. Only the pane's origin may talk to this page.
 */

import { buildBatchPlan, imageContentUri, parseDocument, type ApiDocument, type ParsedDocument } from "./docsApi";
import { panelTabId, resolveDocumentTab } from "./documentTab";
import { locateDocsSelection } from "./selectionMatch";
import { readDocumentSelection } from "./selectionBridge";
import { DRIVE_API_ORIGIN, DRIVE_FILE_SCOPE, readDriveComments, unavailableComments, type DriveCommentsPage, type DriveCommentsResult } from "./driveComments";
import { openCommentPicker } from "./commentPicker";
import { planDocsLocate } from "./locate";
import { locateInDocumentTab } from "./locateBridge";
import { DOCS_SCRIPT_FUNCTIONS, type DocsFocusPayload, type DocsImageBytesPayload, type DocsLocateRequest, type DocsOpOutcome, type DocsReplaceOp, type DocsScriptFunction } from "../gdocs/protocol";

declare const __PANE_ORIGIN__: string;
declare const __PICKER_API_KEY__: string;
declare const __PICKER_APP_ID__: string;

const PANE_ORIGIN = __PANE_ORIGIN__;
const DOCS_API = "https://docs.googleapis.com/v1/documents";
const documentTabId = panelTabId(location.href);

const frame = document.getElementById("pane") as HTMLIFrameElement;
const notice = document.getElementById("notice") as HTMLDivElement;
const commentsStatus = document.getElementById("comments-status") as HTMLSpanElement;
const commentsConnect = document.getElementById("comments-connect") as HTMLButtonElement;
let commentsVersion = 0;
let commentsReady = false;
let connectingComments = false;

function fingerprint(revision: string): string {
  return `${revision}|comments:${commentsVersion}`;
}

function displayComments(result: DriveCommentsResult): void {
  commentsReady = result.commentsStatus.state !== "unavailable";
  const count = result.comments.length;
  commentsStatus.textContent = commentsReady
    ? `${count} comment thread${count === 1 ? "" : "s"}${result.commentsStatus.state === "partial" ? " (partial)" : ""}`
    : "Comments unavailable";
  commentsStatus.title = result.commentsStatus.detail;
  commentsConnect.textContent = commentsReady ? "Refresh comments" : "Connect comments";
  commentsConnect.disabled = connectingComments || !lastParsed;
}

async function commentsToken(interactive: boolean): Promise<string> {
  const result = await chrome.identity.getAuthToken({ interactive, scopes: [DRIVE_FILE_SCOPE], enableGranularPermissions: true });
  if (!result.token || (result.grantedScopes && !result.grantedScopes.includes(DRIVE_FILE_SCOPE))) {
    throw new Error("Per-document Google Drive access was not granted.");
  }
  return result.token;
}

async function readComments(docId: string, text: string): Promise<DriveCommentsResult> {
  let permitted = false;
  try { permitted = await chrome.permissions.contains({ origins: [DRIVE_API_ORIGIN] }); } catch { /* Unavailable optional permission. */ }
  if (!permitted) {
    return unavailableComments("Connect comments to authorize access to this Google Doc's reviewer threads.");
  }
  let bearer: string;
  try { bearer = await commentsToken(false); }
  catch { return unavailableComments("Per-document comment access is not connected. Choose Connect comments and select this Google Doc."); }
  return readDriveComments(docId, text, async (path) => {
    const request = () => fetch(`https://www.googleapis.com/drive/v3${path}`, {
      headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(15_000)
    });
    let response = await request();
    if (response.status === 401) {
      await chrome.identity.removeCachedAuthToken({ token: bearer });
      bearer = await commentsToken(false);
      response = await request();
    }
    if (!response.ok) throw new Error(`Google Drive comment read failed (${response.status}).`);
    return response.json() as Promise<DriveCommentsPage>;
  });
}

commentsConnect.addEventListener("click", () => {
  const current = lastParsed;
  if (!current || connectingComments) return;
  connectingComments = true;
  commentsConnect.disabled = true;
  const connect = commentsReady
    ? Promise.resolve()
    : (() => {
      // Both popup creation and optional permission requests start directly
      // from this click. No auth prompts are triggered by background reads.
      if (!__PICKER_API_KEY__ || !__PICKER_APP_ID__) return Promise.reject(new Error("Google Picker needs setup: enable the Drive and Picker APIs, then configure --picker-api-key and --picker-app-id with chrome:setup."));
      const permission = chrome.permissions.request({ origins: [DRIVE_API_ORIGIN] }).catch(() => false);
      return openCommentPicker({
        paneOrigin: PANE_ORIGIN, extensionOrigin: location.origin,
        apiKey: __PICKER_API_KEY__, appId: __PICKER_APP_ID__,
        docId: current.docId, documentName: current.parsed.payload.documentName
      }, async () => {
        if (!await permission) throw new Error("Google Drive API access was not approved.");
        if ((await activeDoc()).docId !== current.docId) throw new Error("The document changed.");
        return commentsToken(true);
      });
    })();
  void connect.then(async () => {
    if ((await activeDoc()).docId !== current.docId) throw new Error("The document changed. Reconnect beside the intended Google Doc.");
    const result = await readComments(current.docId, current.parsed.payload.paragraphs.map((paragraph) => paragraph.text).join("\n"));
    displayComments(result);
    commentsVersion += 1;
  }).catch((error: unknown) => {
    displayComments(unavailableComments(error instanceof Error ? error.message : "Comment connection failed."));
    commentsStatus.textContent = commentsStatus.title;
  }).finally(() => {
    connectingComments = false;
    commentsConnect.disabled = !lastParsed;
  });
});

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
/* The document this panel was opened beside                                */
/* ------------------------------------------------------------------------- */

async function activeDoc(): Promise<{ tabId: number; docId: string }> {
  return resolveDocumentTab(documentTabId, (tabId) => chrome.tabs.get(tabId));
}

let lastParsed: { docId: string; parsed: ParsedDocument; raw: ApiDocument } | null = null;

async function fetchParsed(docId: string): Promise<ParsedDocument> {
  const raw = await api<ApiDocument>(`/${encodeURIComponent(docId)}`);
  const parsed = parseDocument(raw);
  lastParsed = { docId, parsed, raw };
  return parsed;
}

let selectionNotice = false;

async function selectionText(tabId: number, docId: string): Promise<string> {
  try {
    const text = await readDocumentSelection(tabId, docId, (id, message) => chrome.tabs.sendMessage(id, message));
    if (selectionNotice) {
      notice.textContent = "";
      notice.className = "";
      selectionNotice = false;
    }
    return text;
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : "Could not capture the Google Docs selection. Refresh the document and reopen Writer.";
    notice.className = "show";
    selectionNotice = true;
    return "";
  }
}

/* ------------------------------------------------------------------------- */
/* Host functions (same names and payloads as the Apps Script add-in)        */
/* ------------------------------------------------------------------------- */

const handlers: Record<DocsScriptFunction, (...args: unknown[]) => Promise<unknown>> = {
  async nebulaReadDocument() {
    const { docId } = await activeDoc();
    const parsed = await fetchParsed(docId);
    const result = await readComments(docId, parsed.payload.paragraphs.map((paragraph) => paragraph.text).join("\n"));
    displayComments(result);
    return { ...parsed.payload, ...result, fingerprint: fingerprint(parsed.payload.fingerprint) };
  },

  async nebulaFingerprint() {
    const { docId } = await activeDoc();
    const doc = await api<{ revisionId?: string }>(`/${encodeURIComponent(docId)}?fields=revisionId`);
    return fingerprint(doc.revisionId ?? "");
  },

  async nebulaReadFocus() {
    const { tabId, docId } = await activeDoc();
    const parsed = lastParsed?.docId === docId ? lastParsed.parsed : await fetchParsed(docId);
    const selection = locateDocsSelection(parsed.payload.paragraphs, await selectionText(tabId, docId));
    const payload: DocsFocusPayload = {
      paragraphIndex: selection?.startParagraph ?? null,
      paragraphText: selection ? parsed.payload.paragraphs[selection.startParagraph]?.text ?? null : null,
      offset: selection?.startOffset ?? 0,
      selection,
      fingerprint: fingerprint(parsed.index.revisionId)
    };
    return payload;
  },

  async nebulaFocusKey() {
    const { tabId, docId } = await activeDoc();
    const text = await selectionText(tabId, docId);
    return `${docId}|${text.length}|${text.slice(0, 80)}`;
  },

  async nebulaSelect(range) {
    const { tabId, docId } = await activeDoc();
    const parsed = await fetchParsed(docId);
    const plan = planDocsLocate(parsed.payload.paragraphs, range as DocsLocateRequest);
    await locateInDocumentTab(tabId, docId, plan, (id, message) => chrome.tabs.sendMessage(id, message));
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
    throw new Error("Chrome's Google Docs integration cannot select an image directly. Locate a nearby caption or text passage instead.");
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
