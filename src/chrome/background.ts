/// <reference types="chrome" />
/**
 * Service worker for the Chrome extension: the toolbar button opens the side
 * panel, and the panel is offered only on Google Docs document tabs.
 */

import { googleDocId, panelPath } from "./documentTab";
import { readBuildId, reloadIfOutdated } from "./extensionUpdate";

declare const __PANE_ORIGIN__: string;

const UPDATE_ALARM = "nebula-writer-update";

chrome.runtime.onInstalled.addListener((details) => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void configureOpenDocuments();
  scheduleUpdateChecks();
  if (details?.reason === "update") {
    void reconnectOpenDocuments();
  }
});

chrome.runtime.onStartup.addListener(() => {
  void configureOpenDocuments();
  scheduleUpdateChecks();
});

/* Keep the extension current with the sidecar's build (extensionUpdate.ts). */

const LOADED_BUILD_KEY = "loadedBuild";
// Record the build as soon as this copy starts, before any rebuild can change the file.
void loadedBuild().catch(() => undefined);

function scheduleUpdateChecks(): void {
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 0.5 });
}

// A panel holds a port open; the moment it closes is the first chance to
// update, before the author can reopen Writer (a 30 s tick could miss it).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "nebula-panel") {
    // Give Chrome a moment to drop the closed panel from its open contexts.
    port.onDisconnect.addListener(() => { setTimeout(() => { void checkForUpdate(); }, 1_000); });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) {
    void checkForUpdate();
  }
});

/**
 * The build this copy of the extension was loaded from. The extension runs
 * from the repository folder, so dist/build.json on disk is already the NEW
 * build once Writer rebuilds — comparing it with the sidecar's (which reads
 * the same file) never finds a difference. The id is therefore recorded the
 * first time it is read after a load: session storage starts empty on every
 * extension reload and browser start, exactly when the code is reread.
 */
async function loadedBuild(): Promise<string | null> {
  const stored = (await chrome.storage.session.get(LOADED_BUILD_KEY))[LOADED_BUILD_KEY];
  if (typeof stored === "string") {
    return stored;
  }
  const build = readBuildId(await (await fetch(chrome.runtime.getURL("dist/build.json"), { cache: "no-store" })).json());
  if (build) {
    await chrome.storage.session.set({ [LOADED_BUILD_KEY]: build });
  }
  return build;
}

async function checkForUpdate(): Promise<boolean> {
  return reloadIfOutdated({
    ownBuild: loadedBuild,
    servedBuild: async () => readBuildId(await (await fetch(`${__PANE_ORIGIN__}/api/chrome-extension/build`, { cache: "no-store" })).json()),
    panelOpen: async () => (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] })).length > 0,
    reload: () => chrome.runtime.reload()
  });
}

/**
 * After an update the content scripts in already-open Docs tabs belong to
 * the old version and no longer answer; give each tab a fresh one so the
 * document works without a refresh.
 */
async function reconnectOpenDocuments(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: "https://docs.google.com/document/*" });
    await Promise.all(tabs.filter((tab) => tab.id !== undefined).map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ["dist/content.js"] }).catch(() => undefined)));
  } catch {
    // A refresh of the document reconnects it.
  }
}

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
