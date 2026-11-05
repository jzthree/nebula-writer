/**
 * The pane keeps itself current. Word (and the Docs sidebar) keeps a task
 * pane open for days, so a rebuilt Writer would otherwise only reach it when
 * the user closes and reopens the pane. The pane compares the entry script
 * its page loaded with the one the sidecar serves now (Vite gives each build
 * a content-hashed name) and reloads when they differ — but only while idle,
 * so an update never interrupts a turn, an apply or a half-typed message. The
 * conversation and its cards are saved, so a reload loses nothing.
 */

const MODULE_SCRIPT = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/i;

export function entryScriptOf(html: string): string | null {
  return html.match(MODULE_SCRIPT)?.[1] ?? null;
}

export function loadedEntryScript(doc: Document = document): string | null {
  return doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? null;
}

export async function servedEntryScript(url: string = window.location.href): Promise<string | null> {
  const response = await fetch(url, { cache: "no-store" });
  return response.ok ? entryScriptOf(await response.text()) : null;
}

export interface PaneUpdateCheck {
  loaded: () => string | null;
  served: () => Promise<string | null>;
  idle: () => boolean;
  reload: () => void;
}

/** Reload when the sidecar serves a different build and the pane is idle; returns whether it reloaded. */
export async function reloadPaneIfOutdated(check: PaneUpdateCheck): Promise<boolean> {
  const loaded = check.loaded();
  if (!loaded) {
    return false;
  }
  const served = await check.served().catch(() => null);
  if (!served || loaded === served || !check.idle()) {
    return false;
  }
  check.reload();
  return true;
}
