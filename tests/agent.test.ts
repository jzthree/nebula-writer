// @vitest-environment node

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWriterApp } from "../server/app";
import {
  createAgentRun,
  deleteAgentRun,
  getAgentRun,
  readAgentRunAttachment,
  readAgentRunDocument,
  searchAgentRunDocument,
  stageAgentRunSuggestions
} from "../server/agent-run";
import { buildAgentClaudeArgs, buildAgentCodexArgs, ClaudeStreamParser, CodexStreamParser, type AgentEvent } from "../server/agent-runtime";
import { buildAgentTaskPrompt } from "../server/ai";
import { validateSuggestionCandidate } from "../server/suggestion-validation";
import type { AiRequest } from "../src/shared";

const baseRequest: AiRequest = {
  provider: "claude",
  instruction: "Tighten the opening paragraph",
  mode: "global",
  documentHtml: "",
  documentText: "The study will enroll participants. The sample size is adequate [@smith2020]. Formula $E=mc^2$ stays intact.",
  selection: null
};

describe("agent run context", () => {
  it("creates, reads windows, and deletes runs", () => {
    const run = createAgentRun(baseRequest);
    expect(getAgentRun(run.id)).toBe(run);

    const full = readAgentRunDocument(run);
    expect(full.text).toBe(baseRequest.documentText);
    expect(full.totalLength).toBe(baseRequest.documentText.length);

    const window = readAgentRunDocument(run, 4, 5);
    expect(window.text).toBe("study");
    expect(window.offset).toBe(4);

    deleteAgentRun(run.id);
    expect(getAgentRun(run.id)).toBeNull();
  });

  it("searches with context and caps results", () => {
    const run = createAgentRun({ ...baseRequest, documentText: "alpha beta alpha gamma alpha" });
    const result = searchAgentRunDocument(run, "alpha", 2);
    expect(result.totalMatches).toBe(3);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].offset).toBe(0);
    expect(result.matches[0].context).toContain("alpha beta");
    deleteAgentRun(run.id);
  });

  it("stages valid suggestions and rejects bad ones with reasons", () => {
    const run = createAgentRun(baseRequest);
    const outcome = stageAgentRunSuggestions(run, [
      {
        title: "Tighten sample size claim",
        original: "The sample size is adequate [@smith2020].",
        replacement: "The sample size is justified by a power analysis [@smith2020].",
        rationale: "More specific."
      },
      {
        title: "Anchor miss",
        original: "This text is not in the document.",
        replacement: "Anything",
        rationale: "Should be rejected."
      },
      {
        title: "Drops citation",
        original: "The sample size is adequate [@smith2020].",
        replacement: "The sample size is fine.",
        rationale: "Staged like any other edit — the reviewer sees the dropped marker in the diff."
      },
      {
        title: "Whitespace no-op",
        original: "The study will enroll participants.",
        replacement: "The  study  will  enroll  participants.",
        rationale: "Should be rejected as a no-op."
      }
    ]);

    expect(outcome.results[0].staged).toBe(true);
    expect(outcome.results[1].staged).toBe(false);
    expect(outcome.results[1].reason).toContain("not an exact substring");
    expect(outcome.results[2].staged).toBe(true);
    expect(outcome.results[3].staged).toBe(false);
    expect(outcome.results[3].reason).toContain("whitespace");
    expect(outcome.stagedCount).toBe(2);
    expect(run.staged).toHaveLength(2);
    expect(run.staged[0]).toMatchObject({ status: "pending", target: "global" });
    expect(run.staged[1]).toMatchObject({ title: "Drops citation", ref: "S2" });
    deleteAgentRun(run.id);
  });

  it("accepts commentOnly advisory notes that keep the text unchanged", () => {
    const run = createAgentRun(baseRequest);
    const outcome = stageAgentRunSuggestions(run, [
      {
        title: "Consider citing an outcome metric",
        original: "The study will enroll participants.",
        replacement: "The study will enroll participants.",
        rationale: "Advisory: name the primary outcome metric here if one exists.",
        commentOnly: true
      }
    ]);
    expect(outcome.results[0].staged).toBe(true);
    expect(run.staged[0].commentOnly).toBe(true);
    deleteAgentRun(run.id);
  });

  it("rejects duplicates and enforces the suggestion budget", () => {
    const run = createAgentRun({ ...baseRequest, maxSuggestions: 1 });
    const first = stageAgentRunSuggestions(run, [
      {
        title: "Edit",
        original: "The study will enroll participants.",
        replacement: "The study will enroll 200 participants.",
        rationale: "Specific."
      }
    ]);
    expect(first.results[0].staged).toBe(true);
    expect(first.remainingBudget).toBe(0);

    const second = stageAgentRunSuggestions(run, [
      {
        title: "Over budget",
        original: "Formula $E=mc^2$ stays intact.",
        replacement: "Formula $E=mc^2$ is preserved.",
        rationale: "Should be rejected: budget used."
      }
    ]);
    expect(second.results[0].staged).toBe(false);
    expect(second.results[0].reason).toContain("caps suggestions at 1");
    deleteAgentRun(run.id);
  });

  it("accepts an explicit empty replacement as a deletion suggestion", () => {
    const verdict = validateSuggestionCandidate(
      {
        title: "Delete filler sentence",
        original: "The study will enroll participants.",
        replacement: "",
        rationale: "Redundant with the following sentence."
      },
      baseRequest
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.suggestion.replacement).toBe("");
    }
  });

  it("still rejects a MISSING replacement as malformed", () => {
    const verdict = validateSuggestionCandidate(
      {
        title: "Forgot the field",
        original: "The study will enroll participants.",
        rationale: "No replacement provided."
      },
      baseRequest
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("empty string to propose deleting");
    }
  });

  it("does not second-guess edits to cited text — deleting a cited sentence is the reviewer's call", () => {
    const verdict = validateSuggestionCandidate(
      {
        title: "Delete cited sentence",
        original: "The sample size is adequate [@smith2020].",
        replacement: "",
        rationale: "The claim is unsupported."
      },
      baseRequest
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.suggestion.replacement).toBe("");
    }
  });

  it("treats the selection as the focus, not a fence: in-selection edits keep their range, document edits are accepted, unknown text is rejected", () => {
    const selectionRequest: AiRequest = {
      ...baseRequest,
      mode: "selection",
      documentText: "The study will enroll participants. Formula $E=mc^2$ stays intact.",
      selection: { from: 0, to: 35, text: "The study will enroll participants." }
    };
    const outside = validateSuggestionCandidate(
      { title: "Outside selection", original: "Formula $E=mc^2$ stays intact.", replacement: "Formula $E=mc^2$ is kept.", rationale: "Anchors outside the selection." },
      selectionRequest
    );
    expect(outside.ok).toBe(true);
    if (outside.ok) {
      expect(outside.suggestion.target).toBe("global");
      expect(outside.suggestion.range).toBeNull();
    }
    const inside = validateSuggestionCandidate(
      { title: "Inside selection", original: "will enroll participants", replacement: "enrolls participants", rationale: "Tighter." },
      selectionRequest
    );
    expect(inside.ok).toBe(true);
    if (inside.ok) {
      expect(inside.suggestion.target).toBe("selection");
      expect(inside.suggestion.range).toEqual(selectionRequest.selection);
    }
    const nowhere = validateSuggestionCandidate(
      { title: "Nowhere", original: "This sentence is not in the document.", replacement: "x", rationale: "Bogus." },
      selectionRequest
    );
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) {
      expect(nowhere.reason).toContain("exact substring of the document");
    }
  });

  it("reads attachments with truncation notes and misses cleanly", () => {
    const run = createAgentRun({
      ...baseRequest,
      attachments: [
        { name: "notes.md", path: "/tmp/attachments/x-notes.md", text: "reviewer notes here", truncated: true },
        { name: "scan.pdf", path: "/tmp/attachments/y-scan.pdf", text: "" }
      ]
    });
    const notes = readAgentRunAttachment(run, "notes.md", 0, 8);
    expect(notes?.text).toBe("reviewer");
    expect(notes?.totalLength).toBe(19);
    expect(notes?.note).toContain("truncated");

    const scan = readAgentRunAttachment(run, "scan.pdf");
    expect(scan?.note).toContain("No text could be extracted");

    expect(readAgentRunAttachment(run, "missing.txt")).toBeNull();
    deleteAgentRun(run.id);
  });
});

describe("agent CLI arguments", () => {
  it("locks Claude down to the writer MCP server", () => {
    const args = buildAgentClaudeArgs("/tmp/mcp.json", null);
    expect(args).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      "/tmp/mcp.json",
      "--strict-mcp-config",
      "--tools",
      "ToolSearch",
      "--allowedTools",
      "mcp__writer ToolSearch"
    ]);
  });

  it("opens Claude up by access level: read-only helpers, or everything the user's CLI has", () => {
    const read = buildAgentClaudeArgs("/tmp/mcp.json", null, null, "read");
    expect(read).toContain("--strict-mcp-config");
    expect(read[read.indexOf("--tools") + 1]).toBe("ToolSearch WebSearch WebFetch Read Glob Grep");
    expect(read[read.indexOf("--allowedTools") + 1]).toBe("mcp__writer ToolSearch WebSearch WebFetch Read Glob Grep");

    const full = buildAgentClaudeArgs("/tmp/mcp.json", null, null, "full");
    expect(full).not.toContain("--strict-mcp-config");
    expect(full).not.toContain("--tools");
    expect(full[full.indexOf("--allowedTools") + 1]).toBe("mcp__writer ToolSearch");
    expect(full).toContain("--mcp-config");
  });

  it("gives Codex a writable workspace sandbox only for full access, and no sandbox/cwd flags on resume", () => {
    expect(buildAgentCodexArgs("go", "http://x", "/work", null, null, "full")).toContain("workspace-write");
    expect(buildAgentCodexArgs("go", "http://x", "/work", null, null, "read")).toContain("read-only");
    const resumed = buildAgentCodexArgs("go", "http://x", "/work", "thread-9", null, "full");
    expect(resumed.slice(0, 3)).toEqual(["exec", "resume", "thread-9"]);
    expect(resumed).not.toContain("-s");
    expect(resumed).not.toContain("-C");
  });

  it("resumes Claude sessions", () => {
    const args = buildAgentClaudeArgs("/tmp/mcp.json", "sess-123");
    expect(args.slice(-2)).toEqual(["--resume", "sess-123"]);
  });

  it("runs Codex read-only with the writer MCP server registered", () => {
    const args = buildAgentCodexArgs("do the thing", "http://127.0.0.1:8787/api/agent-run/abc", "/work", null);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("read-only");
    // codex exec has no approval flag; passing -a breaks it.
    expect(args).not.toContain("-a");
    expect(args.join(" ")).toContain("mcp_servers.writer.command=");
    expect(args.join(" ")).toContain('mcp_servers.writer.env.WRITER_AGENT_RUN_URL="http://127.0.0.1:8787/api/agent-run/abc"');
    expect(args[args.length - 1]).toBe("do the thing");
  });

  it("resumes Codex threads", () => {
    const args = buildAgentCodexArgs("follow up", "http://x", "/work", "thread-9");
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "thread-9"]);
  });
});

describe("stream parsers", () => {
  it("parses Claude stream-json init, tools, text, and result", () => {
    const parser = new ClaudeStreamParser();
    const events: AgentEvent[] = [];
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__writer__writer_read_document", input: { offset: 0 } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__writer__writer_stage_suggestions", input: { suggestions: [{}, {}] } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Staged two edits." }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Staged two edits tightening the aims.", total_cost_usd: 0.042, session_id: "sess-1" })
    ];
    for (const line of lines) {
      events.push(...parser.consume(line));
    }

    expect(events[0]).toEqual({ kind: "session", sessionId: "sess-1" });
    expect(events.filter((event) => event.kind === "tool").map((event) => event.kind === "tool" ? event.summary : "")).toEqual([
      "reading the document",
      "staging 2 suggestions"
    ]);
    const outcome = parser.outcome();
    expect(outcome).toMatchObject({ ok: true, sawResult: true, sessionId: "sess-1", cost: 0.042 });
    expect(outcome.text).toBe("Staged two edits tightening the aims.");
  });

  it("parses Codex JSONL threads, items, and completion", () => {
    const parser = new CodexStreamParser();
    const events: AgentEvent[] = [];
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-7" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", tool: "writer_search_document", arguments: { query: "sample size" } } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Staged one edit." } }),
      JSON.stringify({ type: "turn.completed" })
    ];
    for (const line of lines) {
      events.push(...parser.consume(line));
    }

    expect(events[0]).toEqual({ kind: "session", sessionId: "thread-7" });
    const tool = events.find((event) => event.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.summary : "").toContain('searching for "sample size"');
    expect(parser.outcome()).toMatchObject({ ok: true, sawResult: true, sessionId: "thread-7", text: "Staged one edit." });
  });

  it("reports Codex turn failures", () => {
    const parser = new CodexStreamParser();
    parser.consume(JSON.stringify({ type: "turn.failed", message: "model overloaded" }));
    expect(parser.outcome()).toMatchObject({ ok: false, sawResult: true, text: "model overloaded" });
  });
});

describe("agentic loop integration", () => {
  it("runs the full loop: fake CLI reads the MCP config, stages through HTTP, and reports", async () => {
    const app = createWriterApp();
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const previousPort = process.env.WRITER_SIDECAR_PORT;
    const previousAllow = process.env.WRITER_ALLOW_CLI;
    const previousOverride = process.env.WRITER_CLAUDE_PATH;
    process.env.WRITER_SIDECAR_PORT = String(port);
    process.env.WRITER_ALLOW_CLI = "1";

    const tempDir = mkdtempSync(join(process.cwd(), ".writer-agent-fake-"));
    // A stand-in agent: finds the run URL exactly where a real CLI's MCP
    // server would (the --mcp-config file), stages one suggestion through the
    // real HTTP endpoint, then emits stream-json like Claude Code does.
    const fakeClaudePath = join(tempDir, "fake-claude");
    writeFileSync(
      fakeClaudePath,
      [
        "#!/usr/bin/env node",
        // The repo is type:module, so this extensionless script under the
        // repo root runs as ESM.
        'import fs from "node:fs";',
        "const args = process.argv.slice(2);",
        'const config = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));',
        "const runUrl = config.mcpServers.writer.env.WRITER_AGENT_RUN_URL;",
        "const staged = {",
        '  title: "Tighten sample size claim",',
        '  original: "The sample size is adequate.",',
        '  replacement: "The sample size is justified by a formal power analysis.",',
        '  rationale: "Addresses the reviewer concern."',
        "};",
        'fetch(`${runUrl}/stage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestions: [staged] }) })',
        "  .then((response) => response.json())",
        "  .then((outcome) => {",
        '    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-sess" }) + "\\n");',
        '    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `Staged ${outcome.stagedCount} edit tightening the sample size claim.`, session_id: "fake-sess" }) + "\\n");',
        "    process.exit(0);",
        "  })",
        "  .catch((error) => { console.error(String(error)); process.exit(1); });"
      ].join("\n"),
      "utf8"
    );
    chmodSync(fakeClaudePath, 0o755);
    process.env.WRITER_CLAUDE_PATH = fakeClaudePath;

    try {
      const { proposeChanges } = await import("../server/ai");
      const response = await proposeChanges({
        provider: "claude",
        instruction: "Address the reviewer's sample size concern",
        mode: "global",
        documentHtml: "",
        documentText: "Our study enrolls participants. The sample size is adequate.",
        selection: null
      });

      expect(response.provider).toBe("claude");
      expect(response.suggestions).toHaveLength(1);
      expect(response.suggestions[0]).toMatchObject({
        original: "The sample size is adequate.",
        replacement: "The sample size is justified by a formal power analysis.",
        status: "pending"
      });
      expect(response.message).toContain("Staged 1 edit");
      expect(response.agentSessionId).toBe("fake-sess");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tempDir, { recursive: true, force: true });
      if (previousPort === undefined) {
        delete process.env.WRITER_SIDECAR_PORT;
      } else {
        process.env.WRITER_SIDECAR_PORT = previousPort;
      }
      if (previousAllow === undefined) {
        delete process.env.WRITER_ALLOW_CLI;
      } else {
        process.env.WRITER_ALLOW_CLI = previousAllow;
      }
      if (previousOverride === undefined) {
        delete process.env.WRITER_CLAUDE_PATH;
      } else {
        process.env.WRITER_CLAUDE_PATH = previousOverride;
      }
    }
  }, 30_000);
});

describe("agent task prompt", () => {
  it("briefs the agent on tools, budget, and scope without inlining the document", () => {
    const run = createAgentRun({ ...baseRequest, maxSuggestions: 3 });
    const prompt = buildAgentTaskPrompt({ ...baseRequest, maxSuggestions: 3 }, run);

    expect(prompt).toContain("writer_read_document");
    expect(prompt).toContain("writer_search_document");
    expect(prompt).toContain("writer_stage_suggestions");
    expect(prompt).toContain("at most 3 suggestions");
    expect(prompt).toContain(baseRequest.instruction);
    // The document travels through tools, not the prompt.
    expect(prompt).not.toContain(baseRequest.documentText);
    deleteAgentRun(run.id);
  });

  it("inlines short selections and lists attachments", () => {
    const request: AiRequest = {
      ...baseRequest,
      mode: "selection",
      selection: { from: 0, to: 35, text: "The study will enroll participants." },
      attachments: [{ name: "notes.md", path: "/tmp/x", text: "reviewer notes" }],
      agentSessionId: "sess-1"
    };
    const run = createAgentRun(request);
    const prompt = buildAgentTaskPrompt(request, run);

    expect(prompt).toContain("Decide from the instruction whether the request is about this passage or about the document as a whole");
    expect(prompt).toContain("The study will enroll participants.");
    expect(prompt).toContain("notes.md");
    expect(prompt).toContain("writer_read_attachment");
    expect(prompt).toContain("follow-up in an ongoing conversation");
    deleteAgentRun(run.id);
  });
});

describe("staging records a placement anchor", () => {
  it("captures where the original sits and its surroundings", () => {
    const verdict = validateSuggestionCandidate(
      { title: "Tighten", original: "The sample size is adequate", replacement: "The sample size suffices", rationale: "Shorter." },
      baseRequest
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.suggestion.anchor).toEqual({
        offset: 36,
        before: "The study will enroll participants. ",
        after: " [@smith2020]. Formula $E=mc^2$ stays intact."
      });
    }
  });
});
