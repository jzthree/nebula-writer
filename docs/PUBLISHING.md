# Publishing Nebula Writer for public setup

The onboarding is built so going public is a flip-and-publish, not a rewrite.
Today it works for collaborators with repo access; here's what each step unlocks.

## How a user sets up today (private repo, added collaborators)

1. They land on https://writer.zhoulab.io and copy the paste prompt, or run the
   manual commands from the "Prefer to run it yourself?" section.
2. Their Claude Code / Codex reads `https://writer.zhoulab.io/setup` and runs it:
   `git clone` → `npm run setup` → local server up → browser opens localhost:8787.
3. `git clone` uses their own GitHub credentials, so it works because they have
   access. A stranger without access gets a clear "sign in / ask for access"
   message and stops.

**Prerequisite that is easy to miss:** the clone pulls from GitHub, so anything
you want a collaborator to get must be **pushed to origin** — local commits are
invisible to a fresh clone. Run `git push` after landing changes.

## Going public (anyone can set up)

1. Flip `github.com/jzthree/nebula-writer` to **public**. The existing flow now
   works for everyone unchanged — no code change needed.
2. (Optional but recommended) Choose and add a LICENSE; the landing/setup guide
   already assume the code is fetchable.

## One-command via npm

`create-nebula-writer/` is a standalone bootstrap package (the `npm create`
scaffolder pattern). Once the repo is public:

```sh
cd create-nebula-writer
# set "private": false and pick a real license in package.json
npm publish --access public
```

Then the smoothest entry point is:

```sh
npm create nebula-writer@latest      # or: npx create-nebula-writer
```

It clones (or updates) the repo and runs `npm run setup`. Update the landing CTA
to feature this line once it's published.

## Later: a git-free `npx nebula-writer`

The bootstrap above still needs `git` + a local build. For a fully git-free,
no-build experience, publish the **app itself** as `nebula-writer`:

- Move the server's runtime deps from `devDependencies` to `dependencies`
  (express, tsx, node-pty, yjs/y-*, etc.).
- Ship `dist/` and `server/` and `scripts/` via the `files` field; build in a
  `prepack` script so the published tarball is ready to run.
- Add a `bin` that starts the sidecar directly (skip clone/install/build — npm
  installed deps, dist is shipped).
- Verify node-pty's prebuilt `spawn-helper` keeps its exec bit in the packed
  tarball (npm has stripped it before — see server/terminal-pty.ts).

Then `npx nebula-writer` downloads and runs with no git and no build. This is
more packaging work and must be validated against a real `npm pack`/publish, so
it's deliberately left for when a public release is imminent.
