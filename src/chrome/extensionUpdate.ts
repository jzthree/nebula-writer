/**
 * The extension keeps itself current. It is loaded unpacked from the Writer
 * repository, and Chrome only picks up a rebuild when someone presses reload
 * on chrome://extensions; instead, the service worker compares the build id
 * it was loaded with (recorded from dist/build.json at load, see background.ts)
 * with the one the sidecar serves, and reloads itself when they differ — but never while a
 * Writer panel is open, so an update never closes the panel in use.
 */

export interface UpdateCheck {
  ownBuild: () => Promise<string | null>;
  servedBuild: () => Promise<string | null>;
  panelOpen: () => Promise<boolean>;
  reload: () => void;
}

/** Reload when the sidecar serves a different build and no panel is open; returns whether it reloaded. */
export async function reloadIfOutdated(check: UpdateCheck): Promise<boolean> {
  const [own, served] = await Promise.all([check.ownBuild().catch(() => null), check.servedBuild().catch(() => null)]);
  if (!own || !served || own === served) {
    return false;
  }
  if (await check.panelOpen().catch(() => true)) {
    return false;
  }
  check.reload();
  return true;
}

export function readBuildId(value: unknown): string | null {
  const build = value && typeof value === "object" && "build" in value ? (value as { build: unknown }).build : null;
  return typeof build === "string" && /^[0-9a-f]{8,64}$/.test(build) ? build : null;
}

/**
 * While a panel stays open the extension cannot reload (that would close the
 * panel), but its page scripts can be replaced one by one: Chrome reads an
 * unpacked extension's files afresh for each page load and injection. The
 * build records each script's code id; the panel reloads its own page when
 * its code is stale (between turns, see the pane), and injects the current
 * content script into a Docs tab whose running copy is stale. A newer copy
 * in a tab takes over from older ones (content.ts).
 */
export interface CodeIds {
  sidepanel: string;
  content: string;
}

export function readCodeIds(value: unknown): CodeIds | null {
  if (!value || typeof value !== "object") return null;
  const { sidepanel, content } = value as Partial<Record<keyof CodeIds, unknown>>;
  const valid = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8,64}$/.test(id);
  return valid(sidepanel) && valid(content) ? { sidepanel, content } : null;
}

export interface ContentSync {
  /** Code ids of the build on disk now, or null when unreadable. */
  disk: () => Promise<CodeIds | null>;
  /** The code id of the copy answering in the tab, or null when none answers. */
  running: (tabId: number) => Promise<string | null>;
  inject: (tabId: number) => Promise<void>;
}

/** Make sure the tab runs the content script on disk; returns the code id now answering. */
export async function ensureCurrentContent(tabId: number, sync: ContentSync): Promise<string | null> {
  const [disk, running] = await Promise.all([sync.disk().catch(() => null), sync.running(tabId).catch(() => null)]);
  if (running && (!disk || running === disk.content)) return running;
  await sync.inject(tabId);
  return sync.running(tabId).catch(() => null);
}
