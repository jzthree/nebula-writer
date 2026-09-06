# create-nebula-writer

Get [Nebula Writer](https://writer.zhoulab.io) — local-first document editing with a
real Claude Code / Codex terminal — running on your machine in one command:

```sh
npm create nebula-writer@latest
# or
npx create-nebula-writer
```

It clones the app (or updates an existing clone) and runs its `npm run setup`,
which installs dependencies, builds the app, starts the local server as a login
service, waits until it's healthy, and opens `http://localhost:8787`.

**Prerequisite:** Node.js 20+ (bundled with Claude Code and Codex). If the app
repository is private, sign in with `gh auth login` (or ask the owner for access)
first.

Options:

- `npm create nebula-writer ./path` — clone into a specific directory.
- `NEBULA_WRITER_DIR=/path` — same, via env.
- `NEBULA_WRITER_REPO=<url>` — clone from a fork/mirror.
