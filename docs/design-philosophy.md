# Nebula Writer: Design Philosophy

Nebula Writer is a writing desk for serious documents — grant proposals, papers, long reports — where the words carry consequences and the author's judgment is the final authority. It pairs a live editor with AI that runs on your own machine, and it is built on a few convictions.

## The AI proposes; the author disposes.

Nebula Writer's AI never edits your document. It stages suggestions: anchored, reviewable proposals that sit in a queue until a human accepts or rejects each one. This is not a limitation; it is the product. A suggestion records who proposed it, why, and what exact text it touches; a decision records who made it and when. The result is a document whose history can be audited sentence by sentence — the standard that matters when a colleague, a reviewer, or a funding agency asks "who wrote this?"

## Every suggestion must quote the document.

An AI edit is only trustworthy if you can see precisely what it changes. Suggestions in Nebula Writer anchor to exact source text — the system rejects any proposal whose "original" is not a verbatim quote of the document, and it refuses replacements that drop citations, formulas, reference labels, DOIs, or URLs. The machinery validates what prompts alone cannot guarantee. When an agent's proposal misses, it is told why and corrects itself before the author ever sees it.

## AI runs on your machine, as you.

There is no server-side model and no API key stored in the cloud. The AI is the coding agent you already have — Claude Code or Codex — running locally under your own account, confined to the document tools we hand it. This is local-first in the strong sense: your drafts do not leave your machine to be revised, the CLI bills to your existing plan, and unplugging the network does not take your editor away. The cloud deployment exists to synchronize collaborators, not to think for you.

## The document is the collaboration surface.

Collaboration should require a link, not an account. Documents are capability URLs: an unguessable id plus a share token is the whole permission model. Everyone with the link edits the same live document; presence, suggestions, chat, and AI progress broadcast to every tab. Agents are collaborators too — they read the same session, stage into the same queue, and are subject to the same revision checks, so a human and an agent can work the same document without silently overwriting each other.

## Word is a peer, not an export format.

Serious documents live and die in .docx. Nebula Writer commits to full Word fidelity: imports preserve formulas, citation fields, tracked changes, and anchors; accepted suggestions export as genuine tracked changes a collaborator can review in Word without ever knowing Nebula Writer exists. The tool must fit into existing workflows rather than demand new ones.

## Progress is honest.

Long AI runs show every collaborator what is actually happening — which pass, which tool, who asked — not a spinner. When AI is unavailable the interface says exactly why and how to fix it. When a run fails halfway, the work already staged is kept. Software that asks for trust with your manuscript earns it by never pretending.

We chose these costs deliberately: staging over autocorrect's speed, exact anchoring over clever-but-loose edits, a local sidecar over someone else's cloud. Each trade buys the same thing — a document you can stand behind. That is the product.

---

*Written and revised in Nebula Writer itself: drafted in the editor, edited through the staged-suggestion review queue by the Claude agentic engine (7 suggestions accepted, 1 rejected across two conversation turns).*
