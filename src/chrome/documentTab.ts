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

/**
 * The tab a panel serves: the one named in its URL, or — for a panel Chrome
 * opened without one (opened before the tab was configured, or still open
 * across an extension reload) — the Google Doc showing in the panel's own
 * window. Null when that window is not showing a Google Doc.
 */
export async function bindPanelTab(
  panelUrl: string,
  activeTabInPanelWindow: () => Promise<DocumentTab | undefined>
): Promise<number | null> {
  const named = panelTabId(panelUrl);
  if (named !== null) {
    return named;
  }
  try {
    const tab = await activeTabInPanelWindow();
    return tab?.id !== undefined && googleDocId(tab.url) ? tab.id : null;
  } catch {
    return null;
  }
}
