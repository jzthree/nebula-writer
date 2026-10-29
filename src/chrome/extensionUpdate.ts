/**
 * The extension keeps itself current. It is loaded unpacked from the Writer
 * repository, and Chrome only picks up a rebuild when someone presses reload
 * on chrome://extensions; instead, the service worker compares its own build
 * id (dist/build.json, written by scripts/chrome-build.mjs) with the one the
 * sidecar serves, and reloads itself when they differ — but never while a
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
