#!/usr/bin/env node
// Build the Chrome extension:
//   chrome-extension/dist/{sidepanel,background,content}.js — bundled from src/chrome
//   chrome-extension/manifest.json — from manifest.template.json plus
//     chrome-extension/local.json ({ key, clientId }, written by chrome:setup)
//
//   node scripts/chrome-build.mjs            (part of `npm run build`)
//   WRITER_TLS_PORT=8443 node scripts/chrome-build.mjs
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "chrome-extension");
const port = process.env.WRITER_TLS_PORT?.trim() || "8443";
const paneOrigin = `https://localhost:${port}`;

mkdirSync(resolve(dir, "dist"), { recursive: true });
const localPath = resolve(dir, "local.json");
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : {};
await build({
  entryPoints: {
    sidepanel: resolve(root, "src/chrome/sidepanel.ts"),
    background: resolve(root, "src/chrome/background.ts"),
    content: resolve(root, "src/chrome/content.ts")
  },
  outdir: resolve(dir, "dist"),
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  define: {
    __PANE_ORIGIN__: JSON.stringify(paneOrigin),
    __PICKER_API_KEY__: JSON.stringify(local.pickerApiKey || ""),
    __PICKER_APP_ID__: JSON.stringify(local.pickerAppId || "")
  },
  legalComments: "none",
  logLevel: "warning"
});

const template = JSON.parse(readFileSync(resolve(dir, "manifest.template.json"), "utf8"));
template.host_permissions = template.host_permissions.map((entry) => entry.replace("__PANE_ORIGIN__", paneOrigin));
template.oauth2.client_id = local.clientId || "CLIENT_ID_NOT_SET.apps.googleusercontent.com";
if (local.key) {
  template.key = local.key;
}
writeFileSync(resolve(dir, "manifest.json"), `${JSON.stringify(template, null, 2)}\n`);
const warnings = [];
if (!local.key) warnings.push("no extension key yet (run npm run chrome:setup)");
if (!local.clientId) warnings.push("no OAuth client id yet (npm run chrome:setup -- --client-id=…)");
// The build id: a hash of everything Chrome loads. The installed extension
// compares its own with the one the sidecar serves and reloads itself when
// they differ (src/chrome/extensionUpdate.ts), so a rebuild reaches Chrome
// without a trip to chrome://extensions.
const PRIVATE = new Set(["key.pem", "local.json", "manifest.template.json", "build.json"]);
const files = [];
const walk = (folder) => {
  for (const name of readdirSync(folder).sort()) {
    const path = resolve(folder, name);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else if (!PRIVATE.has(name) && !name.startsWith(".")) {
      files.push(path);
    }
  }
};
walk(dir);
const hash = createHash("sha256");
for (const file of files) {
  hash.update(file.slice(dir.length)).update("\0").update(readFileSync(file)).update("\0");
}
const buildId = hash.digest("hex").slice(0, 16);
writeFileSync(resolve(dir, "dist", "build.json"), `${JSON.stringify({ build: buildId })}\n`);
console.log(`chrome: wrote chrome-extension/dist/*.js and manifest.json (pane ${paneOrigin}, build ${buildId})${warnings.length ? ` — ${warnings.join("; ")}` : ""}`);
