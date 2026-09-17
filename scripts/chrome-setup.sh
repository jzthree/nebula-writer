#!/usr/bin/env bash
# Nebula Writer — Chrome extension setup (Google Docs, Grammarly-style install).
#
#   npm run chrome:setup                          # first run: key + build, prints the extension id
#   npm run chrome:setup -- --client-id=<id>      # after creating the OAuth client: bakes it into the manifest
#
# 1. Generates a private key once (chrome-extension/key.pem, never committed)
#    so the extension keeps the same id every time it is loaded unpacked —
#    the OAuth client is bound to that id.
# 2. Builds the extension (bundles + manifest.json).
# 3. Prints the remaining browser steps.
#
# Needs the HTTPS certificate from `npm run word:setup` (the side panel loads
# the pane from https://localhost:8443).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
DIR="$REPO/chrome-extension"
KEY="$DIR/key.pem"
LOCAL="$DIR/local.json"
PORT="${WRITER_TLS_PORT:-8443}"
CLIENT_ID=""
for arg in "$@"; do
  case "$arg" in
    --client-id=*) CLIENT_ID="${arg#--client-id=}" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ ! -f "$KEY" ]; then
  step "Generating the extension key (once)"
  openssl genrsa -out "$KEY" 2048 2>/dev/null
fi
PUBKEY_B64="$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')"
EXT_ID="$(openssl rsa -in "$KEY" -pubout -outform DER 2>/dev/null | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p')"

node - "$LOCAL" "$PUBKEY_B64" "$CLIENT_ID" <<'EOF'
const fs = require("node:fs");
const [path, key, clientId] = process.argv.slice(2);
const local = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
local.key = key;
if (clientId) local.clientId = clientId;
fs.writeFileSync(path, JSON.stringify(local, null, 2) + "\n");
EOF

step "Building the extension"
WRITER_TLS_PORT="$PORT" node scripts/chrome-build.mjs

HAS_CLIENT="$(node -e "const l=require('$LOCAL'); process.stdout.write(l.clientId ? 'yes' : 'no')")"

cat <<EOF

Extension id: $EXT_ID
Folder to load: $DIR

1. Load it in Chrome (once): chrome://extensions ▸ Developer mode ▸ Load unpacked ▸ choose the folder above.
   Chrome shows the same id as printed here.
EOF
if [ "$HAS_CLIENT" = "no" ]; then
cat <<EOF
2. Give it access to the Docs API (once, ~5 minutes, in https://console.cloud.google.com):
   • Create a project (any name, e.g. "Nebula Writer").
   • APIs & Services ▸ Library ▸ enable "Google Docs API".
   • APIs & Services ▸ OAuth consent screen ▸ External ▸ fill the app name and your email ▸ add yourself under Test users.
   • APIs & Services ▸ Credentials ▸ Create credentials ▸ OAuth client ID ▸ Application type "Chrome Extension" ▸ Item ID: $EXT_ID
   • Copy the client id, then run:  npm run chrome:setup -- --client-id=<the id>
3. chrome://extensions ▸ reload the extension.
EOF
else
cat <<EOF
2. OAuth client id is set. If you changed it, reload the extension in chrome://extensions.
EOF
fi
cat <<EOF
4. Open a Google Doc, click the Nebula Writer toolbar button: the side panel opens, Google asks once to allow access to your documents, and the pane connects to the sidecar (start it with npm run sidecar if it is not running as a service).
EOF
