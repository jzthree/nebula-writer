#!/usr/bin/env bash
# Nebula Writer — Google Docs add-in setup.
#
#   npm run gdocs:setup
#
# 1. Builds the app (dist/gdocs/pane.html, served by the sidecar over HTTPS)
#    and the Apps Script bundle (gdocs/script/Code.js + Sidebar.html).
# 2. Creates the Apps Script project on your Google account the first time
#    (gdocs/script/.clasp.json remembers it) and pushes the code.
# 3. Restarts the sidecar so the pane is served, then prints the one-time
#    steps left in the Apps Script editor (install the test deployment).
#
# Needs the Word add-in's HTTPS setup once (npm run word:setup) — the pane is
# served from the same https://localhost:8443 — and a clasp login:
#
#   npx clasp login
#
# Options / env:
#   WRITER_TLS_PORT   HTTPS port (default 8443)
#   --no-build        skip the build step
#   --no-push         do not push to Apps Script
#   --no-restart      do not touch the launchd service
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

PORT="${WRITER_TLS_PORT:-8443}"
SCRIPT_DIR="$REPO/gdocs/script"
CERT="${WRITER_TLS_DIR:-$HOME/.nebula-writer/certs}/localhost.pem"
SERVICE="io.nebula.writer-sidecar"
BUILD=1
PUSH=1
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --no-push) PUSH=0 ;;
    --no-restart) RESTART=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ ! -f "$CERT" ]; then
  echo "No trusted HTTPS certificate at $CERT — run 'npm run word:setup' first (it creates and trusts the localhost certificate the sidebar needs)." >&2
  exit 1
fi

if [ "$BUILD" = "1" ]; then
  step "Building the pane and the Apps Script bundle"
  WRITER_TLS_PORT="$PORT" npm run build
else
  WRITER_TLS_PORT="$PORT" node scripts/gdocs-build.mjs
fi

if [ "$PUSH" = "1" ]; then
  if [ ! -f "$HOME/.clasprc.json" ]; then
    echo "clasp is not logged in. Run:  npx clasp login   (a browser window asks for your Google account), then rerun this script." >&2
    exit 1
  fi
  if [ ! -f "$SCRIPT_DIR/.clasp.json" ]; then
    step "Creating the Apps Script project (once)"
    (cd "$SCRIPT_DIR" && npx clasp create --type standalone --title "Nebula Writer" --rootDir .)
  fi
  step "Pushing the add-in code"
  (cd "$SCRIPT_DIR" && npx clasp push -f)
fi

if [ "$RESTART" = "1" ] && launchctl print "gui/$(id -u)/$SERVICE" >/dev/null 2>&1; then
  step "Restarting the sidecar"
  launchctl kickstart -k "gui/$(id -u)/$SERVICE"
  for _ in $(seq 1 20); do
    sleep 1
    if curl -sk -m 2 -o /dev/null "https://localhost:$PORT/gdocs/pane.html"; then break; fi
  done
fi

if curl -sk -m 3 -o /dev/null -w '%{http_code}' "https://localhost:$PORT/gdocs/pane.html" | grep -q 200; then
  echo "Pane served at https://localhost:$PORT/gdocs/pane.html"
else
  echo "The sidecar is not serving https://localhost:$PORT/gdocs/pane.html yet — start it (npm run sidecar) or check 'npm run word:doctor'." >&2
fi

cat <<EOF

Next, once per Google account (in the browser):
  1. cd gdocs/script && npx clasp open-script     # opens the project in the Apps Script editor
  2. Deploy ▸ Test deployments ▸ Install          # makes the add-in available in your Google Docs
  3. Open any Google Doc ▸ Extensions ▸ Nebula Writer ▸ Open Writer
     The first time, Google asks you to authorise the add-in (it only reads and
     edits the current document) and Chrome asks to allow local network access
     for the sidebar (accept — the pane is served by the sidecar on this machine).

After code changes: npm run gdocs:setup again (pushes) — pane-only changes only
need the sidecar restarted.
EOF
