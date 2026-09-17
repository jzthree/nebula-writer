#!/usr/bin/env node
// Build the Chrome extension:
//   chrome-extension/dist/{sidepanel,background,content}.js — bundled from src/chrome
//   chrome-extension/manifest.json — from manifest.template.json plus
//     chrome-extension/local.json ({ key, clientId }, written by chrome:setup)
//
//   node scripts/chrome-build.mjs            (part of `npm run build`)
//   WRITER_TLS_PORT=8443 node scripts/chrome-build.mjs
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "chrome-extension");
const port = process.env.WRITER_TLS_PORT?.trim() || "8443";
const paneOrigin = `https://localhost:${port}`;

mkdirSync(resolve(dir, "dist"), { recursive: true });
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
  define: { __PANE_ORIGIN__: JSON.stringify(paneOrigin) },
  legalComments: "none",
  logLevel: "warning"
});

const localPath = resolve(dir, "local.json");
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : {};
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
console.log(`chrome: wrote chrome-extension/dist/*.js and manifest.json (pane ${paneOrigin})${warnings.length ? ` — ${warnings.join("; ")}` : ""}`);
