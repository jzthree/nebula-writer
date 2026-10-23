import { googleDocId } from "./documentTab";
import type { DocsLocatePlan } from "./locate";

export async function locateInDocumentTab(tabId: number, docId: string, plan: DocsLocatePlan,
  sendMessage: (tabId: number, message: { type: string; docId: string; plan: DocsLocatePlan }) => Promise<unknown>): Promise<void> {
  let reply: unknown;
  try { reply = await sendMessage(tabId, { type: "nebula-locate", docId, plan }); }
  catch { throw new Error("Writer cannot reach this tab. Reload the extension, refresh this Google Doc, and reopen Writer before using Locate."); }
  const result = reply as { ok?: unknown; error?: unknown; url?: unknown } | null;
  if (!result || typeof result.url !== "string" || googleDocId(result.url) !== docId) {
    throw new Error("The Google Doc changed while locating the passage. Reopen Writer beside the intended document.");
  }
  if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "Google Docs could not locate this passage.");
}
