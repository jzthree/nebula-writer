import assert from "node:assert/strict";
import { matchCommentsToSelection } from "../src/commentMatching";
import { buildAgentTaskPrompt } from "../server/ai";
import { isDocumentCommentList, type AiRequest, type SelectionContext } from "../src/shared";

// Read-only live audit. No provider request, document edits, or fixture files.
const expectedName = process.argv[2];
assert(expectedName, "Usage: npx tsx scripts/check-comment-selection.ts <expected-document-name>");
const base = process.env.WRITER_BASE_URL ?? "http://127.0.0.1:8787";
async function get(path: string) {
  const response = await fetch(`${base}${path}`);
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const document = await get("/api/session/document");
const response = await get("/api/agent-run/live/comments");
const focus = await get("/api/agent-run/live/selection");
assert.equal(document.session?.name, expectedName, "The active Writer document changed");
assert.equal(focus.hostContext?.documentName, expectedName, "The active Google Docs context changed");
assert.equal(response.status?.state, "complete", "Comment access is not complete");
assert(isDocumentCommentList(response.comments), "Invalid comment payload");
const text: string = document.session.documentText;
const comments = response.comments;
const all = matchCommentsToSelection(text, { from: 0, to: text.length, text }, comments);
let locatedChecks = 0;
let ambiguousChecks = 0;
let promptChecks = 0;
for (const evidence of all.matches) {
  const range = evidence.ranges[0];
  const selection = { ...range, text: text.slice(range.from, range.to) };
  if (!selection.text) continue;
  const context = matchCommentsToSelection(text, selection, comments);
  const match = context.matches.find((item) => item.commentId === evidence.commentId);
  assert(match, `Thread ${evidence.commentId} missing near its candidate anchor`);
  assert.equal(match.relationship, "overlap");
  assert.equal(match.certainty, evidence.certainty);
  if (match.certainty === "located") locatedChecks++; else ambiguousChecks++;
  const request: AiRequest = { provider: "claude", mode: "selection", documentText: text, documentComments: comments,
    documentCommentsStatus: response.status, selection, instruction: "Identify relevant comments; do not stage edits." };
  const prompt = buildAgentTaskPrompt(request, { maxSuggestions: null, attachments: [] });
  assert(prompt.includes(`id=${JSON.stringify(evidence.commentId)}`), "Relevant thread omitted from the actual agent prompt");
  promptChecks++;
}
assert(locatedChecks > 0, "No confirmed text anchors were exercised");
const selection: SelectionContext | null = focus.selection;
const live = matchCommentsToSelection(text, selection, comments);
assert.notEqual(live.state, "invalid-selection", "Captured selection is stale");
console.log(JSON.stringify({
  document: expectedName, characters: text.length, threads: comments.length,
  openThreads: comments.filter((comment) => !comment.resolved).length,
  textAnchorsLocated: all.matches.filter((match) => match.certainty === "located").length,
  repeatedAnchorsAmbiguous: all.matches.filter((match) => match.certainty === "ambiguous").length,
  unlocatedThreads: all.unlocated.length,
  locatedChecks, ambiguousChecks, promptChecks,
  liveHighlight: { state: live.state, characters: selection?.text.length ?? 0, matches: live.matches },
  result: "PASS (read-only; no AI request sent)"
}, null, 2));
