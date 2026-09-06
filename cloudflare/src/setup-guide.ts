// Agent-readable setup guide served at writer.zhoulab.io/setup.
// A user pastes "read https://writer.zhoulab.io/setup and follow it" into their
// Claude Code / Codex; the agent fetches this and runs it. Kept as plain text /
// Markdown so a CLI agent parses it cleanly. Steps are idempotent.
export const SETUP_GUIDE = `# Set up Nebula Writer locally

You are helping the user run **Nebula Writer**, a local-first DOCX writing app,
on THIS machine. Do the steps below, then tell the user it's running. Everything
runs locally — the app only talks to a local server on port 8787.

Assume the user already has Node.js (it ships with Claude Code and Codex) and
access to the repository. Work in the user's own shell; do not sudo.

## Steps

1. Get the code (skip the clone if the directory already exists):

   \`\`\`
   git clone https://github.com/jzthree/nebula-writer.git ~/Code/nebula-writer 2>/dev/null || true
   cd ~/Code/nebula-writer
   git pull --ff-only 2>/dev/null || true
   \`\`\`

   If the clone fails with an auth/permission error, the repo is private and the
   user needs access — ask them to sign in to GitHub (\`gh auth login\`) or to
   have the owner add them, then retry. Do not work around it.

2. Run the one-command setup:

   \`\`\`
   npm run setup
   \`\`\`

   This installs dependencies, builds the app, starts the local server as a
   login service (macOS launchd; auto-restarts), waits until it is healthy, and
   opens http://localhost:8787. It is safe to re-run.

3. Confirm it is up:

   \`\`\`
   curl -fsS http://localhost:8787/api/health
   \`\`\`

   Expect JSON with \`"ok": true\`. The \`providerStatus\` array shows whether
   \`claude\` / \`codex\` are available. If neither is available, the document
   editor still works, but the in-app AI terminal needs one — install whichever
   the user prefers and have them sign in:

   \`\`\`
   npm install -g @anthropic-ai/claude-code   # then run: claude   (and log in)
   npm install -g @openai/codex               # then run: codex login
   \`\`\`

4. Hand back to the user:

   "Nebula Writer is running at http://localhost:8787 — open it and start
   writing. Ask the agent terminal in the page to revise your document; every
   edit shows up as a reviewable suggestion."

## Notes

- The app is served by the local server at http://localhost:8787 (not from this
  website). writer.zhoulab.io is only the collaboration sync relay.
- Re-running \`npm run setup\` updates to the latest and reloads the server.
- To stop/remove the service:
  \`launchctl bootout gui/$(id -u)/io.nebula.writer-sidecar; rm ~/Library/LaunchAgents/io.nebula.writer-sidecar.plist\`
`;
