export function googleDocId(rawUrl: string | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    if (url.origin !== "https://docs.google.com") {
      return null;
    }
    return /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function panelPath(tabId: number): string {
  return `sidepanel.html?tabId=${tabId}`;
}

export function panelTabId(panelUrl: string): number | null {
  const value = new URL(panelUrl).searchParams.get("tabId");
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

interface DocumentTab {
  id?: number;
  url?: string;
  active?: boolean;
}

export async function resolveDocumentTab(
  tabId: number | null,
  getTab: (id: number) => Promise<DocumentTab>
): Promise<{ tabId: number; docId: string }> {
  if (tabId === null) {
    throw new Error("Close Writer, select your Google Doc tab, then reopen Writer from Chrome's toolbar.");
  }
  let tab: DocumentTab;
  try {
    tab = await getTab(tabId);
  } catch {
    throw new Error("This Google Doc tab was closed. Open the document and reopen Writer from Chrome's toolbar.");
  }
  const docId = googleDocId(tab.url);
  if (tab.id !== tabId || !docId) {
    throw new Error("Writer is attached to a tab that is not a Google Doc. Open the document in that tab, or reopen Writer beside your Google Doc.");
  }
  if (tab.active === false) {
    throw new Error("Select this Google Doc tab to reconnect Writer.");
  }
  return { tabId, docId };
}
