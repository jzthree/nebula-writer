#!/usr/bin/env bash
# Nebula Writer — Word add-in setup (macOS).
#
#   npm run word:setup
#
# 1. Creates a locally trusted HTTPS certificate for localhost (Office requires
#    HTTPS for task panes) under ~/.nebula-writer/certs, reusing an existing
#    one when present. Trusting it asks for your macOS login password once.
# 2. Builds the app so dist/word/taskpane.html exists.
# 3. Installs the add-in manifest into Word's sideload folder.
# 4. Restarts the sidecar (launchd service) so the HTTPS listener comes up.
# 5. Runs the doctor.
#
# Options / env:
#   WRITER_TLS_PORT   HTTPS port (default 8443)
#   WRITER_TLS_DIR    certificate directory (default ~/.nebula-writer/certs)
#   --no-build        skip the build step
#   --no-restart      do not touch the launchd service
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

PORT="${WRITER_TLS_PORT:-8443}"
CERT_DIR="${WRITER_TLS_DIR:-$HOME/.nebula-writer/certs}"
CERT="$CERT_DIR/localhost.pem"
KEY="$CERT_DIR/localhost-key.pem"
WEF_DIR="$HOME/Library/Containers/com.microsoft.Word/Data/Documents/wef"
MANIFEST_SRC="$REPO/word/manifest.xml"
MANIFEST_DST="$WEF_DIR/nebula-writer-manifest.xml"
LAUNCHD_LABEL="io.nebula.writer-sidecar"
DO_BUILD=1
DO_RESTART=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --no-restart) DO_RESTART=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

info() { printf '\033[1;34m›\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

echo "Nebula Writer — Word add-in setup"
echo

[ "$(uname -s)" = "Darwin" ] || die "This script targets Word for Mac. On Windows, sideload word/manifest.xml manually (see docs/word-addin.md)."
command -v node >/dev/null 2>&1 || die "Node.js not found."
command -v openssl >/dev/null 2>&1 || die "openssl not found."

# 1) Certificate -----------------------------------------------------------
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  # Reuse the certificate an earlier add-in checkout generated, if it exists.
  LEGACY="$HOME/Code/nebula-tools/apps/word-addin/certs"
  if [ -f "$LEGACY/localhost.pem" ] && [ -f "$LEGACY/localhost-key.pem" ]; then
    cp "$LEGACY/localhost.pem" "$CERT"
    cp "$LEGACY/localhost-key.pem" "$KEY"
    ok "Reused the existing localhost certificate from $LEGACY"
  else
    info "Generating a self-signed certificate for localhost (valid 825 days)…"
    CNF="$(mktemp)"
    cat > "$CNF" <<'CNF_EOF'
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = localhost
O = Nebula Writer (local development)

[v3_req]
subjectAltName = @alt_names
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
basicConstraints = critical, CA:true

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
CNF_EOF
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 -keyout "$KEY" -out "$CERT" -config "$CNF" >/dev/null 2>&1
    rm -f "$CNF"
    chmod 600 "$KEY"
    ok "Certificate written to $CERT_DIR"
  fi
else
  ok "Certificate present at $CERT_DIR"
fi

# Trust it for SSL in the login keychain (Word's webview honours this). This
# prompts for the macOS login password once; subsequent runs are no-ops.
if security verify-cert -c "$CERT" -p ssl -s localhost >/dev/null 2>&1; then
  ok "Certificate is trusted for https://localhost"
else
  info "Trusting the certificate in your login keychain (macOS will ask for your password)…"
  if security add-trusted-cert -r trustRoot -p ssl -p basic -k "$HOME/Library/Keychains/login.keychain-db" "$CERT"; then
    ok "Certificate trusted"
  else
    warn "Could not add trust automatically. Open Keychain Access, import $CERT, and set 'Secure Sockets Layer (SSL)' to Always Trust."
  fi
fi

# 2) Build ---------------------------------------------------------------
if [ "$DO_BUILD" = 1 ]; then
  if [ ! -d node_modules ]; then
    info "Installing dependencies…"
    npm install
  fi
  info "Building the app (web + Word task pane)…"
  npm run build >/dev/null
  ok "Built dist/word/taskpane.html"
fi
[ -f dist/word/taskpane.html ] || die "dist/word/taskpane.html is missing — run without --no-build."

# 3) Manifest ------------------------------------------------------------
mkdir -p "$WEF_DIR"
if [ -f "$MANIFEST_DST" ]; then
  BACKUP_DIR="$HOME/.nebula-writer/backups"
  mkdir -p "$BACKUP_DIR"
  cp "$MANIFEST_DST" "$BACKUP_DIR/nebula-writer-manifest.$(date +%Y%m%dT%H%M%S).xml"
fi
sed "s#https://localhost:8443#https://localhost:${PORT}#g" "$MANIFEST_SRC" > "$MANIFEST_DST"
ok "Manifest installed at $MANIFEST_DST (port $PORT)"

# 4) Sidecar -------------------------------------------------------------
if [ "$DO_RESTART" = 1 ]; then
  if launchctl list 2>/dev/null | grep -q "$LAUNCHD_LABEL"; then
    info "Restarting the sidecar service so the HTTPS listener starts…"
    launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || warn "launchctl kickstart failed; restart the sidecar manually."
    # Wait for the HTTPS listener.
    for _ in $(seq 1 30); do
      if curl -fsS --cacert "$CERT" "https://localhost:${PORT}/api/health" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
  else
    warn "The sidecar is not installed as a launchd service. Start it with: npm run sidecar   (or install it: bash scripts/install-launchd.sh)"
  fi
fi

# 5) Doctor --------------------------------------------------------------
echo
WRITER_TLS_PORT="$PORT" WRITER_TLS_DIR="$CERT_DIR" node scripts/word-addin-doctor.mjs || true

cat <<EOF

Next, in Microsoft Word:
  1. Quit and reopen Word if it was running (it reads the sideload folder at launch).
  2. Open a document, then click Home › Nebula Writer (or Home › Add-ins › Nebula Writer).
  3. Put the caret where you are working and ask for a change.

If the pane is blank: Safari › Develop › <your Mac> › taskpane.html shows its console
(run: defaults write com.microsoft.Word OfficeWebAddinDeveloperExtras -bool true; then relaunch Word).
EOF
