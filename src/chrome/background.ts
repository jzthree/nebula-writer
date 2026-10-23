/// <reference types="chrome" />
/**
 * Service worker for the Chrome extension: the toolbar button opens the side
 * panel, and the panel is offered only on Google Docs document tabs.
 */

import { googleDocId, panelPath } from "./documentTab";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void configureOpenDocuments();
});

chrome.runtime.onStartup.addListener(() => {
  void configureOpenDocuments();
});

async function updatePanel(tabId: number, url: string | undefined): Promise<void> {
  if (!url) {
    return;
  }
  try {
    const enabled = googleDocId(url) !== null;
    await chrome.sidePanel.setOptions({ tabId, ...(enabled ? { path: panelPath(tabId) } : {}), enabled });
  } catch {
    // The tab may be gone.
  }
}

async function configureOpenDocuments(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: "https://docs.google.com/document/*" });
    await Promise.all(tabs.filter((tab) => tab.id !== undefined).map((tab) => updatePanel(tab.id!, tab.url)));
  } catch {
    // Tab activation/update will configure any document that was not ready yet.
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
