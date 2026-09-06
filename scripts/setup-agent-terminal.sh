#!/bin/bash
# One-shot setup for the Writer agent terminal on a machine that does NOT own a
# domain. It gives you a real claude/codex terminal, reachable from
# writer.zhoulab.io, secured by hop's Cloudflare **quick tunnel** (an
# auto-generated https://<random>.trycloudflare.com URL — no Cloudflare account,
# no domain, no DNS) plus hop's password/2FA.
#
#   scripts/setup-agent-terminal.sh
#
# What it does, in order:
#   1. Ensure `cloudflared` is installed (the only real dependency).
#   2. Ensure `hop` is available and running (quick-tunnel mode — no domain).
#   3. Show the one-time 2FA (TOTP) QR so browser access is password+2FA gated.
#   4. Verify the Writer sidecar can reach hop, so the "Terminal" button works.
#
# The 2FA scan is the single interactive, deliberate "I am hooking up my
# terminal" step — by design (you should be aware before exposing a terminal).
set -euo pipefail

say() { printf '\033[1;36m[setup]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$1" >&2; }
die() { printf '\033[1;31m[setup]\033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. cloudflared -----------------------------------------------------------
if ! command -v cloudflared >/dev/null 2>&1; then
  say "cloudflared not found — installing it (the tunnel runtime)."
  if command -v brew >/dev/null 2>&1; then
    brew install cloudflared
  else
    die "Please install cloudflared: https://developers.cloudflare.com/cloudflared/get-started/ (or 'brew install cloudflared')."
  fi
fi
say "cloudflared: $(cloudflared --version 2>&1 | head -1)"

# --- 2. hop -------------------------------------------------------------------
# Prefer a hop on PATH; else the sibling checkout (~/Code/hop2).
HOP_BIN=""
if command -v hop >/dev/null 2>&1; then
  HOP_BIN="hop"
elif [ -x "${HOP_REPO:-$HOME/Code/hop2}/hop" ]; then
  HOP_BIN="${HOP_REPO:-$HOME/Code/hop2}/hop"
else
  die "hop not found. Clone it (git clone https://github.com/jzthree/hop) and re-run, or set HOP_REPO=/path/to/hop."
fi
say "hop: $HOP_BIN"

# Start hop if its daemon/tunnel isn't up. With no domain configured hop uses a
# Cloudflare quick tunnel automatically (random trycloudflare.com URL).
STATE="$HOME/.hop2/.tunnel-state"
tunnel_url() { [ -f "$STATE" ] && python3 -c "import json;print(json.load(open('$STATE')).get('url',''))" 2>/dev/null || true; }

if ! "$HOP_BIN" status >/dev/null 2>&1 || [ -z "$(tunnel_url)" ]; then
  say "Starting hop with a quick tunnel (no domain needed)…"
  "$HOP_BIN" >/dev/null 2>&1 || true
  # Wait up to 40s for the tunnel URL to be published.
  for _ in $(seq 1 40); do
    URL="$(tunnel_url)"
    [ -n "$URL" ] && break
    sleep 1
  done
fi
URL="$(tunnel_url)"
[ -n "$URL" ] || die "hop did not produce a tunnel URL. Try 'hop health --restart' and re-run."
case "$URL" in
  *trycloudflare.com*) say "Quick tunnel ready: $URL (rotates on restart — Writer re-reads it each time)." ;;
  *)                   say "Tunnel ready (named/custom): $URL" ;;
esac

# --- 3. Two-factor ------------------------------------------------------------
say "Set up 2FA now (one time). Scan this QR with an authenticator app:"
"$HOP_BIN" qr auth || warn "Could not show the 2FA QR automatically — run '$HOP_BIN qr auth' yourself."

# --- 4. Verify the chain ------------------------------------------------------
PORT="${WRITER_SIDECAR_PORT:-8787}"
if curl -sf -m 3 "http://127.0.0.1:${PORT}/api/agent-terminal" >/dev/null 2>&1; then
  say "Writer sidecar can reach hop — the Terminal button is ready."
else
  warn "Writer sidecar isn't running yet (port ${PORT}). Start it (npm run sidecar / launchd), then the Terminal button in Writer will open your terminal."
fi

cat <<EOF

Done. In Writer, click "Terminal" in the AI chat header:
  • it opens your own hop terminal ($URL) — password + 2FA gated,
  • running claude/codex that edits THIS document (staged into the review queue),
  • no inbound port on your machine (cloudflared dials outward).
EOF
