#!/bin/bash
# Launch a real claude/codex CLI wired to the LIVE Writer document.
#
#   scripts/writer-agent-terminal.sh [claude|codex]
#
# The CLI gets Writer's MCP server (writer_read_document / writer_search_document
# / writer_stage_suggestions / writer_get_selection / writer_read_attachment)
# bound to the "live" agent run: reads see the active document's current text,
# and staged suggestions land in the live review queue (accept/reject in Writer,
# synced to collaborators).
#
# It also runs in a NEUTRAL workspace with a briefing (CLAUDE.md / AGENTS.md) so
# the agent understands its job is to edit the user's DOCUMENT via the writer
# tools — not to poke at files on disk or the Writer source tree.
#
# Terminal-driven Writer model (docs/terminal-writer-plan.md): conversation,
# streaming, resume, and errors belong to the real CLI; Writer provides the
# document tools.
set -euo pipefail

PROVIDER="${1:-claude}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${WRITER_SIDECAR_PORT:-8787}"
RUN_URL="http://127.0.0.1:${PORT}/api/agent-run/live"

# Preflight: only require the sidecar. The CLI can start before a document is
# open — the writer tools report "no active session" until one is opened.
# Retry with a generous timeout: /api/health re-resolves the CLIs (spawns
# `codex --version` etc.) and can exceed a short timeout under load, and the
# room may be spawning while the server itself is still booting. A false
# failure here used to poison the persistent room with a bare shell.
HEALTHY=""
for _ in 1 2 3 4 5; do
  if curl -sf -m 10 "http://127.0.0.1:${PORT}/api/health" >/dev/null; then HEALTHY=1; break; fi
  sleep 2
done
if [ -z "$HEALTHY" ]; then
  echo "Writer server is not running on port ${PORT}. Start it first (npm run sidecar)." >&2
  echo "Click the restart button in the terminal bar to retry once it's up." >&2
  exit 1
fi
if ! curl -sf -m 10 "${RUN_URL}/document?limit=1" >/dev/null; then
  echo "Note: no Writer document is active yet — open or create one in Writer and the tools will follow it live." >&2
fi

NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"

# Neutral per-user workspace, NOT the Writer repo, so the agent doesn't think
# it's editing Writer's source. Briefing files live here (claude reads
# CLAUDE.md, codex reads AGENTS.md).
WORKSPACE="${WRITER_TERMINAL_WORKSPACE:-$HOME/.nebula-agent/terminal-workspace}"
mkdir -p "$WORKSPACE"

read -r -d '' BRIEF <<'BRIEF_EOF' || true
# You are the editing agent inside Nebula Writer

You are helping the user revise **their document**, which lives in Nebula Writer
(a DOCX writing app) — NOT any files on disk and NOT the Writer source code. Do
not read, create, or edit files in this directory or anywhere on disk. Ignore
this workspace's contents entirely; it exists only to hold these instructions.

Your only way to see and change the document is the **`writer` MCP tools**:

- `writer_read_document` — read the current document's text (windowed: pass
  `offset`/`limit`). ALWAYS read before proposing edits so you quote it exactly.
- `writer_search_document` — find a passage and its location.
- `writer_get_selection` — the user's current selection, if they highlighted one.
- `writer_read_attachment` — read a reference file the user attached.
- `writer_stage_suggestions` — propose edits. Each item's `original` MUST be
  copied VERBATIM from the document (the tool validates this and tells you which
  items were rejected and why — fix and retry). Staged edits do NOT change the
  document directly; they appear in the user's **review queue** to accept or
  reject.

Workflow: when the user asks for a change, read the relevant part of the
document with the tools, then stage precise suggestions. Preserve citations,
numbers, URLs, and formulas exactly. Keep replies short — the edits are already
in the review queue, so don't repeat them.

If a tool says "no active Writer session", tell the user to open or create a
document in Writer, then retry.
BRIEF_EOF

printf '%s\n' "$BRIEF" > "$WORKSPACE/CLAUDE.md"
printf '%s\n' "$BRIEF" > "$WORKSPACE/AGENTS.md"

# Pre-trust the workspace for codex so it doesn't stop at "Do you trust this
# directory?" (the user opened this deliberately; the briefing files are ours,
# and the agent edits via the writer tools, not disk). This persists exactly
# what codex writes itself when you answer "yes" — idempotent.
CODEX_CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"
if [ "$PROVIDER" = "codex" ] && ! grep -qF "[projects.\"$WORKSPACE\"]" "$CODEX_CONFIG" 2>/dev/null; then
  mkdir -p "$(dirname "$CODEX_CONFIG")"
  printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$WORKSPACE" >> "$CODEX_CONFIG"
fi

MCP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/writer-terminal-XXXXXX")"
trap 'rm -rf "$MCP_DIR"' EXIT
cat > "$MCP_DIR/mcp.json" <<JSON
{
  "mcpServers": {
    "writer": {
      "command": "$NODE_BIN",
      "args": ["$REPO/node_modules/.bin/tsx", "$REPO/server/agent-mcp.ts"],
      "env": { "WRITER_AGENT_RUN_URL": "$RUN_URL", "WRITER_AGENT_PROVIDER": "$PROVIDER" }
    }
  }
}
JSON

echo "Nebula Writer agent terminal — $PROVIDER. The 'writer' tools drive your document; staged edits appear in Writer's review queue."
echo
cd "$WORKSPACE"

SYSTEM_BRIEF="You are the editing agent inside Nebula Writer. Help revise the user's DOCUMENT (which lives in Writer, not on disk) using ONLY the 'writer' MCP tools: writer_read_document, writer_search_document, writer_get_selection, writer_read_attachment, and writer_stage_suggestions (each 'original' must be copied VERBATIM from the document; staged edits go to the user's review queue). Do not read or edit files on disk. Read the document with the tools before proposing edits, then stage precise suggestions."

case "$PROVIDER" in
  claude)
    # Interactive REPL. Writer tools are pre-approved; the system brief + the
    # workspace CLAUDE.md tell it its role. A plain launch (no --continue /
    # --resume) starts a fresh session each time, so the Restart button gives a
    # clean claude; the hop auto-launch that used to hijack this pane is
    # suppressed by HOP_DISABLE_AUTO_LAUNCH in the server's terminal env.
    exec claude --mcp-config "$MCP_DIR/mcp.json" --allowedTools "mcp__writer" \
      --append-system-prompt "$SYSTEM_BRIEF" ;;
  codex)
    # codex reads AGENTS.md from the working root for its role; the MCP server
    # is wired via -c overrides. Pre-trust the workspace so codex doesn't stop
    # at its "Do you trust this directory?" prompt (the user opened this
    # deliberately, and the agent edits via the writer tools, not disk).
    exec codex -C "$WORKSPACE" \
      -c "projects.\"$WORKSPACE\".trust_level=\"trusted\"" \
      -c "mcp_servers.writer.command=\"$NODE_BIN\"" \
      -c "mcp_servers.writer.args=[\"$REPO/node_modules/.bin/tsx\", \"$REPO/server/agent-mcp.ts\"]" \
      -c "mcp_servers.writer.env.WRITER_AGENT_RUN_URL=\"$RUN_URL\"" ;;
  *)
    echo "Unknown provider '$PROVIDER' (use claude or codex)." >&2; exit 1 ;;
esac
