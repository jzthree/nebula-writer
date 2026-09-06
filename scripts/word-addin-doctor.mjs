#!/usr/bin/env node
// Nebula Writer — Word add-in doctor.
//
//   npm run word:doctor
//
// Checks everything the Word task pane needs: certificate present and trusted,
// the sidecar's HTTPS listener answering, the task pane and icons served, the
// manifest installed in Word's sideload folder and pointing at the right URL,
// Word itself, and the Office.js CDN. Exit code 1 when something needs fixing.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const home = homedir();
const port = Number.parseInt(process.env.WRITER_TLS_PORT ?? "", 10) || 8443;
const certDir = process.env.WRITER_TLS_DIR || join(home, ".nebula-writer", "certs");
const certPath = process.env.WRITER_TLS_CERT || join(certDir, "localhost.pem");
const keyPath = process.env.WRITER_TLS_KEY || join(certDir, "localhost-key.pem");
const manifestPath = join(home, "Library/Containers/com.microsoft.Word/Data/Documents/wef/nebula-writer-manifest.xml");
const expectedTaskpane = `https://localhost:${port}/word/taskpane.html`;
const repoManifest = resolve(new URL(".", import.meta.url).pathname, "..", "word", "manifest.xml");

const checks = [];
const add = (label, ok, detail, fix) => checks.push({ label, ok, detail, fix });

// Certificate ---------------------------------------------------------------
if (existsSync(certPath) && existsSync(keyPath)) {
  add("Certificate files", true, certPath);
  try {
    await execFileAsync("security", ["verify-cert", "-c", certPath, "-p", "ssl", "-s", "localhost"]);
    add("Certificate trusted for SSL", true, "login keychain trusts https://localhost");
  } catch (error) {
    add("Certificate trusted for SSL", false, firstLine(error), `security add-trusted-cert -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db ${certPath}`);
  }
  try {
    const { stdout } = await execFileAsync("openssl", ["x509", "-in", certPath, "-noout", "-enddate", "-ext", "subjectAltName"]);
    const endDate = /notAfter=(.*)/.exec(stdout)?.[1]?.trim();
    const expires = endDate ? Date.parse(endDate) : NaN;
    const sanOk = /DNS:localhost/.test(stdout);
    add("Certificate valid", Number.isFinite(expires) ? expires > Date.now() && sanOk : sanOk, `expires ${endDate ?? "unknown"}${sanOk ? "" : " — missing SAN localhost"}`, "npm run word:setup");
  } catch {
    // openssl missing: skip.
  }
} else {
  add("Certificate files", false, `${certPath} / ${keyPath}`, "npm run word:setup");
}

// Sidecar HTTPS -------------------------------------------------------------
const health = await fetchJson(`https://localhost:${port}/api/health`);
if (health.ok) {
  const tls = health.body?.tls;
  add("Sidecar HTTPS listener", true, `https://localhost:${port} · providers: ${(health.body?.providers ?? []).join(", ") || "none"}`);
  add("Sidecar reports TLS", Boolean(tls), tls ? `wordAddinUrl ${tls.wordAddinUrl}` : "health has no tls block (old sidecar build?)", "restart the sidecar: launchctl kickstart -k gui/$(id -u)/io.nebula.writer-sidecar");
  add("Sidecar can run a CLI", Boolean(health.body?.cliEnabled), health.body?.cliEnabled ? "cliEnabled" : "WRITER_ALLOW_CLI=0 — AI requests will fail", "unset WRITER_ALLOW_CLI and restart the sidecar");
} else {
  add("Sidecar HTTPS listener", false, `https://localhost:${port}/api/health → ${health.error}`, "start the sidecar (npm run sidecar) after npm run word:setup; check WRITER_TLS_PORT");
  const plain = await fetchJson(`http://127.0.0.1:${Number(process.env.WRITER_SIDECAR_PORT || 8787)}/api/health`);
  add("Sidecar plain HTTP listener", plain.ok, plain.ok ? "running (but no HTTPS — certificate missing when it started?)" : plain.error, "npm run sidecar");
}

// Task pane + icons -------------------------------------------------------
const taskpane = await fetchStatus(expectedTaskpane);
add("Task pane served", taskpane.ok, `${expectedTaskpane} → ${taskpane.detail}`, "npm run build (then restart the sidecar if dist/ was missing when it started)");
const icon = await fetchStatus(`https://localhost:${port}/word/icon-32.png`);
add("Ribbon icons served", icon.ok, `/word/icon-32.png → ${icon.detail}`, "npm run word:icons && npm run build");

// Manifest ----------------------------------------------------------------
if (existsSync(manifestPath)) {
  const manifest = readFileSync(manifestPath, "utf8");
  const source = /<SourceLocation DefaultValue="([^"]+)"/.exec(manifest)?.[1];
  const id = /<Id>([^<]+)<\/Id>/.exec(manifest)?.[1];
  const repoId = existsSync(repoManifest) ? /<Id>([^<]+)<\/Id>/.exec(readFileSync(repoManifest, "utf8"))?.[1] : null;
  add("Manifest installed", true, `${manifestPath} (${statSync(manifestPath).size} bytes)`);
  add("Manifest points at this sidecar", source === expectedTaskpane, `SourceLocation ${source ?? "missing"}`, "npm run word:setup --no-build");
  add("Manifest id matches repo", !repoId || id === repoId, `id ${id ?? "missing"}`, "npm run word:setup --no-build");
  add("Manifest has ribbon button", /VersionOverrides/.test(manifest), /VersionOverrides/.test(manifest) ? "Home › Nebula Writer" : "no VersionOverrides — open via Home › Add-ins", "npm run word:setup --no-build");
} else {
  add("Manifest installed", false, manifestPath, "npm run word:setup");
}

// Word + Office.js ----------------------------------------------------------
try {
  const { stdout } = await execFileAsync("defaults", ["read", "/Applications/Microsoft Word.app/Contents/Info.plist", "CFBundleShortVersionString"]);
  const version = stdout.trim();
  const [major, minor] = version.split(".").map(Number);
  const modern = major > 16 || (major === 16 && minor >= 89);
  add("Microsoft Word installed", true, `Word ${version}${modern ? " (WordApiDesktop 1.2 viewport API expected)" : " — older than 16.89: viewport awareness may be unavailable"}`);
} catch {
  add("Microsoft Word installed", false, "/Applications/Microsoft Word.app not found", "install Microsoft 365 Word");
}
try {
  await execFileAsync("pgrep", ["-x", "Microsoft Word"]);
  add("Word running", true, "running — quit and reopen Word after installing the manifest so it picks it up");
} catch {
  add("Word running", true, "not running (fine)");
}
const officeJs = await fetchStatus("https://appsforoffice.microsoft.com/lib/1/hosted/office.js", true);
add("Office.js CDN reachable", officeJs.ok, officeJs.detail, "check your network; the task pane needs appsforoffice.microsoft.com");

// Report --------------------------------------------------------------------
let failed = 0;
for (const check of checks) {
  if (!check.ok) {
    failed += 1;
  }
  console.log(`${check.ok ? "✓" : "✗"} ${check.label}: ${check.detail}`);
  if (!check.ok && check.fix) {
    console.log(`    fix: ${check.fix}`);
  }
}
console.log("");
if (failed) {
  console.log(`${failed} check${failed === 1 ? "" : "s"} need attention.`);
  process.exitCode = 1;
} else {
  console.log("All checks passed. In Word: Home › Nebula Writer opens the pane.");
}

/* ------------------------------------------------------------------------ */

function firstLine(error) {
  const text = error instanceof Error ? (error.stderr || error.message) : String(error);
  return String(text).trim().split("\n")[0];
}

function agentFor(url) {
  // Trust our own certificate explicitly (rather than disabling verification)
  // so the doctor tells the truth about what Word's webview will see.
  if (url.startsWith("https://localhost") && existsSync(certPath)) {
    return new https.Agent({ ca: readFileSync(certPath) });
  }
  return undefined;
}

function fetchJson(url) {
  return new Promise((resolveResult) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { agent: agentFor(url) }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 400) {
          resolveResult({ ok: false, error: `HTTP ${response.statusCode}` });
          return;
        }
        try {
          resolveResult({ ok: true, body: JSON.parse(data) });
        } catch {
          resolveResult({ ok: false, error: "not JSON" });
        }
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolveResult({ ok: false, error: describeNetworkError(error) }));
  });
}

function fetchStatus(url, headOnly = false) {
  return new Promise((resolveResult) => {
    const req = https.request(url, { method: headOnly ? "HEAD" : "GET", agent: agentFor(url) }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      resolveResult({ ok: status >= 200 && status < 400, detail: `HTTP ${status}` });
    });
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolveResult({ ok: false, detail: describeNetworkError(error) }));
    req.end();
  });
}

function describeNetworkError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ECONNREFUSED") {
    return "connection refused (listener not running)";
  }
  if (/CERT|certificate|self signed|self-signed/i.test(String(error?.message ?? ""))) {
    return `certificate rejected: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
