/**
 * Per-run MCP server for agentic AI requests.
 *
 * Spawned by the agent runtime alongside the CLI (Claude Code / Codex) and
 * pointed at one run's context via WRITER_AGENT_RUN_URL
 * (http://127.0.0.1:<port>/api/agent-run/<runId>). The agent's entire
 * capability surface is these tools: read/search the document snapshot the
 * user's request was made on, read chat attachments, and stage suggestions —
 * which the sidecar validates (exact anchor, no-op) and
 * answers per item so the agent can correct and retry.
 *
 * Self-contained JSON-RPC 2.0 over stdio; no dependencies beyond Node.
 */

import * as readline from "node:readline";

const RUN_URL = process.env.WRITER_AGENT_RUN_URL?.replace(/\/$/, "") ?? "";
// Which CLI this MCP instance serves (claude|codex). Two terminals share the
// "live" run, so authorship must ride each stage call — the run can't know.
const AGENT_PROVIDER = process.env.WRITER_AGENT_PROVIDER ?? "";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

const TOOLS: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "writer_read_document",
      description: "Read a window of the document under revision. Returns { text, offset, limit, totalLength }. Call repeatedly with increasing offset to read long documents in slices. Read as much as the instruction needs: the whole document is fair game whenever the passage in scope does not tell you enough.",
      inputSchema: {
        type: "object",
        properties: {
          offset: { type: "number", description: "Character offset to start from (default 0)." },
          limit: { type: "number", description: "Characters to return (default 24000, max 60000)." }
        },
        additionalProperties: false
      }
    },
    handler: (args) => forward("GET", `/document?${windowQuery(args)}`)
  },
  {
    definition: {
      name: "writer_search_document",
      description: "Find exact occurrences of a string in the document. Returns match offsets with surrounding context. Use this to locate the passage you want to edit, then copy the source text verbatim from the context (or a writer_read_document window) into writer_stage_suggestions.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Exact text to search for (case-sensitive)." },
          max_results: { type: "number", description: "Maximum matches to return (default 10, max 50)." }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    handler: (args) => forward("GET", `/search?query=${encodeURIComponent(String(args.query ?? ""))}${args.max_results !== undefined ? `&max_results=${encodeURIComponent(String(args.max_results))}` : ""}`)
  },
  {
    definition: {
      name: "writer_stage_suggestions",
      description: "Stage revision suggestions into the user's review queue. Each item needs { title, original, replacement, rationale, confidence? (0-1), commentOnly? }. `original` must be an EXACT substring of the document; for selection-scoped requests prefer the selection, but a passage elsewhere is accepted when the instruction requires it — the response tells you per item whether it was staged or rejected and why, so fix rejected items and retry. Stage in small batches as you work rather than one giant batch at the end. Each staged item comes back with a `ref` (S1, S2, …): in your final reply, a line `## Heading` opens a section and a line `[S3]` places that suggestion under it, so the user sees each card where it belongs and can apply a whole section at once.",
      inputSchema: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            description: "Suggestions to stage.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Short imperative label for the edit." },
                original: { type: "string", description: "Exact text copied verbatim from the document." },
                replacement: { type: "string", description: "Replacement text." },
                rationale: { type: "string", description: "Why this edit helps." },
                confidence: { type: "number", description: "0-1 confidence (default 0.65)." },
                commentOnly: { type: "boolean", description: "True for advisory notes that need the author's judgment; repeat the original text as the replacement and put the advice in rationale." }
              },
              required: ["title", "original", "replacement", "rationale"],
              additionalProperties: false
            }
          }
        },
        required: ["suggestions"],
        additionalProperties: false
      }
    },
    handler: async (args) => {
      const result = await forward("POST", "/stage", {
        suggestions: args.suggestions,
        ...(AGENT_PROVIDER ? { agent: AGENT_PROVIDER } : {})
      });
      return result;
    }
  },
  {
    definition: {
      name: "writer_read_attachment",
      description: "Read the extracted text of a file the user attached to this request. Returns { text, offset, totalLength }. Attachments are reference material: use them to inform suggestions, but `original` must still quote the document, never an attachment.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Attachment file name, exactly as listed in the task briefing." },
          offset: { type: "number", description: "Character offset to start from (default 0)." },
          limit: { type: "number", description: "Characters to return (default 24000, max 60000)." }
        },
        required: ["name"],
        additionalProperties: false
      }
    },
    handler: (args) => forward("GET", `/attachment?name=${encodeURIComponent(String(args.name ?? ""))}&${windowQuery(args)}`)
  },
  {
    definition: {
      name: "writer_read_context",
      description: "Read the document by structure, relative to where the author is: what = 'paragraph' (the paragraph at the caret; `before`/`after` add neighbours), 'section' (from the heading above the caret to the next heading of the same level), 'page' (exactly what is on screen in Word), 'selection', 'outline' (all headings with offsets), or 'document' (the full text, up to 60,000 characters, plus the outline; for longer documents the note says how to read the rest). Returns { what, from, to, text, paragraphs: [{ index, offset, length, level }], heading, live, note }. Offsets are document offsets, so `text` can be quoted verbatim into writer_stage_suggestions. The window state is LIVE while the Word add-in is open — the author may have moved since your last call, so re-read before staging when the instruction says 'here' or 'this'. Use `around` (a character offset) or `paragraph_index` to read elsewhere than the caret.",
      inputSchema: {
        type: "object",
        properties: {
          what: { type: "string", enum: ["selection", "paragraph", "section", "page", "outline", "document"], description: "Which structural piece to read." },
          around: { type: ["string", "number"], description: "'caret' (default), 'selection', or a character offset to anchor paragraph/section reads." },
          paragraph_index: { type: "number", description: "0-based paragraph index to anchor on instead of the caret." },
          before: { type: "number", description: "Extra paragraphs to include before the anchor (paragraph reads)." },
          after: { type: "number", description: "Extra paragraphs to include after the anchor (paragraph reads)." }
        },
        required: ["what"],
        additionalProperties: false
      }
    },
    handler: (args) => {
      const query = new URLSearchParams();
      query.set("what", String(args.what ?? ""));
      for (const key of ["around", "paragraph_index", "before", "after"] as const) {
        if (args[key] !== undefined && args[key] !== null) {
          query.set(key, String(args[key]));
        }
      }
      return forward("GET", `/context?${query.toString()}`);
    }
  },
  {
    definition: {
      name: "writer_get_selection",
      description: "Read where the user is working right now: { mode, selection: { from, to, text } | null, hostContext, live }. For selection-scoped requests `original` must quote the selection text. When the Nebula Writer Word add-in is open, hostContext is the LIVE Word window state — caret offset and paragraph, the heading it sits under, the pages on screen (viewport offsets), a recent-focus trail, and the document outline — refreshed as the author moves. For the text itself, prefer writer_read_context (paragraph / section / page).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    handler: () => forward("GET", "/selection")
  }
];

function windowQuery(args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (args.offset !== undefined) {
    parts.push(`offset=${encodeURIComponent(String(args.offset))}`);
  }
  if (args.limit !== undefined) {
    parts.push(`limit=${encodeURIComponent(String(args.limit))}`);
  }
  return parts.join("&");
}

async function forward(method: "GET" | "POST", path: string, body?: unknown): Promise<{ text: string; isError?: boolean }> {
  if (!RUN_URL) {
    return { text: "WRITER_AGENT_RUN_URL is not set; this MCP server must be launched by the Writer sidecar.", isError: true };
  }
  try {
    const response = await fetch(`${RUN_URL}${path}`, {
      method,
      ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    if (!response.ok) {
      return { text: `Error (${response.status}): ${text}`, isError: true };
    }
    return { text };
  } catch (error) {
    return { text: `The Writer sidecar is unreachable: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

const toolsByName = new Map(TOOLS.map((tool) => [tool.definition.name, tool]));

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

async function handleRequest(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  const { id, method, params } = request;
  if (id === undefined) {
    return null;
  }
  try {
    if (method === "initialize") {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: ["2025-06-18", "2024-11-05"].includes(requested) ? requested : "2024-11-05",
          serverInfo: { name: "nebula-writer-agent", version: "0.1.0" },
          capabilities: { tools: {} }
        }
      };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS.map((tool) => tool.definition) } };
    }
    if (method === "tools/call") {
      const call = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const tool = call?.name ? toolsByName.get(call.name) : undefined;
      if (!tool) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Unknown tool: ${call?.name ?? "(none)"}` }], isError: true } };
      }
      const outcome = await tool.handler(call?.arguments ?? {});
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) }
      };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  } catch (error) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

export function startAgentMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    if (!line.trim()) {
      return;
    }
    try {
      const response = await handleRequest(JSON.parse(line) as JsonRpcRequest);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: "Parse error" } })}\n`);
    }
  });
  rl.on("close", () => {
    process.exit(0);
  });
}

// Started directly (as the CLI's MCP server), not imported.
const isMain = process.argv[1]?.endsWith("agent-mcp.ts") || process.argv[1]?.endsWith("agent-mcp.js");
if (isMain) {
  startAgentMcpServer();
}
