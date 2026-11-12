#!/usr/bin/env bash
# Nebula Writer — Chrome extension setup (Google Docs, Grammarly-style install).
#
#   npm run chrome:setup                          # first run: key + build, prints the extension id
#   npm run chrome:setup -- --client-id=<id>      # after creating the OAuth client: bakes it into the manifest
#   npm run chrome:setup -- --web-client-id=<id>  # optional: sign in as each Doc tab's own account
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
PICKER_API_KEY=""
PICKER_APP_ID=""
WEB_CLIENT_ID=""
for arg in "$@"; do
  case "$arg" in
    --client-id=*) CLIENT_ID="${arg#--client-id=}" ;;
    --picker-api-key=*) PICKER_API_KEY="${arg#--picker-api-key=}" ;;
    --picker-app-id=*) PICKER_APP_ID="${arg#--picker-app-id=}" ;;
    --web-client-id=*) WEB_CLIENT_ID="${arg#--web-client-id=}" ;;
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

node - "$LOCAL" "$PUBKEY_B64" "$CLIENT_ID" "$PICKER_API_KEY" "$PICKER_APP_ID" "$WEB_CLIENT_ID" <<'EOF'
const fs = require("node:fs");
const [path, key, clientId, pickerApiKey, pickerAppId, webClientId] = process.argv.slice(2);
const local = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
local.key = key;
if (clientId) local.clientId = clientId;
if (webClientId) {
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(webClientId)) throw new Error("web-client-id must look like 123-abc.apps.googleusercontent.com");
  local.webClientId = webClientId;
}
if (pickerApiKey) local.pickerApiKey = pickerApiKey;
if (pickerAppId) {
  if (!/^\d+$/.test(pickerAppId)) throw new Error("picker-app-id must be the numeric Google Cloud project number");
  local.pickerAppId = pickerAppId;
}
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
HAS_WEB_CLIENT="$(node -e "const l=require('$LOCAL'); process.stdout.write(l.webClientId ? 'yes' : 'no')")"
if [ "$HAS_WEB_CLIENT" = "no" ]; then
cat <<EOF
Optional — work as each Doc tab's own Google account (instead of only this Chrome profile's main account):
   • In the same Google Cloud project: APIs & Services ▸ Credentials ▸ Create credentials ▸ OAuth client ID ▸
     Application type "Web application" ▸ Authorized redirect URIs: https://$EXT_ID.chromiumapp.org/
   • If the OAuth consent screen is in Testing, add every Google account you open Docs with under Test users.
   • Copy the client id, then run:  npm run chrome:setup -- --web-client-id=<the id>
EOF
fi
cat <<EOF
4. Open a Google Doc, click the Nebula Writer toolbar button: the side panel opens, Google asks once to allow access to your documents, and the pane connects to the sidecar (start it with npm run sidecar if it is not running as a service).
EOF
