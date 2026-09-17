/// <reference types="chrome" />
/**
 * Service worker for the Chrome extension: the toolbar button opens the side
 * panel, and the panel is offered only on Google Docs document tabs.
 */

const DOC_URL = /^https:\/\/docs\.google\.com\/document\//;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

async function updatePanel(tabId: number, url: string | undefined): Promise<void> {
  if (!url) {
    return;
  }
  try {
    await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: DOC_URL.test(url) });
  } catch {
    // The tab may be gone.
  }
}

chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
  void updatePanel(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updatePanel(tabId, tab.url);
  } catch {
    // Ignore.
  }
});
