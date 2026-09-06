/**
 * Client side of the share-link capability token.
 *
 * A collaborator opens http://host:5173/#share=<token>. The token is captured
 * from the fragment (never sent over the network by the browser), stored for
 * the session, and stripped from the address bar. Every sidecar API request
 * and websocket connection then presents it; the owner's localhost browser is
 * loopback-trusted by the sidecar and works without one.
 */

const STORAGE_KEY = "nebula-writer-share-token";

let cachedToken: string | null | undefined;

export function captureShareTokenFromLocation(): void {
  if (typeof window === "undefined") {
    return;
  }
  const match = /[#&]share=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (!match) {
    return;
  }
  cachedToken = match[1];
  try {
    window.sessionStorage.setItem(STORAGE_KEY, match[1]);
  } catch {
    // Session storage unavailable; the in-memory copy still covers this tab.
  }
  const cleanedHash = window.location.hash.replace(/[#&]share=[A-Za-z0-9_-]+/, "");
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleanedHash === "#" ? "" : cleanedHash}`);
}

export function getStoredShareToken(): string | null {
  if (cachedToken !== undefined) {
    return cachedToken;
  }
  try {
    cachedToken = typeof window === "undefined" ? null : window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

export function shareTokenQuerySuffix(): string {
  const token = getStoredShareToken();
  return token ? `?token=${encodeURIComponent(token)}` : "";
}

/**
 * Document identity in the URL fragment: visiting the root is a private clean
 * slate; #doc=<id> joins that document's shared room. Sharing the URL is
 * sharing the document.
 */
export function parseDocIdFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const match = /[#&]doc=([A-Za-z0-9._-]+)/.exec(window.location.hash);
  return match ? match[1] : null;
}

export function writeDocIdToLocation(docId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const cleaned = window.location.hash.replace(/[#&]doc=[A-Za-z0-9._-]+/, "").replace(/^#$/, "");
  const separator = cleaned && cleaned !== "#" ? "&" : "#";
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleaned}${separator}doc=${docId}`);
}

export function clearDocIdFromLocation(): void {
  if (typeof window === "undefined") {
    return;
  }
  const cleaned = window.location.hash.replace(/[#&]doc=[A-Za-z0-9._-]+/, "").replace(/^#$/, "");
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleaned === "#" ? "" : cleaned}`);
}

export function documentShareUrl(baseUrl: string, docId: string): string {
  return `${baseUrl}${baseUrl.includes("#") ? "&" : "/#"}doc=${docId}`.replace(/\/\/#/, "/#");
}

/**
 * Cloud-synced sharing (local-first): a shared doc carries &sync=cloud so any
 * collaborator's LOCAL Writer knows to bridge its room through the cloud relay.
 */
export function parseCloudSyncFromLocation(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return /[#&]sync=cloud\b/.test(window.location.hash);
}

export function writeCloudSyncToLocation(): void {
  if (typeof window === "undefined" || parseCloudSyncFromLocation()) {
    return;
  }
  const hash = window.location.hash || "#";
  const separator = hash === "#" || hash === "" ? "#" : "&";
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash === "#" ? "" : hash}${separator}sync=cloud`);
}

export function collaboratorShareUrl(docId: string): string {
  // Every collaborator runs their own local Writer on the same port, so one
  // localhost link works for everyone.
  const port = typeof window === "undefined" ? "8787" : window.location.port || "8787";
  return `http://localhost:${port}/#doc=${docId}&sync=cloud`;
}
