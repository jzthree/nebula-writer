// The writer.zhoulab.io landing/product page. The cloud is no longer the app —
// Writer runs locally; this origin is a product page + the Yjs collaboration
// sync backend (Durable Objects at /collab and /events). Self-contained HTML so
// the Worker needs no static bundle.
export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nebula Writer — local-first AI document editing</title>
<meta name="description" content="Revise your documents with a real Claude Code / Codex terminal that runs on your own machine. Edits arrive as reviewable tracked changes. Your AI, your account, your files." />
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --panel:#fff; --ink:#16181d; --muted:#5b6470; --line:#e4e7ec; --accent:#7c3aed; --accent-ink:#fff; }
  @media (prefers-color-scheme: dark){ :root{ --bg:#0f1115; --panel:#171a21; --ink:#e9eaee; --muted:#9aa3b0; --line:#262b34; } }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--ink); line-height:1.55; }
  .wrap { max-width:760px; margin:0 auto; padding:64px 24px 80px; }
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:40px; }
  .logo { width:40px; height:40px; border-radius:10px; background:linear-gradient(135deg,var(--accent),#9d6bff); display:grid; place-items:center; color:#fff; font-weight:800; }
  .eyebrow { letter-spacing:.14em; text-transform:uppercase; font-size:12px; color:var(--muted); }
  h1 { font-size:34px; line-height:1.15; margin:0 0 16px; letter-spacing:-0.02em; }
  h1 .accent { color:var(--accent); }
  .lede { font-size:18px; color:var(--muted); margin:0 0 32px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:22px 24px; margin:16px 0; }
  .card h2 { font-size:15px; margin:0 0 10px; }
  ol { margin:0; padding-left:20px; } li { margin:6px 0; }
  code { font-family:ui-monospace,"SF Mono",Menlo,monospace; background:rgba(124,58,237,.10); color:var(--accent); padding:2px 6px; border-radius:6px; font-size:.92em; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:28px 0; }
  @media (max-width:560px){ .grid{ grid-template-columns:1fr; } }
  .feat { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .feat b { display:block; margin-bottom:4px; }
  .feat span { color:var(--muted); font-size:14px; }
  .foot { margin-top:44px; color:var(--muted); font-size:13px; }
  a { color:var(--accent); }
  .paste { position:relative; margin:12px 0 6px; }
  .paste pre { margin:0; background:rgba(124,58,237,.08); border:1px solid var(--line); border-radius:10px; padding:14px 46px 14px 14px; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:13.5px; color:var(--ink); white-space:pre-wrap; word-break:break-word; }
  .copy { position:absolute; top:8px; right:8px; border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:8px; padding:4px 9px; font-size:12px; cursor:pointer; }
  .copy:hover { color:var(--accent); border-color:var(--accent); }
  .muted-note { color:var(--muted); font-size:13px; margin:8px 0 0; }
  details { margin-top:14px; } summary { cursor:pointer; color:var(--accent); font-size:14px; }
  pre.plain { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; overflow:auto; font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:13px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><div class="logo">✎</div><div><div class="eyebrow">Nebula</div><strong>Writer</strong></div></div>

  <h1>Revise your documents with a real <span class="accent">Claude / Codex terminal</span> — running on your machine.</h1>
  <p class="lede">Writer is a local-first app. The AI runs on <em>your</em> computer using <em>your</em> Claude or Codex account, edits your document through a terminal, and stages every change as a reviewable tracked edit. Nothing you write, and no one's AI account, ever passes through this site.</p>

  <div class="grid">
    <div class="feat"><b>Your AI, your account</b><span>Claude Code / Codex run locally. This site never spends anyone's credits.</span></div>
    <div class="feat"><b>Terminal-driven</b><span>Ask a real agent in a terminal embedded in the page; it reads the doc and proposes edits.</span></div>
    <div class="feat"><b>Reviewable edits</b><span>Every suggestion lands as a tracked change you accept or reject.</span></div>
    <div class="feat"><b>Collaborate by id</b><span>Share a doc id; edits sync between collaborators through this server.</span></div>
  </div>

  <div class="card">
    <h2>Get Writer running — paste one line into your agent</h2>
    <p class="muted-note">Already have Claude Code or Codex? Paste this into it and it will set everything up (install, build, start the local server) and open Writer for you:</p>
    <div class="paste">
      <pre id="prompt">Set up Nebula Writer on my machine: read https://writer.zhoulab.io/setup and follow it, then tell me when it's running.</pre>
      <button class="copy" onclick="(function(b){var t=document.getElementById('prompt').textContent;navigator.clipboard&&navigator.clipboard.writeText(t);b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1400);})(this)">Copy</button>
    </div>
    <details>
      <summary>Prefer to run it yourself?</summary>
      <pre class="plain">git clone https://github.com/jzthree/nebula-writer.git
cd nebula-writer
npm run setup</pre>
      <p class="muted-note">Needs Node 20+ (bundled with Claude Code / Codex). <code>npm run setup</code> installs, builds, starts the local server as a login service, and opens <code>http://localhost:8787</code>. Re-run any time to update.</p>
    </details>
  </div>

  <div class="card">
    <h2>What this site does</h2>
    <p style="margin:0;color:var(--muted)">writer.zhoulab.io is the <strong>collaboration sync server</strong>: when you share a document id, each person's local Writer syncs edits through here (a CRDT relay). It runs no AI and stores no credentials.</p>
  </div>

  <div class="foot">Nebula Writer · local-first · <span id="sync">collaboration sync online</span></div>
</div>
</body>
</html>`;
