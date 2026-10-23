import { googleDocId } from "./documentTab";

const RECONNECT = "Writer cannot capture selections in this tab. Refresh this Google Doc, then close and reopen Writer from Chrome's toolbar. Highlight the passage and press Cmd+C (Ctrl+C on Windows).";

export async function readDocumentSelection(
  tabId: number,
  docId: string,
  sendMessage: (tabId: number, message: { type: string }) => Promise<unknown>
): Promise<string> {
  let reply: unknown;
  try {
    reply = await sendMessage(tabId, { type: "nebula-selection" });
  } catch {
    throw new Error(RECONNECT);
  }
  if (!reply || typeof reply !== "object" || !("text" in reply) || typeof reply.text !== "string"
    || !("url" in reply) || typeof reply.url !== "string") {
    throw new Error(RECONNECT);
  }
  if (googleDocId(reply.url) !== docId) {
    throw new Error("The Google Doc changed while Writer was reading the selection. Reopen Writer beside the document you want to edit.");
  }
  return reply.text.replace(/\r\n?/g, "\n");
}
