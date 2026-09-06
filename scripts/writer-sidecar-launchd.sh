#!/bin/bash
# Launch wrapper for the Writer sidecar under launchd.
#
# AI is PERSONAL, never shared. This sidecar is *your* local AI runner: your
# browser on writer.zhoulab.io reaches it directly on localhost (CORS-allowed
# via WRITER_ALLOWED_ORIGINS) and runs suggestions on your own Claude/Codex.
# It deliberately does NOT dial the cloud bridge — no one else's requests are
# ever served by your account through the URL. The sidecar routes agentic
# spawns through nebula-agent-gateway when it's up, else spawns in-process.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# launchd hands us a sparse PATH (/usr/bin:/bin:/usr/sbin:/sbin). The CLIs we
# spawn (codex, claude) are node scripts whose `#!/usr/bin/env node` shebang
# needs `node` on PATH, so a sparse PATH fails with "env: node: No such file or
# directory". Capture the user's interactive login-shell PATH (picks up
# homebrew/nvm/etc.), falling back to the common locations if that fails.
LOGIN_SHELL="${SHELL:-/bin/zsh}"
CAPTURED_PATH="$("$LOGIN_SHELL" -lic 'printf "NAGPATH=%s\n" "$PATH"' 2>/dev/null | sed -n 's/^NAGPATH=//p' | tail -1)"
export PATH="${CAPTURED_PATH:-/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$HOME/.local/bin}:${PATH:-/usr/bin:/bin}"
# Prefer the user-local install (~/.local/bin, where `claude update` lands) over
# an older Homebrew copy, so the sidecar runs the same claude the terminal does
# (a stale /opt/homebrew/bin/claude made every Claude request fail with
# "does not support this model").
[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"

# Allow the deployed web app's origin (and localhost dev) to reach this local
# sidecar from the browser. Override WRITER_ALLOWED_ORIGINS to add origins.
export WRITER_ALLOWED_ORIGINS="${WRITER_ALLOWED_ORIGINS:-https://writer.zhoulab.io,http://localhost:5173,http://127.0.0.1:5173}"

# Do NOT leak a Claude Code session token into the sidecar; claude must auth via
# the login keychain (~/.claude), which our cli-home fix now respects on macOS.
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR WRITER_CLOUD_URL WRITER_CLOUD_TOKEN || true

NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
exec "$NODE_BIN" node_modules/.bin/tsx server/index.ts
