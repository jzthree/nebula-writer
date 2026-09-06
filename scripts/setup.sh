#!/usr/bin/env bash
# Nebula Writer — one-command local setup.
#
# From a fresh clone to a running app at http://localhost:8787:
#   git clone <repo> ~/Code/nebula-writer && cd ~/Code/nebula-writer && npm run setup
#
# Installs dependencies, builds the web app, runs the local server (as a login
# service on macOS so it survives logout/reboot/crash; foreground elsewhere),
# waits until it is healthy, and opens the browser. Idempotent — safe to re-run
# to update. Set WRITER_SETUP_NO_OPEN=1 to skip opening the browser.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
PORT="${WRITER_SIDECAR_PORT:-8787}"
APP_URL="http://localhost:${PORT}"

info() { printf '\033[1;34m›\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

echo "Nebula Writer setup"
echo

# 1) Prerequisites --------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js not found. Claude Code and Codex include it — install Node 20+ (nodejs.org) and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] || die "Node ${NODE_MAJOR}.x is too old; Nebula Writer needs Node 20+."
ok "Node $(node -v)"

HAVE_CLI=""
command -v claude >/dev/null 2>&1 && HAVE_CLI="claude"
command -v codex  >/dev/null 2>&1 && HAVE_CLI="${HAVE_CLI:+$HAVE_CLI }codex"
if [ -n "$HAVE_CLI" ]; then
  ok "AI CLI on PATH: $HAVE_CLI"
else
  warn "No AI CLI on PATH yet — editing works now; the AI terminal needs one of:"
  warn "    npm install -g @anthropic-ai/claude-code   (then run: claude,  and log in)"
  warn "    npm install -g @openai/codex               (then run: codex login)"
fi

# 2) Dependencies ---------------------------------------------------------
if [ ! -d node_modules ]; then
  info "Installing dependencies…"
  npm install
  ok "Dependencies installed"
else
  ok "Dependencies present"
fi

# 3) Build the web app ----------------------------------------------------
if [ ! -f dist/index.html ]; then
  info "Building the app…"
  npm run build
  ok "Built the app"
else
  ok "App build present"
fi

# 4) Run the local server -------------------------------------------------
RUNNING_VIA="foreground"
SIDE_PID=""
if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  LA="$HOME/Library/LaunchAgents"
  PLIST="$LA/io.nebula.writer-sidecar.plist"
  mkdir -p "$LA" "$HOME/.nebula-agent"
  info "Installing the local server as a login service…"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.nebula.writer-sidecar</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>${REPO}/scripts/writer-sidecar-launchd.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HOME}/.nebula-agent/writer-sidecar.log</string>
  <key>StandardErrorPath</key><string>${HOME}/.nebula-agent/writer-sidecar.log</string>
</dict></plist>
PLIST
  # bootout first so a re-run reloads the new definition; ignore "not loaded".
  launchctl bootout "gui/$(id -u)/io.nebula.writer-sidecar" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl load "$PLIST" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/io.nebula.writer-sidecar" >/dev/null 2>&1 || true
  RUNNING_VIA="launchd"
  ok "Server service installed (auto-starts on login, restarts on crash)"
else
  info "Starting the local server in the background…"
  npm run sidecar >"$HOME/.nebula-writer-sidecar.log" 2>&1 &
  SIDE_PID=$!
fi

# 5) Wait for health, then open ------------------------------------------
info "Waiting for the server to come up…"
READY=""
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "${APP_URL}/api/health" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ -n "$READY" ] || die "Server did not become healthy at ${APP_URL}. See the log (${RUNNING_VIA} → ~/.nebula-agent/writer-sidecar.log or ~/.nebula-writer-sidecar.log)."
ok "Server is up"

if [ -z "${WRITER_SETUP_NO_OPEN:-}" ]; then
  if   command -v open      >/dev/null 2>&1; then open "${APP_URL}"      >/dev/null 2>&1 || true
  elif command -v xdg-open  >/dev/null 2>&1; then xdg-open "${APP_URL}"  >/dev/null 2>&1 || true; fi
fi

echo
ok "Nebula Writer is ready → ${APP_URL}"
if [ "$RUNNING_VIA" = "launchd" ]; then
  echo "   Runs automatically on login. Remove with:"
  echo "     launchctl bootout gui/$(id -u)/io.nebula.writer-sidecar; rm ~/Library/LaunchAgents/io.nebula.writer-sidecar.plist"
else
  echo "   Running in this shell (pid ${SIDE_PID}). Keep it open, or set up a service manager."
  [ -n "$SIDE_PID" ] && wait "$SIDE_PID"
fi
