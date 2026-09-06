#!/usr/bin/env node
// create-nebula-writer — get Nebula Writer running locally in one command.
//
//   npm create nebula-writer@latest      (or: npx create-nebula-writer)
//
// Clones the app (or updates an existing clone) and runs its idempotent
// `npm run setup`, which installs, builds, starts the local server as a login
// service, and opens http://localhost:8787. Node 20+ (bundled with Claude
// Code / Codex) is the only prerequisite.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = process.env.NEBULA_WRITER_REPO || "https://github.com/jzthree/nebula-writer.git";
// First positional arg overrides the target dir (e.g. `npm create nebula-writer ./writer`).
const argDir = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
const DIR = argDir || process.env.NEBULA_WRITER_DIR || join(homedir(), "Code", "nebula-writer");

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: "inherit", ...opts });
}
function die(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  die(`Node ${major}.x is too old — Nebula Writer needs Node 20+ (nodejs.org).`);
}
if (run("git", ["--version"], { stdio: "ignore" }).status !== 0) {
  die("git is required to fetch Nebula Writer. Install git and re-run.");
}

if (existsSync(join(DIR, ".git"))) {
  console.log(`› Updating existing Nebula Writer at ${DIR}…`);
  run("git", ["-C", DIR, "pull", "--ff-only"]); // best effort; setup still runs
} else {
  console.log(`› Cloning Nebula Writer into ${DIR}…`);
  const cloned = run("git", ["clone", REPO, DIR]);
  if (cloned.status !== 0) {
    die(
      "Could not clone Nebula Writer.\n" +
        "  If the repository is private, get access first:  gh auth login\n" +
        "  (or ask the owner to add you), then re-run this command."
    );
  }
}

console.log("› Setting up (install, build, start the local server)…\n");
const setup = run("npm", ["run", "setup"], { cwd: DIR });
process.exit(setup.status ?? 1);
