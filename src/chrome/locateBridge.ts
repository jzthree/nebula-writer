import { googleDocId } from "./documentTab";
import type { DocsLocatePlan } from "./locate";

export interface DocsTabMessage {
  type: "nebula-locate" | "nebula-comment";
  docId: string;
  plan: DocsLocatePlan;
  text?: string;
}

async function sendToDocumentTab(tabId: number, message: DocsTabMessage,
  sendMessage: (tabId: number, message: DocsTabMessage) => Promise<unknown>, failure: string): Promise<void> {
  let reply: unknown;
  try { reply = await sendMessage(tabId, message); }
  catch { throw new Error("Writer cannot reach this tab. Reload the extension, refresh this Google Doc, and reopen Writer."); }
  const result = reply as { ok?: unknown; error?: unknown; url?: unknown } | null;
  if (!result || typeof result.url !== "string" || googleDocId(result.url) !== message.docId) {
    throw new Error("The Google Doc changed while Writer was working in it. Reopen Writer beside the intended document.");
  }
  if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : failure);
}

export function locateInDocumentTab(tabId: number, docId: string, plan: DocsLocatePlan,
  sendMessage: (tabId: number, message: DocsTabMessage) => Promise<unknown>): Promise<void> {
  return sendToDocumentTab(tabId, { type: "nebula-locate", docId, plan }, sendMessage, "Google Docs could not locate this passage.");
}

/** Select the passage, then comment on it through Docs' own comment box. */
export function commentInDocumentTab(tabId: number, docId: string, plan: DocsLocatePlan, text: string,
  sendMessage: (tabId: number, message: DocsTabMessage) => Promise<unknown>): Promise<void> {
  return sendToDocumentTab(tabId, { type: "nebula-comment", docId, plan, text }, sendMessage, "Google Docs could not add this comment.");
}
