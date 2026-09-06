# nebula-writer-mcp

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the Nebula Writer sidecar to coding agents (Claude Code, Codex CLI, or any MCP client). It speaks JSON-RPC 2.0 over stdio and forwards every tool call to the Writer sidecar's HTTP API.

**Design principle:** the agent and the human work on the *same* live session. Suggestions an agent proposes appear immediately in the user's review queue in the web UI; decisions the user makes are visible to the agent on its next read. Both sides have the same operations, and session revisions let either side detect (rather than clobber) the other's concurrent changes.

## Tools

| Tool | Purpose |
| --- | --- |
| `writer_status` | Sidecar health, active session summary + revision, and live AI-request progress |
| `writer_open_docx` | Open a local DOCX as the shared Writer session |
| `writer_get_document` | Read the active document text and feature summary |
| `writer_propose_changes` | Ask Codex CLI / Claude Code for anchored revisions (optional `max_suggestions` cap) |
| `writer_list_suggestions` | List the shared review queue with the current session revision |
| `writer_set_suggestion_status` | Accept / reject / re-pend a suggestion (optional `expected_revision` concurrency guard) |
| `writer_export_review_docx` | Export pending suggestions as Word tracked changes |

### Concurrency

Read the session `revision` from `writer_status` or `writer_list_suggestions` and pass it as `expected_revision` when updating suggestion status. If the user (or another agent) changed the session in between, the sidecar answers HTTP 409 with an explanation instead of silently overwriting.

### Long AI runs

`writer_propose_changes` on a long document runs multiple coverage passes and can take minutes (no client-side timeout is applied). Call `writer_status` to see live progress (`Coverage pass 3 of 8`, elapsed time). If a later pass fails, completed passes are kept and the response says how much of the document was covered.

## Usage

Start the Writer sidecar first (from the repo root):

```bash
npm run sidecar       # http://127.0.0.1:8787
```

Then install and register this server with your MCP client:

```bash
cd writer-mcp
npm install
npm run build
claude mcp add nebula-writer -- node /path/to/nebula-writer/writer-mcp/bin/writer-mcp.js
```

(`npx tsx /path/to/nebula-writer/writer-mcp/src/cli.ts` also works without a build step, but still requires `npm install` here first.)

The sidecar URL defaults to `http://127.0.0.1:8787`; override per call with the `writer_url` tool argument or globally with `NEBULA_WRITER_URL` / `WRITER_SIDECAR_URL`.

## Development

```bash
npm install
npm test          # builds, then runs protocol tests + an end-to-end DOCX smoke test through bin/writer-mcp.js
```

The end-to-end test spawns a real sidecar from the parent directory, so run `npm install` in the repo root as well before testing.
