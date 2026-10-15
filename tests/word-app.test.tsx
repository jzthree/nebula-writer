import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSuggestion, WordLiveSuggestionRequest, WriterChatMessage } from "../src/shared";
import { MockWordHost, sampleGrantDocument } from "../src/word/mockOffice";

const captured: {
  requests: WordLiveSuggestionRequest[];
  contextPushes: unknown[];
  statusUpdates: Array<{ id: string; status: string; note?: string }>;
  chat: WriterChatMessage[];
  catalogFetches: boolean[];
  imageUploads: Array<Record<string, unknown>>;
  steers: Array<{ runId: string; text: string }>;
  steerOk: boolean;
} = {
  requests: [],
  contextPushes: [],
  statusUpdates: [],
  chat: [],
  catalogFetches: [],
  imageUploads: [],
  steers: [],
  steerOk: true
};

const ORIGINAL = "Chromatin accessibility is actually a very important determinant of gene regulation, and it is the case that many studies have looked at it.";
const REPLACEMENT = "Chromatin accessibility is a key determinant of gene regulation, and many studies have examined it.";

vi.mock("../src/word/writerClient", () => ({
  fetchHealth: async () => ({
    ok: true,
    local: true,
    cliEnabled: true,
    providers: ["codex", "claude"],
    providerStatus: [
      { name: "codex", available: true, enabled: true, version: "codex-cli 0.145.0" },
      { name: "claude", available: true, enabled: true, version: "2.1.258 (Claude Code)" }
    ]
  }),
  fetchModelCatalog: async (refresh: boolean) => {
    captured.catalogFetches.push(refresh);
    return {
      refreshed: refresh,
      providers: [
        {
          provider: "claude",
          available: true,
          version: "2.1.258 (Claude Code)",
          path: "/usr/local/bin/claude",
          models: [
            { id: "fable", label: "Fable (latest)", source: "alias" },
            { id: "opus", label: "Opus (latest)", source: "alias" },
            { id: "claude-fable-5-1", label: "Claude Fable 5.1", source: "binary" }
          ],
          reasoning: { control: "effort", levels: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }] },
          defaults: { model: "claude-fable-5-1", reasoning: "xhigh", source: "~/.claude/settings.json" },
          allowsCustomModel: true,
          discoveredAt: new Date().toISOString(),
          notes: []
        },
        {
          provider: "codex",
          available: true,
          version: "codex-cli 0.145.0",
          path: "/opt/homebrew/bin/codex",
          models: [
            { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", source: "catalog", reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoning: "low" },
            { id: "gpt-5.5", label: "GPT-5.5", source: "catalog", reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoning: "medium" },
            { id: "gpt-reserve", label: "GPT-Reserve", source: "catalog", hidden: true, reasoningLevels: ["medium"] }
          ],
          reasoning: { control: "model_reasoning_effort", levels: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" }, { id: "ultra", label: "Ultra" }] },
          defaults: { model: "gpt-5.6-sol", reasoning: "medium", source: "~/.codex/config.toml" },
          allowsCustomModel: true,
          discoveredAt: new Date().toISOString(),
          notes: ["Catalog from codex debug models."]
        }
      ]
    };
  },
  uploadDocumentImage: async (_blob: Blob, meta: Record<string, unknown>) => {
    captured.imageUploads.push(meta);
    const index = Number(meta.index);
    return { index, path: `/tmp/images/img-${index}.png`, url: `/api/ai/images/img-${index}.png`, mime: "image/png", width: meta.width ?? null, height: meta.height ?? null, altText: meta.altText ?? null, context: meta.context ?? null, paragraphIndex: meta.paragraphIndex ?? null };
  },
  fetchImageAsBase64: async () => "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  steerRun: async (runId: string, text: string) => {
    captured.steers.push({ runId, text });
    return captured.steerOk ? { ok: true } : { ok: false, reason: "not-steerable" };
  },
  requestWordSuggestions: async (request: WordLiveSuggestionRequest, options: { signal?: AbortSignal } = {}) => {
    captured.requests.push(request);
    if (request.instruction.startsWith("Slow:")) {
      // A request that takes a while, so a second message can be typed meanwhile.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
    }
    if (request.instruction.startsWith("Figure:")) {
      const image = request.documentImages?.[0];
      const suggestion: AiSuggestion = {
        id: `img-${captured.requests.length}`,
        kind: "image",
        image: { index: 0, path: "/tmp/images/new-figure.png", url: "/api/ai/images/new-figure.png", mime: "image/png", originalUrl: image?.url ?? null },
        title: "Sharper schematic",
        original: "[Image 1] Figure 1 schematic",
        replacement: "",
        rationale: "Regenerated at print resolution.",
        confidence: 0.8,
        target: "global",
        range: null,
        status: "pending"
      };
      return {
        ai: { message: "Replaced the schematic.", provider: request.provider, suggestions: [suggestion], agentSessionId: null, activity: [] },
        session: { id: "word-session", name: "Aims.docx", title: "Aims", sourceDocumentId: "word-live:aims.docx", documentText: request.documentText, documentHtmlLength: 0, revision: 1, suggestions: [suggestion], chatMessages: [], updatedAt: new Date().toISOString() },
        sessionReused: false
      };
    }
    if (request.instruction.startsWith("Sections:")) {
      const first: AiSuggestion = { id: `g-${captured.requests.length}-1`, ref: "S1", title: "Tighten the opening claim", original: ORIGINAL, replacement: REPLACEMENT, rationale: "Removes hedging.", confidence: 0.8, target: request.mode, range: null, status: "pending" };
      const second: AiSuggestion = { id: `g-${captured.requests.length}-2`, ref: "S2", title: "Sharpen the innovation claim", original: "which has not been done before to our knowledge", replacement: "which no prior study has attempted", rationale: "Direct.", confidence: 0.7, target: request.mode, range: null, status: "pending" };
      const third: AiSuggestion = { id: `g-${captured.requests.length}-3`, ref: "S3", title: "Note on pitfalls", original: "Potential pitfalls include batch effects", replacement: "Potential pitfalls include batch effects", rationale: "Consider naming the mitigation.", confidence: 0.6, target: request.mode, range: null, status: "pending", commentOnly: true };
      return {
        ai: { message: "## Significance\nTwo claims were softer than the data supports.\n[S1]\n[S2]\n## Approach\n[S3]", provider: request.provider, suggestions: [first, second, third] },
        session: { id: "word-session", name: "Aims.docx", title: "Aims", sourceDocumentId: "word-live:aims.docx", documentText: request.documentText, documentHtmlLength: 0, features: {}, importMessages: [], suggestions: [first, second, third], pendingSuggestions: 3, updatedAt: "" },
        sessionReused: false
      };
    }
    const suggestion: AiSuggestion = {
      id: `s-${captured.requests.length}`,
      title: request.focus ? "Tighten the opening claim, keeping the citation" : "Tighten the opening claim",
      original: ORIGINAL,
      replacement: request.focus ? `${REPLACEMENT} [1]` : REPLACEMENT,
      rationale: "Removes hedging and filler.",
      confidence: 0.82,
      target: request.mode,
      range: null,
      status: "pending",
      ...(request.focus ? { revises: request.focus.suggestionId, ref: "S2" } : {})
    };
    if (request.instruction.startsWith("Undelivered:")) {
      return {
        ai: { message: "Done.", provider: request.provider, suggestions: [], undeliveredSteers: ["then do the next page"] },
        session: { id: "session-1", name: "doc", revision: 1, pendingSuggestions: 0 },
        sessionReused: true
      } as unknown as Awaited<ReturnType<typeof import("../src/word/writerClient").requestWordSuggestions>>;
    }
    return {
      ai: {
        message: "Staged one edit near your caret.",
        provider: request.provider,
        suggestions: [suggestion],
        modelOptions: request.modelOptions ?? null,
        agentSessionId: `sess-${request.provider}-1`,
        activity: [
          { at: new Date().toISOString(), kind: "status", summary: "The Claude Code agent is starting" },
          { at: new Date().toISOString(), kind: "tool", tool: "mcp__writer__writer_read_context", summary: "Reading the paragraph at the caret" },
          { at: new Date().toISOString(), kind: "tool", tool: "mcp__writer__writer_stage_suggestions", summary: "Staging 1 suggestion" }
        ]
      },
      session: { id: "word-session", name: "Aims.docx", title: "Aims", sourceDocumentId: "word-live:aims.docx", documentText: request.documentText, documentHtmlLength: 0, features: {}, importMessages: [], suggestions: [suggestion], pendingSuggestions: 1, updatedAt: "" },
      sessionReused: false
    };
  },
  pushWordContext: async (update: unknown) => {
    captured.contextPushes.push(update);
    return { adopted: true, sessionId: "word-session", revision: 1, pendingSuggestions: 0 };
  },
  appendSessionChat: async (messages: WriterChatMessage[]) => {
    captured.chat.push(...messages);
  },
  fetchSessionSuggestions: async () => ({ sessionId: "word-session", revision: 1, suggestions: [] }),
  updateSuggestionStatus: async (id: string, status: string, context: { decisionNote?: string } = {}) => {
    captured.statusUpdates.push({ id, status, note: context.decisionNote });
  },
  subscribeWriterEvents: () => () => undefined,
  uploadAttachment: async (file: File) => ({ name: file.name, path: `/tmp/attachments/${file.name}`, text: "Reference text extracted from the file.", truncated: false })
}));

vi.setConfig({ testTimeout: 20_000 });

let mock: MockWordHost;

beforeEach(() => {
  captured.requests = [];
  captured.steers = [];
  captured.steerOk = true;
  captured.imageUploads = [];
  captured.contextPushes = [];
  captured.statusUpdates = [];
  captured.chat = [];
  captured.catalogFetches = [];
  window.localStorage.clear();
  mock = new MockWordHost({
    paragraphs: sampleGrantDocument(),
    documentName: "Aims.docx",
    viewport: { pageChars: 700, visibleChars: 600 }
  }).install();
});

afterEach(() => {
  cleanup();
  mock.uninstall();
});

async function renderPane() {
  const { App } = await import("../src/word/App");
  const view = render(<App />);
  await waitFor(() => expect(screen.getByTitle("Connected to Microsoft Word.")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText("Aims.docx")).toBeInTheDocument());
  await waitFor(() => expect(captured.catalogFetches.length).toBeGreaterThan(0));
  return view;
}

function send(text: string) {
  fireEvent.change(screen.getByLabelText("Instruction for Writer"), { target: { value: text } });
  fireEvent.click(screen.getByLabelText(/^Send to Writer \(⌘↩\)$|^Send now, into the running turn/));
}

describe("Word task pane", () => {
  it("shows where the author is and follows the selection live", async () => {
    await renderPane();
    expect(screen.getByText("Paragraph 1 of 15")).toBeInTheDocument();
    expect(screen.getByText("Specific Aims")).toBeInTheDocument();
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();

    const sentence = "Our central hypothesis is that transient accessibility states precede lineage commitment.";
    act(() => {
      mock.selectText(sentence);
    });
    await waitFor(() => expect(screen.getByText("11 words selected")).toBeInTheDocument());
    expect(screen.getByText("Paragraph 3 of 15")).toBeInTheDocument();
    expect(screen.getByText(/Selection · 11 words/)).toBeInTheDocument();

    act(() => {
      const index = mock.text.indexOf("Using the model");
      mock.setSelection(index, index);
    });
    await waitFor(() => expect(screen.getByText("Aim 2. Model enhancer–promoter coupling.")).toBeInTheDocument());
    expect(screen.getByText("Paragraph 7 of 15")).toBeInTheDocument();
    expect(screen.getByText(/Viewing page/)).toBeInTheDocument();
  });

  it("shares the window state with the sidecar", async () => {
    await renderPane();
    await waitFor(() => expect(captured.contextPushes.length).toBeGreaterThan(0), { timeout: 4_000 });
    const push = captured.contextPushes[0] as { documentName: string; documentText: string | null; adopt: boolean; hostContext: { cursor: { paragraphIndex: number }; documentLength: number } };
    expect(push.documentName).toBe("Aims.docx");
    expect(push.documentText).toBe(mock.text);
    expect(push.adopt).toBe(true);
    expect(push.hostContext.cursor.paragraphIndex).toBe(0);
    expect(push.hostContext.documentLength).toBe(mock.text.length);
    await waitFor(() => expect(screen.getByText("agents")).toBeInTheDocument());
  });

  it("records what was sent in the conversation and applies the reply as a tracked change", async () => {
    await renderPane();
    act(() => {
      mock.selectText(ORIGINAL);
    });
    await waitFor(() => expect(screen.getByText(/Selection · 23 words/)).toBeInTheDocument());

    send("Tighten this.");
    await waitFor(() => expect(captured.requests.length).toBe(1));
    const request = captured.requests[0];
    expect(request.mode).toBe("selection");
    expect(request.selection?.text).toBe(ORIGINAL);
    expect(request.documentText).toBe(mock.text);
    expect(request.documentName).toBe("Aims.docx");
    expect(request.hostContext?.cursor?.paragraphIndex).toBe(1);
    expect(request.hostContext?.section?.heading).toBe("Specific Aims");
    expect(request.hostContext?.viewport).not.toBeNull();
    expect(request.hostContext?.outline.length).toBeGreaterThan(3);
    expect(request.modelOptions).toBeUndefined();

    // The author's turn shows the instruction and exactly what went out.
    expect(screen.getByText("Tighten this.")).toBeInTheDocument();
    const sent = screen.getByText(/Sent Selection · 23 words/);
    expect(sent.textContent).toContain("Claude Code");
    expect(sent.textContent).toContain("Claude Fable 5.1 (default)");
    fireEvent.click(sent);
    expect(screen.getByText(/23 words \(\d+ chars, offsets/)).toBeInTheDocument();
    expect(screen.getByText(/caret ¶ 2 of 15/)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("Tighten the opening claim")).toBeInTheDocument());
    expect(screen.getByText("Staged one edit near your caret.")).toBeInTheDocument();
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    // The tool-call trail is part of the reply.
    const trail = screen.getByText("2 tool calls · 1 read · 1 staging call");
    fireEvent.click(trail);
    expect(screen.getByText(/Reading the paragraph at the caret/)).toBeInTheDocument();
    expect(screen.getByText(/Staging 1 suggestion/)).toBeInTheDocument();
    expect(captured.chat.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(captured.chat[0].content).toContain("[Word pane sent Selection · 23 words");

    fireEvent.click(screen.getByTitle("Replace the text as a Word tracked change"));
    await waitFor(() => expect(mock.text).toContain(REPLACEMENT));
    expect(mock.trackedChanges.length).toBeGreaterThan(0);
    expect(mock.changeTrackingMode).toBe("Off");
    await waitFor(() => expect(screen.getByText(/applied in Word/)).toBeInTheDocument());
    await waitFor(() => expect(captured.statusUpdates).toEqual([{ id: "s-1", status: "accepted", note: "Applied in Word as a tracked change" }]));
    expect(screen.getByText("Nothing pending")).toBeInTheDocument();

    // The applied card still holds the full proposed change for later reference.
    expect(screen.queryByText(REPLACEMENT)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show change/ }));
    expect(screen.getByText("Tighten the opening claim")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy original/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy revised/ })).toBeInTheDocument();
    const handledCard = screen.getByLabelText("Handled suggestion: Tighten the opening claim");
    expect(handledCard.textContent).toContain("actually");
    expect(handledCard.textContent).toContain("key determinant");
    fireEvent.click(screen.getByRole("button", { name: /Hide change/ }));
    expect(screen.queryByRole("button", { name: /Copy original/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Applied as a tracked change/)).toBeInTheDocument();
  });

  it("passes the chosen model and reasoning level to the request", async () => {
    await renderPane();
    fireEvent.change(screen.getByLabelText("AI provider"), { target: { value: "codex" } });
    await waitFor(() => expect(screen.getByRole("option", { name: "GPT-5.5" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.5" } });
    // GPT-5.5 offers four levels; "ultra" belongs to another model and disappears.
    await waitFor(() => expect(screen.queryByRole("option", { name: "Ultra" })).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Reasoning level"), { target: { value: "high" } });

    send("Review the document.");
    await waitFor(() => expect(captured.requests.length).toBe(1));
    expect(captured.requests[0].provider).toBe("codex");
    expect(captured.requests[0].modelOptions).toEqual({ model: "gpt-5.5", reasoning: "high" });
    expect(captured.requests[0].mode).toBe("global");
    await waitFor(() => expect(screen.getByText(/Sent Whole document/)).toBeInTheDocument());
    expect(screen.getByText(/Sent Whole document/).textContent).toContain("Codex CLI · GPT-5.5 · High");

    // The preference survives a provider switch and comes back.
    fireEvent.change(screen.getByLabelText("AI provider"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("AI provider"), { target: { value: "codex" } });
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gpt-5.5");
    expect((screen.getByLabelText("Reasoning level") as HTMLSelectElement).value).toBe("high");

    // Custom model ids are typed in and sent verbatim.
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "__custom__" } });
    const custom = screen.getByLabelText("Custom model id");
    fireEvent.change(custom, { target: { value: "gpt-6-preview" } });
    fireEvent.blur(custom);
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("gpt-6-preview");

    fireEvent.click(screen.getByLabelText("Settings & diagnostics"));
    fireEvent.click(screen.getByLabelText("Rediscover models"));
    await waitFor(() => expect(captured.catalogFetches).toContain(true));
    await waitFor(() => expect(screen.getByText(/Model list refreshed/)).toBeInTheDocument());
  });

  it("leaves a comment, dismisses, restores, and clears without touching the text", async () => {
    await renderPane();
    send("Review the document.");
    await waitFor(() => expect(screen.getByText("Tighten the opening claim")).toBeInTheDocument());
    expect(captured.requests[0].mode).toBe("global");
    expect(captured.requests[0].toolAccess).toBe("full");
    expect(captured.requests[0].hostContext?.cursor).not.toBeNull();

    fireEvent.click(screen.getByTitle("Leave the suggestion as a Word comment on this passage"));
    await waitFor(() => expect(mock.comments.length).toBe(1));
    expect(mock.comments[0].anchorText).toBe(ORIGINAL);
    expect(mock.comments[0].text).toContain("Suggested:");
    expect(mock.text).toContain(ORIGINAL);
    await waitFor(() => expect(screen.getByText(/left as a Word comment/)).toBeInTheDocument());

    send("Again.");
    await waitFor(() => expect(captured.requests.length).toBe(2));
    await waitFor(() => expect(screen.getByTitle("Dismiss (recorded as rejected)")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Dismiss (recorded as rejected)"));
    await waitFor(() => expect(screen.getByText(/dismissed/)).toBeInTheDocument());
    expect(captured.statusUpdates.map((update) => update.status)).toEqual(["accepted", "rejected"]);
    fireEvent.click(screen.getByRole("button", { name: /Restore/ }));
    await waitFor(() => expect(screen.getByTitle("Dismiss (recorded as rejected)")).toBeInTheDocument());
    expect(screen.getByText("1 pending")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Clear the conversation"));
    await waitFor(() => expect(screen.getByText("Start a conversation")).toBeInTheDocument());
    expect(captured.statusUpdates[captured.statusUpdates.length - 1]).toMatchObject({ id: "s-2", status: "rejected", note: "Cleared from the Word pane" });
  });

  it("never applies, comments, or dismisses from a bare keypress", async () => {
    await renderPane();
    send("Tighten the first sentence.");
    await waitFor(() => expect(screen.getByText("Tighten the opening claim")).toBeInTheDocument());
    const editsBefore = mock.edits.length;
    for (const key of ["c", "a", "x", "j", "k", "Enter", "ArrowDown"]) {
      fireEvent.keyDown(window, { key });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mock.comments).toEqual([]);
    expect(mock.edits.length).toBe(editsBefore);
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(captured.statusUpdates).toEqual([]);
  });

  it("sends the document's pictures with a request and applies a picture replacement in Word", async () => {
    mock.uninstall();
    mock = new MockWordHost({
      paragraphs: sampleGrantDocument(),
      documentName: "Aims.docx",
      pictures: [{ paragraphIndex: 4, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", width: 320, height: 200, altText: "Figure 1 schematic" }]
    }).install();
    await renderPane();
    send("Figure: sharpen the schematic");
    await waitFor(() => expect(screen.getByText("Sharper schematic")).toBeInTheDocument());
    expect(captured.imageUploads).toHaveLength(1);
    expect(captured.imageUploads[0]).toMatchObject({ index: 0, width: 320, height: 200, altText: "Figure 1 schematic" });
    expect(captured.requests[0].documentImages).toHaveLength(1);
    expect(captured.requests[0].documentImages?.[0]).toMatchObject({ index: 0, url: "/api/ai/images/img-0.png" });
    const card = screen.getByLabelText("Suggestion: Sharper schematic");
    expect(card.querySelector("img[alt='Current picture']")).toHaveAttribute("src", "/api/ai/images/img-0.png");
    expect(card.querySelector("img[alt='Proposed picture']")).toHaveAttribute("src", "/api/ai/images/new-figure.png");

    fireEvent.click(screen.getByTitle("Replace the text as a Word tracked change"));
    await waitFor(() => expect(mock.pictureReplacements).toHaveLength(1));
    expect(mock.pictureReplacements[0]).toMatchObject({ index: 0, tracked: true });
    await waitFor(() => expect(screen.getByText(/applied in Word/)).toBeInTheDocument());

    // A second request reuses the upload instead of reading Word again.
    send("Figure: and again");
    await waitFor(() => expect(captured.requests.length).toBe(2));
    expect(captured.imageUploads).toHaveLength(1);
  });

  it("sends a message typed while the AI works into the running turn, like the CLIs", async () => {
    await renderPane();
    send("Slow: first request");
    await waitFor(() => expect(screen.getByLabelText("Stop the request")).toBeInTheDocument());
    expect(screen.getByLabelText("Instruction for Writer")).not.toBeDisabled();
    send("also keep the citation");
    await waitFor(() => expect(captured.steers).toHaveLength(1));
    expect(captured.requests[0].runId).toMatch(/^run-/);
    expect(captured.steers[0]).toEqual({ runId: captured.requests[0].runId, text: "also keep the citation" });
    await waitFor(() => expect(screen.getByText("Sent into the running turn — the AI takes it into account in this reply")).toBeInTheDocument());
    expect(screen.queryByText(/Queued:/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("Tighten the opening claim").length).toBeGreaterThan(0), { timeout: 3_000 });
    expect(captured.requests).toHaveLength(1);
  });

  it("queues the message when the running turn cannot take it, and sends it when the turn ends", async () => {
    captured.steerOk = false;
    await renderPane();
    send("Slow: first request");
    await waitFor(() => expect(screen.getByLabelText("Stop the request")).toBeInTheDocument());
    send("second request");
    await waitFor(() => expect(screen.getByText(/Queued: "second request"/)).toBeInTheDocument());
    expect(captured.requests.length).toBe(1);
    await waitFor(() => expect(captured.requests.length).toBe(2), { timeout: 3_000 });
    expect(captured.requests[1].instruction).toBe("second request");
    await waitFor(() => expect(screen.queryByText(/Queued:/)).not.toBeInTheDocument());
  });

  it("holds a message for the next turn with Queue, and Send now delivers it into the running turn", async () => {
    await renderPane();
    send("Slow: first request");
    await waitFor(() => expect(screen.getByLabelText("Stop the request")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Instruction for Writer"), { target: { value: "after this, do the next page" } });
    fireEvent.click(screen.getByLabelText("Queue for after this turn (⇧⌘↩)"));
    expect(screen.getByText(/Queued: "after this, do the next page"/)).toBeInTheDocument();
    expect(captured.steers).toHaveLength(0);
    fireEvent.click(screen.getByText("Send now"));
    await waitFor(() => expect(captured.steers).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/Queued:/)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("Tighten the opening claim").length).toBeGreaterThan(0), { timeout: 3_000 });
    expect(captured.requests).toHaveLength(1);
  });

  it("Send now on a queued message stops the turn and sends it when the turn cannot take input", async () => {
    captured.steerOk = false;
    await renderPane();
    send("Slow: first request");
    await waitFor(() => expect(screen.getByLabelText("Stop the request")).toBeInTheDocument());
    send("urgent follow-up");
    await waitFor(() => expect(screen.getByText(/Queued: "urgent follow-up"/)).toBeInTheDocument());
    fireEvent.click(screen.getByText("Send now"));
    await waitFor(() => expect(captured.requests.length).toBe(2));
    expect(captured.requests[1].instruction).toBe("urgent follow-up");
    await waitFor(() => expect(screen.getByText("Stopped.")).toBeInTheDocument());
  });

  it("sends a message the running turn never received as the next turn", async () => {
    await renderPane();
    send("Undelivered: first request");
    await waitFor(() => expect(captured.requests.length).toBe(2), { timeout: 3_000 });
    expect(captured.requests[1].instruction).toBe("then do the next page");
  });

  it("comments on one suggestion from its card: the reply revises it and the earlier card is withdrawn", async () => {
    await renderPane();
    send("Tighten the first sentence.");
    await waitFor(() => expect(screen.getByText("Tighten the opening claim")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const noteBox = screen.getByLabelText("Your note about this change");
    fireEvent.change(noteBox, { target: { value: "Keep the citation." } });
    fireEvent.click(screen.getByLabelText("Send this note about the change"));
    await waitFor(() => expect(captured.requests.length).toBe(2));
    expect(captured.requests[1].instruction).toBe("Keep the citation.");
    expect(captured.requests[1].focus).toMatchObject({ suggestionId: "s-1", title: "Tighten the opening claim", original: ORIGINAL, replacement: REPLACEMENT });

    await waitFor(() => expect(screen.getByText("Tighten the opening claim, keeping the citation")).toBeInTheDocument());
    expect(screen.getByText(/Revision of Tighten the opening claim/)).toBeInTheDocument();
    const earlier = screen.getByLabelText("Handled suggestion: Tighten the opening claim");
    expect(earlier.textContent).toContain("revised");
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    // The note box closes after sending, and no decision was posted for the withdrawal (the sidecar recorded it).
    expect(screen.queryByLabelText("Your note about this change")).not.toBeInTheDocument();
    expect(captured.statusUpdates).toEqual([]);

    // The digest tells the AI what happened to the earlier suggestion.
    send("Now the next sentence.");
    await waitFor(() => expect(captured.requests.length).toBe(3));
    const digest = captured.requests[2].conversation ?? [];
    expect(digest.some((turn) => turn.role === "user" && turn.content.startsWith('[About "Tighten the opening claim"] Keep the citation.'))).toBe(true);
    expect(digest.some((turn) => turn.role === "assistant" && turn.decisions?.some((decision) => decision.status === "superseded"))).toBe(true);
  });

  it("starts a new conversation without dismissing pending suggestions", async () => {
    await renderPane();
    send("Tighten the first sentence.");
    await waitFor(() => expect(screen.getByText("Tighten the opening claim")).toBeInTheDocument());
    send("And again.");
    await waitFor(() => expect(captured.requests.length).toBe(2));
    expect(captured.requests[1].agentSessionId).toBe("sess-claude-1");
    const decisionsBefore = captured.statusUpdates.length;

    fireEvent.click(screen.getByLabelText("Start a new conversation"));
    await waitFor(() => expect(screen.getByText(/New conversation — earlier turns are no longer sent/)).toBeInTheDocument());
    expect(screen.getByText(/Carried over \d+ pending suggestions? from the previous conversation/)).toBeInTheDocument();
    expect(screen.getAllByText("Tighten the opening claim").length).toBeGreaterThan(0);
    expect(screen.getByText(/^\d+ pending$/)).toBeInTheDocument();
    expect(captured.statusUpdates.length).toBe(decisionsBefore);

    send("Fresh start.");
    await waitFor(() => expect(captured.requests.length).toBe(3));
    expect(captured.requests[2].agentSessionId).toBeUndefined();
    expect(captured.requests[2].conversation).toBeUndefined();
  });

  it("carries the conversation and resumes the provider session on follow-ups", async () => {
    await renderPane();
    send("Tighten the first sentence.");
    await waitFor(() => expect(screen.getByText("Tighten the opening claim")).toBeInTheDocument());
    expect(captured.requests[0].agentSessionId).toBeUndefined();
    expect(captured.requests[0].conversation).toBeUndefined();
    fireEvent.click(screen.getByTitle("Dismiss (recorded as rejected)"));
    await waitFor(() => expect(screen.getByText(/dismissed/)).toBeInTheDocument());

    send("Try again, but keep the citation.");
    await waitFor(() => expect(captured.requests.length).toBe(2));
    const followUp = captured.requests[1];
    expect(followUp.agentSessionId).toBe("sess-claude-1");
    expect(followUp.conversation?.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(followUp.conversation?.[0].content).toBe("Tighten the first sentence.");
    expect(followUp.conversation?.[1].decisions).toEqual([{ ref: null, title: "Tighten the opening claim", status: "dismissed", note: null }]);
    await waitFor(() => expect(screen.getAllByText(/Sent Whole document/).length).toBe(2));
    fireEvent.click(screen.getAllByText(/Sent Whole document/)[1]);
    expect(screen.getByText(/2 earlier turns with your decisions · provider session resumed/)).toBeInTheDocument();

    // Switching provider starts that provider's own session; clearing forgets all of them.
    fireEvent.change(screen.getByLabelText("AI provider"), { target: { value: "codex" } });
    send("And for Codex.");
    await waitFor(() => expect(captured.requests.length).toBe(3));
    expect(captured.requests[2].agentSessionId).toBeUndefined();
    expect(captured.requests[2].conversation?.length).toBe(4);
    fireEvent.click(screen.getByLabelText("Clear the conversation"));
    await waitFor(() => expect(screen.getByText("Start a conversation")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("AI provider"), { target: { value: "claude" } });
    send("Fresh start.");
    await waitFor(() => expect(captured.requests.length).toBe(4));
    expect(captured.requests[3].agentSessionId).toBeUndefined();
    expect(captured.requests[3].conversation).toBeUndefined();
  });

  it("attaches reference files and sends them with every request", async () => {
    await renderPane();
    const input = screen.getByLabelText("Attach reference files", { selector: "input" });
    fireEvent.change(input, { target: { files: [new File(["hello"], "reviewer-notes.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(screen.getByText("reviewer-notes.pdf")).toBeInTheDocument());
    expect(screen.getByText(/Attached reviewer-notes.pdf/)).toBeInTheDocument();

    send("Use the reviewer notes.");
    await waitFor(() => expect(captured.requests.length).toBe(1));
    expect(captured.requests[0].attachments?.map((attachment) => attachment.name)).toEqual(["reviewer-notes.pdf"]);
    const sent = screen.getByText(/Sent Whole document/);
    expect(sent.textContent).toContain("+ 1 file");
    fireEvent.click(sent);
    expect(screen.getByText(/reviewer-notes.pdf \(\d+ chars\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Remove reviewer-notes.pdf"));
    await waitFor(() => expect(screen.queryByText("reviewer-notes.pdf")).not.toBeInTheDocument());
    send("Again without the file.");
    await waitFor(() => expect(captured.requests.length).toBe(2));
    expect(captured.requests[1].attachments).toBeUndefined();
  });

  it("lays the reply out in the agent's sections and applies a whole section", async () => {
    await renderPane();
    send("Sections: review the aims.");
    await waitFor(() => expect(screen.getByText("Sharpen the innovation claim")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Significance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Approach" })).toBeInTheDocument();
    expect(screen.getByText("Two claims were softer than the data supports.")).toBeInTheDocument();
    expect(screen.queryByText(/\[S1\]/)).not.toBeInTheDocument();
    // Cards sit under their sections; the advisory card in "Approach" has no apply, so no Apply-all there.
    const significance = screen.getByLabelText("Significance");
    expect(significance.textContent).toContain("Tighten the opening claim");
    expect(significance.textContent).toContain("Sharpen the innovation claim");
    expect(screen.getByLabelText("Approach").textContent).toContain("Note on pitfalls");
    expect(screen.queryByLabelText(/Apply all \d+ in Approach/)).not.toBeInTheDocument();
    expect(screen.getByText("3 pending")).toBeInTheDocument();

    expect(screen.getByLabelText("Apply all 2 in this reply")).toBeInTheDocument();
    const runsBefore = mock.runCount;
    fireEvent.click(screen.getByLabelText("Apply all 2 in Significance"));
    await waitFor(() => {
      expect(mock.text).toContain(REPLACEMENT);
      expect(mock.text).toContain("which no prior study has attempted");
    }, { timeout: 8_000 });
    expect(mock.trackedChanges.length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(screen.getByText(/Applied 2 suggestions as tracked changes/)).toBeInTheDocument());
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(captured.statusUpdates.filter((update) => update.status === "accepted").length).toBe(2);
    // One batch: a read before, the batch itself, a read after (plus a focus read), not a full cycle per suggestion.
    expect(mock.runCount - runsBefore).toBeLessThanOrEqual(6);
  });

  it("stays off Word's thread while the author types, and re-reads once after the pause", async () => {
    await renderPane();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runsBefore = mock.runCount;
    // Realistic typing: keystrokes 80 ms apart, a short pause between words,
    // and one longer pause to think — never the 1.5 s that counts as stopping.
    const gaps = [80, 80, 80, 80, 350, 80, 80, 80, 350, 80, 80, 1_000, 80, 80, 350, 80, 80];
    for (const gap of gaps) {
      act(() => {
        const at = mock.text.indexOf("Innovation");
        mock.replaceRange(at, at, "x");
        mock.setSelection(at + 1);
      });
      await new Promise((resolve) => setTimeout(resolve, gap));
    }
    const duringTyping = mock.runCount - runsBefore;
    expect(duringTyping).toBe(0);
    // After the pause: one snapshot (plus its caret read), not one per keystroke.
    await waitFor(() => expect(screen.getByText(`${mock.text.trim().split(/\s+/).length} words`)).toBeInTheDocument(), { timeout: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(mock.runCount - runsBefore).toBeLessThanOrEqual(4);
  });

  it("sends the document's comments with a request", async () => {
    mock.uninstall();
    mock = new MockWordHost({
      paragraphs: sampleGrantDocument(),
      documentName: "Aims.docx",
      viewport: { pageChars: 700, visibleChars: 600 },
      comments: [{ anchorText: "Chromatin accessibility", text: "Cite the 2019 atlas here.", author: "Reviewer 2", replies: [{ author: "Jian", text: "Will do." }] }]
    }).install();
    await renderPane();
    send("Address the reviewer comments.");
    await waitFor(() => expect(captured.requests.length).toBe(1));
    expect(captured.requests[0].documentComments).toEqual([expect.objectContaining({
      author: "Reviewer 2",
      text: "Cite the 2019 atlas here.",
      anchorText: "Chromatin accessibility",
      resolved: false,
      replies: [expect.objectContaining({ author: "Jian", text: "Will do." })]
    })]);
  });

  it("re-reads the document when Word changes outside the pane", async () => {
    await renderPane();
    expect(screen.getByText(/^\d+ words$/).textContent).toBe(`${mock.text.trim().split(/\s+/).length} words`);
    act(() => {
      const index = mock.text.indexOf("Innovation");
      mock.replaceRange(index, index + "Innovation".length, "Innovation and impact and reach");
    });
    await waitFor(() => expect(screen.getByText(`${mock.text.trim().split(/\s+/).length} words`)).toBeInTheDocument(), { timeout: 4_000 });
  });
});
