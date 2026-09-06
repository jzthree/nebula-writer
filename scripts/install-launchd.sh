#!/bin/bash
# Installs the nebula-agent-gateway and Writer sidecar as user LaunchAgents so
# writer.zhoulab.io reaches this machine's AI automatically (RunAtLoad +
# KeepAlive across logout/reboot/crash). Idempotent: re-run to update.
#
#   Usage: scripts/install-launchd.sh            # install + load
#          scripts/install-launchd.sh uninstall  # unload + remove
set -euo pipefail

HOME_DIR="$HOME"
WRITER_REPO="$(cd "$(dirname "$0")/.." && pwd)"
GATEWAY_REPO="${NEBULA_GATEWAY_REPO:-$HOME_DIR/Code/nebula-agent-gateway}"
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
LA="$HOME_DIR/Library/LaunchAgents"
GW_PLIST="$LA/io.nebula.agent-gateway.plist"
SC_PLIST="$LA/io.nebula.writer-sidecar.plist"

if [ "${1:-}" = "uninstall" ]; then
  launchctl unload "$GW_PLIST" 2>/dev/null || true
  launchctl unload "$SC_PLIST" 2>/dev/null || true
  rm -f "$GW_PLIST" "$SC_PLIST"
  echo "Unloaded and removed both LaunchAgents."
  exit 0
fi

mkdir -p "$LA" "$HOME_DIR/.nebula-agent"

if [ ! -d "$GATEWAY_REPO" ]; then
  echo "Gateway repo not found at $GATEWAY_REPO (set NEBULA_GATEWAY_REPO)." >&2
  exit 1
fi

sed -e "s#__NODE__#$NODE_BIN#g" -e "s#__REPO__#$GATEWAY_REPO#g" -e "s#__HOME__#$HOME_DIR#g" \
  "$GATEWAY_REPO/launchd/io.nebula.agent-gateway.plist" > "$GW_PLIST"
sed -e "s#__REPO__#$WRITER_REPO#g" -e "s#__HOME__#$HOME_DIR#g" \
  "$WRITER_REPO/launchd/io.nebula.writer-sidecar.plist" > "$SC_PLIST"

# Reload both (unload first so re-runs pick up changes).
for plist in "$GW_PLIST" "$SC_PLIST"; do
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
done

echo "Loaded:"
launchctl list | grep -E "io\.nebula\." || true
echo
echo "Logs: ~/.nebula-agent/gateway.log, ~/.nebula-agent/writer-sidecar.log"
echo "Uninstall: scripts/install-launchd.sh uninstall"
