import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadWriterRoutineArtifact, ensureAgentTerminal, exportDocx, exportWriterSessionReview, exportWriterSessionState, getHealth, getWriterAutosavedSessions, getWriterSession, getWriterSessionDocument, importDocx, importWriterSessionState, loadWriterAutosavedSession, requestAiSuggestion, runProviderSmokeTest, setWriterSessionChatMessages, setWriterRoutineProgress, setWriterRoutineRun, setWriterSuggestionStatus, syncWriterRoutineSuggestions, uploadAiAttachment, steerAiRun } from "../src/api";
import { App, bodySafeAnchorCandidates, formatReviewBacklogClipboard, formatWordCommentOverlapGroupClipboardPacket, formatWordCommentOverlapTriageClipboardPacket, isPiFactCheckSuggestion, nearbyAlternateAnchorCandidates, nearbyDocxVerifiedAnchorCandidates, reviewBacklogPressureStatus, suggestionForClickedBlockText, wordCommentOverlappingSuggestions, wordCommentOverlapGroupBySuggestionIdForSuggestions, wordCommentOverlapGroupCountForSuggestions, wordCommentOverlapGroupSizeBySuggestionIdForSuggestions, wordCommentOverlapGroupTitleSummaryBySuggestionIdForSuggestions, wordCommentOverlapRepresentativeSuggestions, wordCommentOverlapSummary } from "../src/App";
import { selectSuggestionTarget } from "../src/editorOps";
import { addReviewTrace, setReviewHighlight, setReviewTraces } from "../src/reviewHighlight";
import { AI_CONTEXT_CHAR_LIMIT, type AiResponse, type AiSuggestion, type DocxFeatureSummary, type WriterSessionSummary } from "../src/shared";

vi.mock("../src/api", async () => ({
  // Re-export the real error class so `instanceof SidecarHttpError` checks in
  // App.tsx work against errors thrown by mocked functions.
  SidecarHttpError: (await vi.importActual<typeof import("../src/sidecarClient")>("../src/sidecarClient")).SidecarHttpError,
  downloadWriterRoutineArtifact: vi.fn(() => Promise.resolve({
    blob: new Blob(["artifact"]),
    filename: "significance.docx"
  })),
  exportDocx: vi.fn(() => Promise.resolve({
    blob: new Blob(["docx"]),
    report: null
  })),
  exportWriterSessionReview: vi.fn(() => Promise.resolve({
    outputPath: "/tmp/shared-review.docx",
    reportPath: "/tmp/shared-review_report.json",
    suggestionsPath: "/tmp/shared-review_suggestions.json",
    blob: new Blob(["docx"]),
    report: null,
    reviewPlacements: [],
    routineRun: null,
    session: null
  })),
  exportWriterSessionState: vi.fn(() => Promise.resolve({
    blob: new Blob(["session"]),
    filename: "shared_20260602T010203Z_nebula-session.json"
  })),
  getHealth: vi.fn(() => Promise.resolve({
    ok: true,
    cliEnabled: true,
    providers: ["codex", "claude"],
    providerStatus: [
      {
        name: "codex",
        available: true,
        enabled: true,
        detail: "Uses codex",
        overrideEnv: "WRITER_CODEX_PATH",
        overrideValue: null,
        path: "/usr/local/bin/codex",
        version: "codex-cli test"
      },
      {
        name: "claude",
        available: true,
        enabled: true,
        detail: "Uses claude",
        overrideEnv: "WRITER_CLAUDE_PATH",
        overrideValue: null,
        path: "/usr/local/bin/claude",
        version: "Claude Code test"
      }
    ]
  })),
  getWriterSession: vi.fn(() => Promise.resolve({ session: null })),
  uploadAiAttachment: vi.fn(() => Promise.resolve({
    name: "attachment.txt",
    path: "/tmp/attachments/mock-attachment.txt",
    text: "mock attachment text"
  })),
  ensureAgentTerminal: vi.fn(() => Promise.resolve({ available: true, running: true, url: "https://hop.zhoulab.io/s/writer-agent/", tunnel: true, detail: "Agent terminal is ready." })),
  getAiProgress: vi.fn(() => Promise.resolve({ progress: null })),
  getWriterSessionDocument: vi.fn(() => Promise.resolve({ session: null })),
  getWriterAutosavedSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
  importDocx: vi.fn(),
  importWriterSessionState: vi.fn(),
  loadWriterAutosavedSession: vi.fn(() => Promise.resolve({ session: null })),
  steerAiRun: vi.fn(() => Promise.resolve({ ok: true })),
  requestAiSuggestion: vi.fn(() => Promise.resolve({
    provider: "codex",
    message: "One edit",
    suggestions: [
      {
        id: "suggestion-1",
        title: "Tighten sentence",
        original: "This is a local-first writing workspace for revising DOCX documents with AI.",
        replacement: "This local-first workspace revises DOCX documents with AI.",
        rationale: "Tightens the opening sentence.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      }
    ]
  })),
  runProviderSmokeTest: vi.fn(() => Promise.resolve({
    provider: "codex",
    ok: true,
    message: "Codex CLI returned 1 exact-source suggestion.",
    latencyMs: 18,
    suggestionCount: 1
  })),
  appendWriterChatMessages: vi.fn(() => Promise.resolve({ appended: 0, session: null })),
  recordWriterSuggestions: vi.fn(() => Promise.resolve({ recorded: 0, session: null })),
  LOCAL_AI_BASE: "http://127.0.0.1:8787",
  getLocalAiHealth: vi.fn(() => Promise.reject(new Error("no local sidecar"))),
  getLocalAiProgress: vi.fn(() => Promise.resolve({ progress: null })),
  requestLocalAiSuggestion: vi.fn(() => Promise.reject(new Error("no local sidecar"))),
  importDocxLocally: vi.fn(() => Promise.reject(new Error("no local sidecar"))),
  exportDocxLocally: vi.fn(() => Promise.reject(new Error("no local sidecar"))),
  setWriterSessionChatMessages: vi.fn(() => Promise.resolve({ session: null })),
  setWriterRoutineProgress: vi.fn(() => Promise.resolve({ session: null })),
  setWriterRoutineRun: vi.fn(() => Promise.resolve({ session: null })),
  setWriterSuggestionStatus: vi.fn(() => Promise.resolve({ session: null })),
  syncWriterRoutineSuggestions: vi.fn(() => Promise.resolve({ syncedSuggestions: 0, session: null }))
}));

vi.mock("../src/editorOps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/editorOps")>();
  return {
    ...actual,
    selectSuggestionTarget: vi.fn(() => ({ from: 8, to: 76 }))
  };
});

vi.mock("../src/reviewHighlight", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/reviewHighlight")>();
  return {
    ...actual,
    addReviewTrace: vi.fn(),
    setReviewHighlight: vi.fn(),
    setReviewTraces: vi.fn(),
    clearReviewHighlight: vi.fn()
  };
});

const emptyFeatures: DocxFeatureSummary = {
  formulas: 0,
  citationFields: 0,
  fields: 0,
  contentControls: 0,
  customXml: 0,
  hyperlinks: 0,
  bookmarks: 0,
  commentRanges: 0,
  notes: 0,
  trackedChanges: 0,
  tables: 0,
  images: 0,
  textBoxes: 0,
  bibliographySections: 0,
  preservationRecommended: false
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "showSaveFilePicker");
  window.getSelection()?.removeAllRanges();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Document identity lives in the URL fragment; reset it between tests.
  window.history.replaceState(null, "", "/");
});

function selectElementText(element: Element): void {
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Selection API is unavailable");
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

// The prompt library (saved prompts, starter prompts, grant workflow) is
// collapsed by default so it never competes with the chat for vertical space.
// Tests that exercise library content open it first.
function openPromptLibrary(): void {
  const bar = screen.queryByRole("button", { name: "Skills" });
  if (bar && bar.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(bar);
  }
}

describe("App suggestion review", () => {
  it("matches clicked document text to a proposed change card from the same paragraph", () => {
    const suggestions: AiSuggestion[] = [
      {
        id: "aim-gap",
        title: "Clarify Aim premise",
        original: "single-molecule chromatin states reveal regulatory heterogeneity",
        replacement: "single-molecule chromatin states resolve regulatory heterogeneity that bulk assays obscure",
        rationale: "Connects the paragraph premise to the review gap.",
        confidence: 0.9,
        target: "global",
        range: null,
        status: "pending"
      }
    ];

    expect(suggestionForClickedBlockText(
      "This paragraph argues that single-molecule chromatin states reveal regulatory heterogeneity in a way reviewers can follow.",
      suggestions
    )?.id).toBe("aim-gap");
    expect(suggestionForClickedBlockText("Short note", suggestions)).toBeNull();
  });

  it("summarizes high-pressure review backlogs without warning on small queues", () => {
    expect(reviewBacklogPressureStatus({
      conflictCount: 0,
      latestPendingCount: 2,
      pendingCount: 12,
      sourceMovedCount: 0,
      wordCommentCount: 0
    })).toBeNull();

    expect(reviewBacklogPressureStatus({
      conflictCount: 7,
      latestPendingCount: 3,
      pendingCount: 101,
      sourceMovedCount: 12,
      wordCommentCount: 1
    })).toEqual({
      headline: "Backlog: 101 pending edits",
      detail: "3 latest-export edits available in the latest run. 1 Word-comment edit, 12 missing-target edits, and 7 conflicting edits need triage before another broad pass."
    });

    expect(reviewBacklogPressureStatus({
      conflictCount: 5,
      conflictGroupCount: 2,
      dismissibleConflictCount: 2,
      latestPendingCount: 4,
      pendingCount: 105,
      representedConflictCount: 5,
      representedPendingCount: 105,
      sourceMovedCount: 0,
      wordCommentCount: 2
    })).toEqual({
      headline: "Review DOCX coverage: 105 represented edits",
      detail: "105 pending edits already represented in review DOCX packets. No unrepresented pending edits remain. 4 latest-export edits available in the latest run. 2 Word-comment edits need triage before another broad pass. 5 represented conflicting edits across 2 shared targets already have review-DOCX coverage but still need one winner selected. 2 non-winner alternatives can be dismissed from the Conflicts tab."
    });

    expect(formatReviewBacklogClipboard({
      currentFilter: "Latest export",
      detail: "3 latest-export edits available in the latest run. 1 Word-comment edit, 12 missing-target edits, and 7 conflicting edits need triage before another broad pass.",
      headline: "Backlog: 101 pending edits",
      latestArtifactPath: "/Users/jianzhou/Downloads/review.docx",
      latestRunLabel: "Aim 3B figure language"
    })).toContain("Latest artifact: /Users/jianzhou/Downloads/review.docx");
  });

  it("warns when Word comments share the same source text", () => {
    const broadResourceOriginal = "The project will produce a refined measurement protocol and a large perturbation rich dataset designed for model training through joint development of the experimental and computational method. The dataset will serve as a shared benchmark for biologists and machine learning researchers.";
    const narrowResourceOriginal = "The project will produce a refined measurement protocol and a large perturbation rich dataset designed for model training through joint development of the experimental and computational method.";
    const suggestions: AiSuggestion[] = [
      {
        id: "resource-broad",
        title: "Clarify resource value",
        original: broadResourceOriginal,
        replacement: "The project will produce a refined measurement protocol and a large, perturbation-rich dataset designed for model training through joint development of the experimental and computational methods. As a shared resource, the dataset will support benchmarking of molecule-level models.",
        rationale: "Expands the resource payoff.",
        confidence: 0.9,
        target: "global",
        status: "pending"
      },
      {
        id: "resource-narrow",
        title: "Refine significance resource sentence",
        original: narrowResourceOriginal,
        replacement: "The project will produce a refined measurement protocol and a large, perturbation-rich dataset designed for model training through joint development of the experimental and computational methods.",
        rationale: "Fixes grammar in the resource sentence.",
        confidence: 0.95,
        target: "global",
        status: "pending"
      }
    ];

    expect(wordCommentOverlapSummary(suggestions)).toBe("2 alternative Word comments across 1 shared text target, including Clarify resource value vs Refine significance resource sentence; choose one version before manual insertion");
    expect(wordCommentOverlappingSuggestions(suggestions).map((suggestion) => suggestion.id)).toEqual(["resource-broad", "resource-narrow"]);
    expect(wordCommentOverlapRepresentativeSuggestions(suggestions).map((suggestion) => suggestion.id)).toEqual(["resource-broad"]);
    expect(wordCommentOverlapGroupCountForSuggestions(suggestions)).toBe(1);
    expect(wordCommentOverlapGroupSizeBySuggestionIdForSuggestions(suggestions).get("resource-broad")).toBe(2);
    expect(wordCommentOverlapGroupBySuggestionIdForSuggestions(suggestions).get("resource-broad")?.map((suggestion) => suggestion.id)).toEqual(["resource-broad", "resource-narrow"]);
    expect(wordCommentOverlapGroupTitleSummaryBySuggestionIdForSuggestions(suggestions).get("resource-broad")).toBe("Refine significance resource sentence");
    const packet = formatWordCommentOverlapGroupClipboardPacket(suggestions[0], suggestions);
    expect(packet).toContain("The lead card is a starting point chosen by broadest source text and confidence");
    expect(packet).toContain("Clicked card: Clarify resource value");
    expect(packet).toContain(`Shared source text target:\n${broadResourceOriginal}`);
    expect(packet).toContain("1. Clarify resource value");
    expect(packet).toContain("2. Refine significance resource sentence");
    const triagePacket = formatWordCommentOverlapTriageClipboardPacket(suggestions);
    expect(triagePacket).toContain("# Same-Source Word Comment Triage Packet");
    expect(triagePacket).toContain("Shared targets: 1");
    expect(triagePacket).toContain("Same-source Word comments: 2");
    expect(triagePacket).toContain("1 shared text target representing 2 same-source Word comments");
    expect(triagePacket).toContain("Lead cards are starting points chosen by broadest source text and confidence.");
    expect(triagePacket).toContain("Lead id: resource-broad");
    expect(triagePacket).toContain("Suggestion ids: resource-broad, resource-narrow");
    expect(triagePacket).toContain("Lead card: Clarify resource value");
    expect(triagePacket).toContain("Competing titles: Refine significance resource sentence");
  });

  it("keeps PI/fact checks focused on citation, unit, and placeholder handoffs", () => {
    expect(isPiFactCheckSuggestion({
      title: "Add FiberTools citations",
      original: "FiberTools will be used for footprint detection.",
      replacement: "[PI/author: add the FiberTools software citation here.]",
      rationale: "Converts a visible citation placeholder into an author handoff."
    })).toBe(true);
    expect(isPiFactCheckSuggestion({
      title: "Verify inhibitor units",
      original: "DRB will be used at 100uM.",
      replacement: "DRB will be used at 100uM.",
      rationale: "Verify the concentration unit before Word cleanup."
    })).toBe(true);
    expect(isPiFactCheckSuggestion({
      title: "Separate processivity notation",
      original: "The protocol readout is summarized by lambda.",
      replacement: "The protocol readout is summarized by lambda.",
      rationale: "Clarifies processivity notation in equation-adjacent text."
    })).toBe(false);
  });

  it("rejects the other pending same-source Word comments", async () => {
    const sharedOriginal = "This Aim 1C time-course paragraph explains how treated samples, control samples, and timepoints should be interpreted together during the planned analysis.";
    const suggestions: AiSuggestion[] = [
      {
        id: "pause-keep",
        title: "Clarify Aim 1C sampling structure",
        original: sharedOriginal,
        replacement: "Aim 1C will compare treated and control samples as one interpretable time series.",
        rationale: "Chosen integrated winner for this source target.",
        confidence: 0.93,
        target: "global",
        status: "pending"
      },
      {
        id: "pause-alt",
        title: "Explain timepoint rationale",
        original: sharedOriginal,
        replacement: "Aim 1C timepoints should explain early and late release windows.",
        rationale: "A narrower alternative that should be retired after choosing the winner.",
        confidence: 0.86,
        target: "global",
        status: "pending"
      }
    ];
    const session: WriterSessionSummary = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: sharedOriginal,
      documentHtmlLength: sharedOriginal.length,
	      features: emptyFeatures,
	      importMessages: [],
	      routineProgress: [],
	      routineRuns: [
        {
          id: "run-word-comments",
          routineId: "r01-cumulative-review",
          label: "Current cumulative review",
          completedAt: "2026-06-07T20:10:00.000Z",
          artifactPath: "/tmp/cumulative.docx",
          report: {
            totalSuggestions: 2,
            matchedSuggestions: 0,
            matchedSuggestionIds: [],
            matchedSuggestionTitles: [],
            commentedSuggestions: 2,
            commentedSuggestionIds: ["pause-keep", "pause-alt"],
            commentedSuggestionReasons: [
              "Source text is in a paragraph that already contains Word comments.",
              "Source text is in a paragraph that already contains Word comments."
            ],
            commentedSuggestionTitles: ["Clarify Aim 1C sampling structure", "Explain timepoint rationale"],
            unmatchedSuggestions: 0,
            unmatchedSuggestionIds: [],
            unmatchedSuggestionTitles: []
          }
        }
      ],
      suggestions,
      pendingSuggestions: 2,
      updatedAt: "2026-06-07T20:10:00.000Z"
    };
    vi.mocked(getWriterSession)
      .mockResolvedValueOnce({ session })
      .mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument)
      .mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: `<p>${sharedOriginal}</p>`,
        documentHtmlLength: `<p>${sharedOriginal}</p>`.length
      }
      })
      .mockResolvedValueOnce({
        session: {
          ...session,
          documentHtml: `<p>${sharedOriginal}</p>`,
          documentHtmlLength: `<p>${sharedOriginal}</p>`.length
        }
      });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));
    const overlapTab = await screen.findByRole("tab", { name: "Same-source Word comments" });
    expect(overlapTab).toHaveAttribute("title", "Show 1 same-source Word comment group as one lead card per shared source text");
    expect(within(overlapTab).getByText("1")).toHaveClass("review-filter-count");
    fireEvent.click(overlapTab);

    expect(screen.getByRole("tab", { name: "Same-source Word comments" })).toHaveClass("active");

    const winnerCard = await screen.findByRole("button", { name: "Jump to proposed change: Clarify Aim 1C sampling structure" });
    expect(within(winnerCard).getByText("Same source 2")).toBeInTheDocument();
    fireEvent.click(within(winnerCard).getByRole("button", { name: "Reject others" }));

    await waitFor(() => expect(setWriterSuggestionStatus).toHaveBeenCalledWith("pause-alt", "rejected"));
    expect(setWriterSuggestionStatus).not.toHaveBeenCalledWith("pause-keep", "rejected");
    expect(await screen.findByText("Rejected 1 same-source Word comment for Clarify Aim 1C sampling structure")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Explain timepoint rationale" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject others" })).not.toBeInTheDocument();
  });

  it("starts a new AI conversation from the chat header", async () => {
    render(<App />);

    const button = await screen.findByRole("button", { name: "Start a new conversation" });
    expect(button).toHaveAttribute("title", expect.stringContaining("pending suggestions and attachments stay"));
    fireEvent.click(button);

    expect(await screen.findByText(/New conversation — earlier turns are no longer sent to the AI/)).toBeInTheDocument();
  });

  it("lets users dismiss the high-pressure backlog panel", async () => {
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "codex",
      message: "Many edits",
      suggestions: Array.from({ length: 101 }, (_, index) => ({
        id: `bulk-${index + 1}`,
        title: `Bulk edit ${index + 1}`,
        original: "This is a local-first writing workspace for revising DOCX documents with AI.",
        replacement: `This local-first workspace revises DOCX documents with AI. ${index + 1}`,
        rationale: "Creates a high-pressure review backlog.",
        confidence: 0.8,
        target: "global",
        status: "pending"
      }))
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make many edits" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Backlog: 101 pending edits")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss review backlog status" }));

    expect(screen.queryByText("Backlog: 101 pending edits")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(screen.queryByText("Backlog: 101 pending edits")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Pending" }));
    expect(screen.queryByText("Backlog: 101 pending edits")).not.toBeInTheDocument();
  });

  it("links and highlights a proposed change card in the editor", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    expect(requestAiSuggestion).toHaveBeenCalled();

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalled();
      expect(setReviewHighlight).toHaveBeenCalledWith(expect.anything(), { from: 8, to: 76 });
    });
    await waitFor(() => {
      expect(vi.mocked(setReviewTraces).mock.calls.some(([, traces]) => (
        traces.some((trace) => (
          trace.id === "suggestion-1"
          && trace.status === "pending"
          && trace.replacementText === "This local-first workspace revises DOCX documents with AI."
        ))
      ))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).toHaveClass("located");
    });

    vi.mocked(selectSuggestionTarget).mockClear();
    vi.mocked(setReviewHighlight).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" }));

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalled();
      expect(setReviewHighlight).toHaveBeenCalledWith(expect.anything(), { from: 8, to: 76 });
    });

    fireEvent.click(within(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(addReviewTrace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        id: "suggestion-1-accepted",
        status: "accepted",
        title: "Accepted: Tighten sentence"
      }));
    });
  });

  it("restores the original text and pending status when an accept is undone", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(document.querySelector(".tiptap")?.textContent ?? "").toContain("This local-first workspace revises DOCX documents with AI.");
    });

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo accept" }));

    await waitFor(() => {
      expect(document.querySelector(".tiptap")?.textContent ?? "").toContain("This is a local-first writing workspace for revising DOCX documents with AI.");
    });
    expect(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo accept" })).not.toBeInTheDocument();
  });

  it("applies the edit to the document when accepting with the keyboard shortcut", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));
    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "j" });
    fireEvent.keyDown(document.body, { key: "a" });

    // The keyboard accept must run the same path as the Accept button: the
    // replacement text lands in the document and the accept trace is recorded.
    await waitFor(() => {
      expect(document.querySelector(".tiptap")?.textContent ?? "").toContain("This local-first workspace revises DOCX documents with AI.");
    });
    await waitFor(() => {
      expect(addReviewTrace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        id: "suggestion-1-accepted",
        status: "accepted"
      }));
    });
  });

  it("stays on the edited text after accepting when auto-advance is off", async () => {
    window.localStorage.setItem("nebula-writer-auto-advance-review", "0");
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));
    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "Toggle auto-advance after accept or reject" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    vi.mocked(selectSuggestionTarget).mockClear();
    fireEvent.click(within(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(document.querySelector(".tiptap")?.textContent ?? "").toContain("This local-first workspace revises DOCX documents with AI.");
    });
    expect(selectSuggestionTarget).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("nebula-writer-auto-advance-review")).toBe("1");
  });

  it("rolls back an accept when a collaborator already rejected the suggestion", async () => {
    const { SidecarHttpError } = await vi.importActual<typeof import("../src/sidecarClient")>("../src/sidecarClient");
    vi.mocked(setWriterSuggestionStatus).mockRejectedValueOnce(new SidecarHttpError(
      'Suggestion "Tighten sentence" was already marked rejected by Kathy — refresh before changing it.',
      409,
      { conflict: { id: "suggestion-1", status: "rejected", decidedBy: "Kathy", decidedAt: "2026-06-10T12:00:00.000Z" } }
    ));
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));
    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).getByRole("button", { name: "Accept" }));

    // The optimistic accept applied the text...
    await waitFor(() => {
      expect(document.querySelector(".tiptap")?.textContent ?? "").toContain("This local-first workspace revises DOCX documents with AI.");
    });
    // ...then the conflict rolled it back and adopted Kathy's rejection.
    await waitFor(() => {
      expect(document.querySelector(".tiptap")?.textContent ?? "").toContain("This is a local-first writing workspace for revising DOCX documents with AI.");
    });
    expect(await screen.findByText(/Kathy marked "Tighten sentence" rejected at the same time as you; your applied edit was rolled back/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("surfaces failed suggestion-status syncs with a retry pill", async () => {
    vi.mocked(setWriterSuggestionStatus).mockRejectedValueOnce(new Error("sidecar down"));
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).getByRole("button", { name: "Reject" }));

    const retryPill = await screen.findByRole("button", { name: /1 suggestion decision not synced/ });
    expect(retryPill).toBeInTheDocument();

    vi.mocked(setWriterSuggestionStatus).mockResolvedValueOnce({ session: null });
    fireEvent.click(retryPill);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /not synced/ })).not.toBeInTheDocument();
    });
  });

  it("does not scope the next chat message to a located suggestion's selection", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    // Receiving suggestions auto-locates the first one, which selects its
    // target in the editor. That review selection must arrive detached: the
    // scope stays "Whole document" and no selection chip is attached.
    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Whole document" })).toBeInTheDocument();
    });
    expect(document.querySelector(".selection-chip")).not.toBeInTheDocument();
  });

  it("returns a rejected suggestion to the pending queue with Restore", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).getByRole("button", { name: "Reject" }));

    fireEvent.click(screen.getByRole("tab", { name: "All" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });

  it("leaves proposed change card text selected instead of jumping to the suggestion", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    const replacementText = await screen.findByText("This local-first workspace revises DOCX documents with AI.");
    await waitFor(() => {
      expect(setReviewHighlight).toHaveBeenCalled();
    });
    vi.mocked(selectSuggestionTarget).mockClear();
    vi.mocked(setReviewHighlight).mockClear();

    selectElementText(replacementText);
    fireEvent.mouseDown(replacementText, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.mouseUp(replacementText, { button: 0, clientX: 140, clientY: 20 });
    fireEvent.click(replacementText, { button: 0, clientX: 140, clientY: 20 });

    expect(window.getSelection()?.toString()).toBe("This local-first workspace revises DOCX documents with AI.");
    expect(selectSuggestionTarget).not.toHaveBeenCalled();
    expect(setReviewHighlight).not.toHaveBeenCalled();
  });

  it("uses a plain click on proposed text as a card jump", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    const replacementText = await screen.findByText("This local-first workspace revises DOCX documents with AI.");
    await waitFor(() => {
      expect(setReviewHighlight).toHaveBeenCalled();
    });
    vi.mocked(selectSuggestionTarget).mockClear();
    vi.mocked(setReviewHighlight).mockClear();

    fireEvent.mouseDown(replacementText, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.mouseUp(replacementText, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.click(replacementText, { button: 0, clientX: 20, clientY: 20 });

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalled();
      expect(setReviewHighlight).toHaveBeenCalledWith(expect.anything(), { from: 8, to: 76 });
    });
  });

  it("copies the full proposed replacement text from a suggestion card", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    const suggestionCard = await screen.findByRole("button", { name: "Jump to proposed change: Tighten sentence" });
    await waitFor(() => {
      expect(setReviewHighlight).toHaveBeenCalled();
    });
    vi.mocked(selectSuggestionTarget).mockClear();
    vi.mocked(setReviewHighlight).mockClear();

    fireEvent.click(within(suggestionCard).getByRole("button", { name: "Copy proposed" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("This local-first workspace revises DOCX documents with AI.");
    });
    expect(await screen.findByText("Proposed text copied")).toBeInTheDocument();
    expect(selectSuggestionTarget).not.toHaveBeenCalled();
    expect(setReviewHighlight).not.toHaveBeenCalled();
  });

  it("copies the full visible review packet from the active filter", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "codex",
      message: "Two edits",
      suggestions: [
        {
          id: "suggestion-1",
          title: "Tighten opening",
          original: "This is a local-first writing workspace for revising DOCX documents with AI.",
          replacement: "This local-first workspace revises DOCX documents with AI.",
          rationale: "Tightens the opening sentence.",
          confidence: 0.9,
          target: "global",
          status: "pending"
        },
        {
          id: "suggestion-2",
          title: "Preserve long replacement",
          original: "Codex and Claude Code providers are routed through the local sidecar when CLI execution is enabled.",
          replacement: "Codex and Claude Code run through the local sidecar when enabled, preserving the complete proposed replacement text even when the review packet is long enough that visual selection would be tedious.",
          rationale: "Keeps the whole replacement available for handoff.",
          confidence: 0.86,
          target: "global",
          status: "pending"
        }
      ]
    });
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make this tighter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Preserve long replacement")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy visible edits" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Nebula Writer review edits - Pending (2 edits)"));
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("1. Tighten opening"));
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("2. Preserve long replacement"));
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Proposed:\nCodex and Claude Code run through the local sidecar when enabled, preserving the complete proposed replacement text even when the review packet is long enough that visual selection would be tedious."));
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Rationale:\nKeeps the whole replacement available for handoff."));
    });
    expect(await screen.findByText("Visible edits copied")).toBeInTheDocument();
  });

  it("opens a copy box when the visible review packet cannot be written to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("clipboard blocked")));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false)
    });
    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy visible edits" }));

    expect(await screen.findByRole("region", { name: "Visible edits copy box" })).toBeInTheDocument();
    const packet = screen.getByRole("textbox", { name: "Visible edits packet" }) as HTMLTextAreaElement;
    expect(packet.value).toContain("Nebula Writer review edits - Pending (1 edit)");
    expect(packet.value).toContain("Original:\nThis is a local-first writing workspace for revising DOCX documents with AI.");
    expect(packet.value).toContain("Proposed:\nThis local-first workspace revises DOCX documents with AI.");
    expect(await screen.findByText("Opened copy box for 1 visible edit")).toBeInTheDocument();
  });

  it("leaves editor preview text selected instead of syncing the review card", async () => {
    const { container } = render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    await waitFor(() => {
      expect(setReviewHighlight).toHaveBeenCalled();
    });
    vi.mocked(selectSuggestionTarget).mockClear();
    vi.mocked(setReviewHighlight).mockClear();

    const editorParagraph = container.querySelector(".ProseMirror p");
    if (!editorParagraph) {
      throw new Error("Missing editor paragraph");
    }
    selectElementText(editorParagraph);
    fireEvent.click(editorParagraph, { button: 0, clientX: 160, clientY: 20 });

    expect(window.getSelection()?.toString()).toContain("local-first writing workspace");
    expect(selectSuggestionTarget).not.toHaveBeenCalled();
    expect(setReviewHighlight).not.toHaveBeenCalled();
  });

  it("syncs the proposed-change card when clicking an editor review trace", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
    const { container } = render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    await waitFor(() => {
      expect(setReviewHighlight).toHaveBeenCalled();
    });
    scrollIntoView.mockClear();
    vi.mocked(selectSuggestionTarget).mockClear();
    vi.mocked(setReviewHighlight).mockClear();

    const editorParagraph = container.querySelector(".ProseMirror p");
    if (!editorParagraph) {
      throw new Error("Missing editor paragraph");
    }
    const trace = document.createElement("span");
    trace.dataset.reviewTrace = "suggestion-1";
    trace.className = "review-trace-preview-widget";
    trace.textContent = "This local-first workspace revises DOCX documents with AI.";
    editorParagraph.appendChild(trace);
    const getSelection = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => trace.textContent ?? "",
      anchorNode: trace,
      focusNode: trace,
      rangeCount: 1,
      getRangeAt: () => ({ commonAncestorContainer: trace })
    } as unknown as Selection);
    const editorShell = container.querySelector(".editor-content-shell");
    if (!editorShell) {
      throw new Error("Missing editor shell");
    }

    fireEvent.mouseDown(editorShell, { button: 0, clientX: 160, clientY: 20 });
    fireEvent.click(trace, { button: 0, clientX: 160, clientY: 20 });

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "suggestion-1" }));
      expect(setReviewHighlight).toHaveBeenCalledWith(expect.anything(), { from: 8, to: 76 });
    });
    expect(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).toHaveClass("located");
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "auto" });
    getSelection.mockRestore();
  });

  it("exports accepted editor changes from an imported DOCX as Word review suggestions", async () => {
    const original = "This is a local-first writing workspace for revising DOCX documents with AI.";
    const replacement = "This local-first workspace revises DOCX documents with AI.";
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "tracked-source",
      name: "source.docx",
      html: `<p>${original}</p>`,
      plainText: original,
      messages: [],
      bodySafeAnchors: [original],
      bodySafeAnchorDetails: [{ text: original }],
      features: emptyFeatures
    });
    const { container } = render(<App />);
    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["fake"], "source.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });
    expect(await screen.findByText("Imported source.docx")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));
    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("button", { name: "Jump to proposed change: Tighten sentence" })).getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(screen.getByText(/1 accepted AI edit/)).toBeInTheDocument();
    });
    expect(screen.getByText("1 review export item")).toBeInTheDocument();

    const reviewExportButton = screen.getByRole("button", { name: "Export" });
    expect(reviewExportButton).toBeEnabled();
    fireEvent.click(reviewExportButton);

    await waitFor(() => {
      expect(exportDocx).toHaveBeenCalled();
    });
    const exportRequest = vi.mocked(exportDocx).mock.calls.at(-1)?.[0];
    expect(exportRequest).toMatchObject({
      sourceDocumentId: "tracked-source",
      trackedChanges: true
    });
    expect(exportRequest?.suggestions).toEqual([
      expect.objectContaining({
        id: "suggestion-1-ai-change-review-export",
        title: "Tighten sentence",
        original,
        replacement,
        status: "pending"
      })
    ]);
  });

  it("flags overlong replacement suggestions before review export", async () => {
    const longReplacement = [
      "This body-safe refinement sentence adds a concrete fallback, a go/no-go criterion, and an interpretation plan for reviewer confidence.",
      "It also keeps extending the same replacement instead of splitting the idea across separate anchors, which makes Word placement less reliable."
    ].join(" ");
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "claude",
      message: "One long edit",
      suggestions: [
        {
          id: "suggestion-long",
          title: "Add fallback criteria",
          original: "This ordinary sentence needs a safer revision.",
          replacement: longReplacement,
          rationale: "Adds missing fallback logic.",
          confidence: 0.84,
          target: "global",
          status: "pending"
        }
      ]
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Refine for tracked changes" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Add fallback criteria")).toBeInTheDocument();
    expect(screen.getByText(longReplacement)).toBeInTheDocument();
    expect(screen.getByText("Long replacement")).toBeInTheDocument();
    expect(screen.getByText("Long replacement")).toHaveAttribute("title", expect.stringContaining("under 260 characters"));
  });

  it("steps through pending suggestions from the review queue header", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "codex",
      message: "Two edits",
      suggestions: [
        {
          id: "suggestion-1",
          title: "Tighten opening",
          original: "This is a local-first writing workspace for revising DOCX documents with AI.",
          replacement: "This local-first workspace revises DOCX documents with AI.",
          rationale: "Tightens the opening sentence.",
          confidence: 0.9,
          target: "global",
          status: "pending"
        },
        {
          id: "suggestion-2",
          title: "Shorten provider note",
          original: "Codex and Claude Code providers are routed through the local sidecar when CLI execution is enabled.",
          replacement: "Codex and Claude Code run through the local sidecar when enabled.",
          rationale: "Shortens the provider note.",
          confidence: 0.86,
          target: "global",
          status: "pending"
        }
      ]
    });

    const { container } = render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make this tighter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Shorten provider note")).toBeInTheDocument();
    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "suggestion-1" }));
    });
    expect(screen.getByLabelText("Active pending suggestion 1 of 2")).toHaveTextContent("Suggestion 1 of 2");
    expect(screen.getByLabelText("Active proposed change 1 of 2")).toHaveTextContent("Change 1 / 2");
    expect(screen.getByRole("searchbox", { name: "Search proposed changes" })).toBeInTheDocument();
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });
    scrollIntoView.mockClear();

    vi.mocked(selectSuggestionTarget).mockClear();
    vi.mocked(setReviewHighlight).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next pending suggestion" }));

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "suggestion-2" }));
      expect(setReviewHighlight).toHaveBeenCalledWith(expect.anything(), { from: 8, to: 76 });
    });
    const activeSecondSuggestion = screen.getByRole("button", { name: "Jump to proposed change: Shorten provider note" });
    expect(activeSecondSuggestion).toHaveClass("located");
    expect(activeSecondSuggestion).toHaveAttribute("aria-current", "true");
    await waitFor(() => {
      expect(screen.getByLabelText("Active pending suggestion 2 of 2")).toHaveTextContent("Suggestion 2 of 2");
    });
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });

    vi.mocked(selectSuggestionTarget).mockClear();
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Previous pending suggestion" }));

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "suggestion-1" }));
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Active pending suggestion 1 of 2")).toHaveTextContent("Suggestion 1 of 2");
    });
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });

    vi.mocked(selectSuggestionTarget).mockClear();
    vi.mocked(setReviewHighlight).mockClear();
    const secondSuggestion = screen.getByRole("button", { name: "Jump to proposed change: Shorten provider note" });
    fireEvent.click(within(secondSuggestion).getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "suggestion-1" }));
      expect(setReviewHighlight).toHaveBeenCalledWith(expect.anything(), { from: 8, to: 76 });
    });
    expect(screen.getByRole("button", { name: "Jump to proposed change: Tighten opening" })).toHaveClass("located");
    expect(screen.getByRole("tab", { name: "Pending" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Shorten provider note" })).not.toBeInTheDocument();
    expect(container.querySelector(".suggestion.rejected")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "All" }));

    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    expect(container.querySelector(".suggestion.rejected")).toHaveTextContent("Shorten provider note");

    fireEvent.click(screen.getByRole("tab", { name: "Pending" }));

    expect(container.querySelector(".suggestion.rejected")).not.toBeInTheDocument();
  });

  it("filters and navigates proposed changes from the document navigator", async () => {
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "codex",
      message: "Two edits",
      suggestions: [
        {
          id: "suggestion-1",
          title: "Tighten opening",
          original: "This is a local-first writing workspace for revising DOCX documents with AI.",
          replacement: "This local-first workspace revises DOCX documents with AI.",
          rationale: "Tightens the opening sentence.",
          confidence: 0.9,
          target: "global",
          status: "pending"
        },
        {
          id: "suggestion-2",
          title: "Shorten provider note",
          original: "Codex and Claude Code providers are routed through the local sidecar when CLI execution is enabled.",
          replacement: "Codex and Claude Code run through the local sidecar when enabled.",
          rationale: "Shortens the provider note.",
          confidence: 0.86,
          target: "global",
          status: "pending"
        }
      ]
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make this tighter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Shorten provider note")).toBeInTheDocument();
    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "suggestion-1" }));
    });
    expect(document.querySelector(".editor-content-shell .document-review-navigator")).toBeInTheDocument();

    vi.mocked(selectSuggestionTarget).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next proposed change" }));

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "suggestion-2" }));
    });
    expect(screen.getByLabelText("Active proposed change 2 of 2")).toHaveTextContent("Change 2 / 2");

    const search = screen.getByRole("searchbox", { name: "Search proposed changes" });
    fireEvent.change(search, { target: { value: "opening" } });

    expect(screen.getByText("1 match")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to proposed change: Tighten opening" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Shorten provider note" })).not.toBeInTheDocument();

    vi.mocked(selectSuggestionTarget).mockClear();
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "suggestion-1" }));
    });

    fireEvent.change(search, { target: { value: "not-a-change" } });

    expect(screen.getByText("0 matches")).toBeInTheDocument();
    expect(screen.getByText("No changes match this search.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear proposed change search" }));

    expect(search).toHaveValue("");
    expect(screen.getByRole("button", { name: "Jump to proposed change: Tighten opening" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to proposed change: Shorten provider note" })).toBeInTheDocument();
  });

  it("keeps proposed-change card clicks focused on the editor instead of scrolling the card", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "codex",
      message: "Two edits",
      suggestions: [
        {
          id: "suggestion-1",
          title: "Tighten opening",
          original: "This is a local-first writing workspace for revising DOCX documents with AI.",
          replacement: "This local-first workspace revises DOCX documents with AI.",
          rationale: "Tightens the opening sentence.",
          confidence: 0.9,
          target: "global",
          status: "pending"
        },
        {
          id: "suggestion-2",
          title: "Shorten provider note",
          original: "Codex and Claude Code providers are routed through the local sidecar when CLI execution is enabled.",
          replacement: "Codex and Claude Code run through the local sidecar when enabled.",
          rationale: "Shortens the provider note.",
          confidence: 0.86,
          target: "global",
          status: "pending"
        }
      ]
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make this tighter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Shorten provider note")).toBeInTheDocument();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();
    vi.mocked(selectSuggestionTarget).mockClear();

    const secondSuggestion = screen.getByRole("button", { name: "Jump to proposed change: Shorten provider note" });
    fireEvent.mouseDown(secondSuggestion, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.mouseUp(secondSuggestion, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.click(secondSuggestion, { button: 0, clientX: 20, clientY: 20 });

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "suggestion-2" }));
    });
    expect(secondSuggestion).toHaveClass("located");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("filters the review queue to suggestions from the latest shared routine run", async () => {
    const session: WriterSessionSummary = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      sourceDocument: {
        path: "/tmp/Research_strategy_V3.docx",
        modifiedAt: "2026-06-05T05:38:35.000Z",
        readAt: "2026-06-05T05:39:01.000Z",
        sizeBytes: 16657802
      },
      documentText: "Agent imported grant text. Short duplicated anchor.",
	      documentHtmlLength: 58,
	      features: emptyFeatures,
	      importMessages: [],
	      sourceTrackedChanges: [
	        {
	          author: "Word reviewer",
	          date: "2026-06-04T09:17:43.401Z",
	          kind: "inserted",
	          text: "Previously inserted source revision."
	        },
	        {
	          author: "Word reviewer",
	          date: "2026-06-04T09:19:43.401Z",
	          kind: "deleted",
	          text: "Previously deleted source wording."
	        }
	      ],
	      routineProgress: [],
	      routineRuns: [
        {
          id: "run-latest",
          routineId: "r01-body-safe",
          label: "Body-safe clarity",
          completedAt: "2026-06-04T09:17:43.401Z",
          artifactPath: "/tmp/body-safe.docx",
          sourceDocument: {
            path: "/tmp/Research_strategy_V3.docx",
            modifiedAt: "2026-06-05T05:08:39.000Z",
            readAt: "2026-06-05T05:11:04.726Z",
            sizeBytes: 16623565
          },
          report: {
            totalSuggestions: 2,
            matchedSuggestions: 1,
            matchedSuggestionIds: ["latest-1"],
            matchedSuggestionTitles: ["Latest premise"],
            commentedSuggestions: 1,
            commentedSuggestionIds: ["latest-2"],
            commentedSuggestionReasons: ["Source text already contains a Word comment."],
            commentedSuggestionTitles: ["Latest method"],
            unmatchedSuggestions: 0,
            unmatchedSuggestionIds: [],
            unmatchedSuggestionTitles: []
          }
        },
        {
          id: "run-older",
          routineId: "r01-older-handoff",
          label: "Older handoff",
          completedAt: "2026-06-04T08:17:43.401Z",
          artifactPath: "/tmp/older.docx",
          report: {
            totalSuggestions: 2,
            matchedSuggestions: 2,
            matchedSuggestionIds: ["old-1", "shared-winner-1"],
            matchedSuggestionTitles: ["Older backlog item", "Exported shared winner"],
            commentedSuggestions: 0,
            commentedSuggestionIds: [],
            commentedSuggestionReasons: [],
            commentedSuggestionTitles: [],
            unmatchedSuggestions: 0,
            unmatchedSuggestionIds: [],
            unmatchedSuggestionTitles: []
          }
        }
      ],
      suggestions: [
        {
          id: "minor-1",
          title: "Minor duplicate first",
          original: "Short duplicated anchor.",
          replacement: "Short duplicated anchor with one option.",
          rationale: "Represents a smaller duplicate-anchor group.",
          confidence: 0.79,
          target: "global",
          status: "pending"
        },
        {
          id: "minor-2",
          title: "Minor duplicate second",
          original: "Short duplicated anchor.",
          replacement: "Short duplicated anchor with another option.",
          rationale: "Represents a competing smaller duplicate-anchor group.",
          confidence: 0.78,
          target: "global",
          status: "pending"
        },
        {
          id: "shared-winner-1",
          title: "Exported shared winner",
          original: "Shared exported anchor.",
          replacement: "Shared exported anchor with the exported winner.",
          rationale: "Represents a shared-anchor option already included in a review export.",
          confidence: 0.91,
          target: "global",
          status: "pending"
        },
        {
          id: "shared-alt-1",
          title: "Unexported shared alternative",
          original: "Shared exported anchor.",
          replacement: "Shared exported anchor with an unexported alternative.",
          rationale: "Represents a competing shared-anchor option that can be dismissed after winner export.",
          confidence: 0.83,
          target: "global",
          status: "pending"
        },
        {
          id: "latest-1",
          title: "Latest premise",
          original: "Agent imported grant text.",
          replacement: "Agent imported grant text with clearer premise.",
          rationale: "Clarifies the latest pass premise.",
          confidence: 0.92,
          target: "global",
          status: "pending"
        },
        {
          id: "old-1",
          title: "Older backlog item",
          original: "Agent imported grant text.",
          replacement: "Agent imported grant text with old backlog edit.",
          rationale: "Represents older queued work.",
          confidence: 0.81,
          target: "global",
          status: "pending"
        },
        {
          id: "stale-1",
          title: "Stale anchor",
          original: "Earlier source text that is gone.",
          replacement: "Earlier source text that was refreshed.",
          rationale: "Represents a queued suggestion whose source anchor no longer appears in the active editor.",
          confidence: 0.74,
          target: "global",
          status: "pending"
        },
        {
          id: "latest-2",
          title: "Latest method",
          original: "Agent imported grant text.",
          replacement: "Agent imported grant text with cleaner method.",
          rationale: "Clarifies the latest pass method and asks the PI to verify the citation.",
          confidence: 0.88,
          target: "global",
          status: "pending"
        },
        {
          id: "clean-1",
          title: "Clean review packet item",
          original: "Clean visible anchor.",
          replacement: "Clean visible anchor with reviewer-facing clarity.",
          rationale: "Represents a visible, non-conflicting edit ready for a focused handoff.",
          confidence: 0.94,
          commentOnly: true,
          target: "global",
          status: "pending"
        }
      ],
      pendingSuggestions: 9,
      updatedAt: "2026-06-04T09:17:43.401Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text. Short duplicated anchor. Shared exported anchor. Clean visible anchor.</p>",
        documentHtmlLength: "<p>Agent imported grant text. Short duplicated anchor. Shared exported anchor. Clean visible anchor.</p>".length
      }
    });

    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(screen.queryByText("Latest export: Body-safe clarity (1 tracked change, 1 Word comment, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByText("Earlier export: Older handoff (2 tracked changes, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show 2 cards from export: Body-safe clarity" })).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Active pending suggestion 1 of 9")).toHaveTextContent("Suggestion 1 of 9");
    expect(await screen.findByLabelText("Active proposed change 1 of 8")).toHaveTextContent("Change 1 / 8");
    expect(screen.getByRole("button", { name: "Open Missing target for 1 skipped edit" })).toHaveTextContent("1 skipped");
    expect(screen.getByRole("button", { name: "Jump to proposed change: Older backlog item" })).toBeInTheDocument();
    expect(container.querySelectorAll(".shared-run-disposition.latest")).toHaveLength(2);
    expect(container.querySelectorAll(".shared-run-disposition.recent")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Clean packet" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Priority" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Conflicts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Missing target" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Word comments" })).toBeInTheDocument();
    expect(within(screen.getByRole("tab", { name: "Pending" })).getByText("9")).toHaveClass("review-filter-count");
    expect(within(screen.getByRole("tab", { name: "Priority" })).getByText("8")).toHaveClass("review-filter-count");
    expect(within(screen.getByRole("tab", { name: "Clean packet" })).getByText("1")).toHaveClass("review-filter-count");
    expect(screen.getByRole("tab", { name: "Conflicts" })).toHaveAttribute("title", "Show 7 conflicting edits across 3 shared targets");
    expect(within(screen.getByRole("tab", { name: "Conflicts" })).getByText("3")).toHaveClass("review-filter-count");
	    expect(within(screen.getByRole("tab", { name: "Missing target" })).getByText("1")).toHaveClass("review-filter-count");
	    expect(within(screen.getByRole("tab", { name: "Source revisions" })).getByText("2")).toHaveClass("review-filter-count");
	    expect(within(screen.getByRole("tab", { name: "Latest export" })).getByText("2")).toHaveClass("review-filter-count");
	    expect(within(screen.getByRole("tab", { name: "Word comments" })).getByText("1")).toHaveClass("review-filter-count");
	    expect(within(screen.getByRole("tab", { name: "PI/fact checks" })).getByText("1")).toHaveClass("review-filter-count");
    expect(container.querySelector(".chat-card .source-revision-preview")).toBeNull();
    const sourceRevisionToggle = screen.getByRole("button", { name: "Show source revisions in document pane" });
    expect(sourceRevisionToggle).toHaveTextContent("Source revisions");
    fireEvent.click(sourceRevisionToggle);
    const sourceRevisionPane = screen.getByRole("region", { name: "Source revisions in document pane" });
    expect(sourceRevisionPane).toHaveTextContent("Source revisions from Word");
    expect(sourceRevisionPane).toHaveTextContent("original Word revision markup is preserved");
    expect(sourceRevisionPane).toHaveTextContent("Previously inserted source revision.");
    expect(sourceRevisionPane).toHaveTextContent("Previously deleted source wording.");
    expect(within(sourceRevisionPane).getByLabelText("Active source revision 1 of 2")).toHaveTextContent("Revision 1 / 2");
    expect(within(sourceRevisionPane).getByRole("button", { name: "Focus source revision 1: Inserted" })).toHaveTextContent("Find in text");
    expect(within(sourceRevisionPane).getByRole("button", { name: "Focus source revision 2: Deleted" })).toHaveTextContent("Preview only");
    const sourceRevisionSearch = within(sourceRevisionPane).getByRole("searchbox", { name: "Search source revisions" });
    fireEvent.change(sourceRevisionSearch, { target: { value: "deleted" } });
    expect(within(sourceRevisionPane).getByText("1 match")).toBeInTheDocument();
    expect(within(sourceRevisionPane).queryByRole("button", { name: "Focus source revision 1: Inserted" })).not.toBeInTheDocument();
    expect(within(sourceRevisionPane).getByRole("button", { name: "Focus source revision 2: Deleted" })).toBeInTheDocument();
    fireEvent.keyDown(sourceRevisionSearch, { key: "Enter" });
    expect(within(sourceRevisionPane).getByLabelText("Active source revision 1 of 1")).toHaveTextContent("Revision 1 / 1");
    fireEvent.click(within(sourceRevisionPane).getByRole("button", { name: "Clear source revision search" }));
    expect(within(sourceRevisionPane).getByText("2 revisions")).toBeInTheDocument();
    fireEvent.click(within(sourceRevisionPane).getByRole("button", { name: "Focus source revision 1: Inserted" }));
    await waitFor(() => {
      expect(within(sourceRevisionPane).getByRole("button", { name: "Next source revision" })).not.toBeDisabled();
    });
    fireEvent.click(within(sourceRevisionPane).getByRole("button", { name: "Next source revision" }));
    expect(within(sourceRevisionPane).getByLabelText("Active source revision 2 of 2")).toHaveTextContent("Revision 2 / 2");
    expect(screen.getByRole("tab", { name: "Word comments" })).toHaveAttribute("title", "Show 1 Word-comment edit preserved as Word comments in the latest review export. Comment fallback reasons: 1 existing Word-comment paragraph.");
    expect(within(screen.getByRole("tab", { name: "All" })).getByText("9")).toHaveClass("review-filter-count");
    expect(screen.getByText("Same target 1/3")).toHaveAttribute("title", "Option 1 of 3 for this exact original text. Review competing alternatives before accepting one.");
    expect(screen.getByText("Same target 2/3")).toBeInTheDocument();
    expect(screen.getByText("Same target 3/3")).toBeInTheDocument();
    expect(screen.getAllByText("Same target 1/2")).toHaveLength(2);
    expect(screen.getAllByText("Same target 2/2")).toHaveLength(2);
    expect(container.querySelector(".suggestion-warning.comment-only")).toHaveTextContent("Word comment");
    expect(container.querySelector(".suggestion-warning.comment-only")).toHaveAttribute("title", "Prepared as a Word comment to preserve equations, citation fields, or protected DOCX structure; it will not be applied as a body tracked change automatically.");
	    expect(screen.getAllByText("Missing target").some((element) => (
	      element.getAttribute("title") === "This original text is not visible in the current editor text. The source DOCX may have changed or the suggestion may need a current target before acceptance."
	    ))).toBe(true);
	
	    fireEvent.click(screen.getByRole("tab", { name: "Source revisions" }));
	
	    expect(screen.getByRole("tab", { name: "Source revisions" })).toHaveAttribute("aria-selected", "true");
	    const sourceRevisionStatus = screen.getByRole("status", { name: "Source revision review status" });
	    expect(sourceRevisionStatus).toHaveTextContent("Source revisions from Word");
	    expect(sourceRevisionStatus).toHaveTextContent("main text pane carries their review controls");
	    expect(within(sourceRevisionStatus).getByRole("button", { name: "Source revisions shown in document text" })).toBeDisabled();
	    expect(screen.getByRole("status", { name: "Source revisions use document pane" })).toHaveTextContent("2 source revisions ready in the document pane.");
	    expect(container.querySelector(".chat-card .review-source-revision-list")).toBeNull();
	    expect(screen.getAllByText("Previously inserted source revision.").length).toBeGreaterThanOrEqual(1);
	    expect(screen.getAllByText("Previously deleted source wording.").length).toBeGreaterThanOrEqual(1);
	    expect(screen.queryByRole("button", { name: "Jump to proposed change: Latest premise" })).not.toBeInTheDocument();
	
	    fireEvent.click(screen.getByRole("tab", { name: "Missing target" }));

    expect(screen.getByRole("tab", { name: "Missing target" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Refresh 1 missing target edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss 1 missing target edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to proposed change: Stale anchor" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Latest premise" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Priority" }));

    expect(screen.getByRole("tab", { name: "Priority" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Jump to proposed change: Latest premise" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to proposed change: Latest method" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to proposed change: Stale anchor" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Clean review packet item" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Word comments" }));

    expect(screen.getByRole("status", { name: "Word comment review status" })).toHaveTextContent("Word review: 1 Word comment");
    expect(screen.getByRole("status", { name: "Word comment review status" })).toHaveTextContent("Latest method. Comment fallback reasons: 1 existing Word-comment paragraph.");
    expect(screen.getByRole("status", { name: "Word comment review status" })).toHaveTextContent("Action mix: 1 PI/fact check.");
    expect(screen.getByRole("status", { name: "Word comment review status" })).toHaveTextContent("Review body tracked changes first");
    expect(screen.getByRole("status", { name: "Word comment review status" })).toHaveTextContent("Use the Word comments packet or suggestions artifact for full original/proposed text before manual insertion.");
    expect(screen.getByRole("button", { name: "Jump to proposed change: Latest method" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Latest premise" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "PI/fact checks" }));

    expect(screen.getByRole("tab", { name: "PI/fact checks" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("status", { name: "PI/fact check review status" })).toHaveTextContent("1 PI/fact check");
    expect(screen.getByRole("status", { name: "PI/fact check review status" })).toHaveTextContent("Resolve citation, unit, and placeholder handoffs in Word");
    expect(screen.getByRole("button", { name: "Jump to proposed change: Latest method" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Latest premise" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Missing target" }));

    fireEvent.click(screen.getByRole("button", { name: "Refresh 1 missing target edit" }));

    expect((screen.getByRole("textbox", { name: "AI instruction" }) as HTMLTextAreaElement).value).toContain("Refresh the 1 pending Missing target suggestion");
    expect(screen.getByText("Missing target refresh")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss 1 missing target edit" }));

    await waitFor(() => expect(setWriterSuggestionStatus).toHaveBeenCalledWith("stale-1", "rejected"));
    expect(screen.queryByRole("tab", { name: "Missing target" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Stale anchor" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Clean packet" }));

    expect(screen.getByRole("tab", { name: "Clean packet" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Jump to proposed change: Clean review packet item" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Latest premise" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Latest export" }));

    expect(screen.getByRole("tab", { name: "Latest export" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Active pending suggestion 1 of 2")).toHaveTextContent("Suggestion 1 of 2");
    expect(screen.getByRole("button", { name: "Jump to proposed change: Latest premise" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to proposed change: Latest method" })).toBeInTheDocument();
    expect(container.querySelectorAll(".shared-run-disposition.latest")).toHaveLength(2);
    expect(container.querySelectorAll(".shared-run-disposition.recent")).toHaveLength(0);
    expect(screen.getByText("Same target 1/3")).toBeInTheDocument();
    expect(screen.getByText("Same target 3/3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Older backlog item" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Word comments" }));

    expect(screen.getByRole("tab", { name: "Word comments" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Jump to proposed change: Latest method" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Latest premise" })).not.toBeInTheDocument();
    expect(screen.getByText("Word comment")).toHaveAttribute("title", "This suggestion was preserved as a Word comment. Source text already contains a Word comment.");
    expect(Array.from(container.querySelectorAll(".shared-run-disposition.latest")).some((element) => (
      element.getAttribute("title") === "Preserved as a Word comment in the latest shared review export: Body-safe clarity. Source text already contains a Word comment."
    ))).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "Conflicts" }));

    expect(screen.getByRole("tab", { name: "Conflicts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Active pending suggestion 1 of 7")).toHaveTextContent("Suggestion 1 of 7");
    expect(screen.getByText("3 shared targets with 7 conflicting edits. Select one winner per shared target before the next broad export. Largest shared target: \"Agent imported grant text.\" (3 edits).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss 1 non-winner alternative" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to proposed change: Older backlog item" })).toBeInTheDocument();
    expect(screen.getByText("Same target 1/3")).toBeInTheDocument();
    expect(screen.getByText("Same target 2/3")).toBeInTheDocument();
    expect(screen.getByText("Same target 3/3")).toBeInTheDocument();
    expect(screen.getAllByText("Same target 1/2")).toHaveLength(2);
    expect(screen.getAllByText("Same target 2/2")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Jump to proposed change:/ })[0]).toHaveAttribute("aria-label", "Jump to proposed change: Latest premise");

    vi.mocked(selectSuggestionTarget).mockClear();

    fireEvent.click(screen.getByRole("tab", { name: "Latest export" }));

    fireEvent.click(screen.getByRole("button", { name: "Next pending suggestion" }));

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "latest-1" }));
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Active pending suggestion 1 of 2")).toHaveTextContent("Suggestion 1 of 2");
    });

    vi.mocked(selectSuggestionTarget).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next pending suggestion" }));

    await waitFor(() => {
      expect(selectSuggestionTarget).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "latest-2" }));
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Active pending suggestion 2 of 2")).toHaveTextContent("Suggestion 2 of 2");
    });

    fireEvent.click(screen.getByRole("tab", { name: "Conflicts" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss 1 non-winner alternative" }));
    await waitFor(() => expect(setWriterSuggestionStatus).toHaveBeenCalledWith("shared-alt-1", "rejected"));
  });

  it("does not count same-titled suggestions as Word comments when export IDs are available", async () => {
    const suggestions: AiSuggestion[] = [
      {
        id: "commented-suggestion",
        title: "Duplicate title",
        original: "Protected anchor text.",
        replacement: "Protected anchor text with the exported Word-comment edit.",
        rationale: "Keeps the protected edit available in Word.",
        confidence: 0.88,
        target: "global",
        status: "pending"
      },
      {
        id: "same-title-not-exported",
        title: "Duplicate title",
        original: "Plain anchor text.",
        replacement: "Plain anchor text with a separate same-title edit.",
        rationale: "Represents a same-titled pending suggestion that was not in the export.",
        confidence: 0.82,
        target: "global",
        status: "pending"
      }
    ];
    const session: WriterSessionSummary = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Protected anchor text. Plain anchor text.",
      documentHtmlLength: 42,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: [],
      routineRuns: [
        {
          id: "run-latest",
          routineId: "r01-body-safe",
          label: "Duplicate-title export",
          completedAt: "2026-06-07T09:14:50.559Z",
          artifactPath: "/tmp/duplicate-title.docx",
          report: {
            totalSuggestions: 1,
            matchedSuggestions: 0,
            matchedSuggestionIds: [],
            matchedSuggestionTitles: [],
            commentedSuggestions: 1,
            commentedSuggestionIds: ["commented-suggestion"],
            commentedSuggestionReasons: ["Source text already contains a Word comment."],
            commentedSuggestionTitles: ["Duplicate title"],
            unmatchedSuggestions: 0,
            unmatchedSuggestionIds: [],
            unmatchedSuggestionTitles: []
          }
        }
      ],
      suggestions,
      pendingSuggestions: 2,
      updatedAt: "2026-06-07T09:14:50.559Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Protected anchor text. Plain anchor text.</p>",
        documentHtmlLength: "<p>Protected anchor text. Plain anchor text.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(await screen.findAllByText("Duplicate title")).toHaveLength(2);
    expect(screen.queryByText("Latest export: Duplicate-title export (0 tracked changes, 1 Word comment, 0 unmatched)")).not.toBeInTheDocument();
    expect(within(screen.getByRole("tab", { name: "Word comments" })).getByText("1")).toHaveClass("review-filter-count");

    fireEvent.click(screen.getByRole("tab", { name: "Word comments" }));

    expect(screen.getAllByRole("button", { name: "Jump to proposed change: Duplicate title" })).toHaveLength(1);
    expect(screen.getByText("Protected anchor text with the exported Word-comment edit.")).toBeInTheDocument();
    expect(screen.queryByText("Plain anchor text with a separate same-title edit.")).not.toBeInTheDocument();
  });

  it("sends chat with Shift+Enter and clears the composer immediately", async () => {
    let resolveRequest!: (response: AiResponse) => void;
    vi.mocked(requestAiSuggestion).mockImplementationOnce(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));

    render(<App />);

    const composer = screen.getByLabelText("AI instruction");
    fireEvent.change(composer, {
      target: { value: "Make the opening shorter" }
    });
    expect(screen.getByRole("textbox", { name: "AI instruction" })).toBe(composer);
    expect(screen.getByRole("button", { name: "Send revision request" })).not.toBeDisabled();

    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", shiftKey: true });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", shiftKey: true });

    await waitFor(() => {
      expect(requestAiSuggestion).toHaveBeenCalledWith(expect.objectContaining({
        documentHtml: "",
        instruction: "Make the opening shorter",
        mode: "global"
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
    expect(requestAiSuggestion).toHaveBeenCalledTimes(1);
    expect(composer).toHaveValue("");
    expect(screen.getByText("Document: Make the opening shorter")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Codex is drafting suggestions" })).toBeInTheDocument();

    resolveRequest({
      provider: "codex",
      message: "Ready to review.",
      suggestions: []
    });
    const recoveryState = await screen.findByRole("status", { name: "No reviewable AI suggestions" });
    expect(recoveryState).toHaveTextContent("No DOCX-placeable edits returned.");
    expect(recoveryState).toHaveTextContent("Ready to review.");
    fireEvent.click(screen.getByRole("button", { name: "Refine prompt" }));
    expect(composer).toHaveValue("Pick one exact sentence from the visible document and propose one safe, concrete revision. Original request: Make the opening shorter");
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "No reviewable AI suggestions" })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "Codex is drafting suggestions" })).not.toBeInTheDocument();
    });
  });

  it("turns provider timeouts into a focused retry prompt", async () => {
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "codex",
      message: "The codex CLI could not complete this request: codex timed out after 90s",
      suggestions: []
    });

    render(<App />);

    const composer = screen.getByLabelText("AI instruction");
    fireEvent.change(composer, {
      target: { value: "Make a full R01 pass with as many edits as needed" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    const recoveryState = await screen.findByRole("status", { name: "No reviewable AI suggestions" });
    expect(recoveryState).toHaveTextContent("AI timed out before returning edits.");
    expect(recoveryState).toHaveTextContent("Retry one subsection or 3-8 nearby paragraphs");

    fireEvent.click(screen.getByRole("button", { name: "Retry subsection" }));

    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();
    expect((composer as HTMLTextAreaElement).value).toContain("Split the same request into a subsection-sized retry");
    expect((composer as HTMLTextAreaElement).value).toContain("one Aim/sub-aim or 3-8 nearby paragraphs");
    expect((composer as HTMLTextAreaElement).value).toContain("Original request: Make a full R01 pass with as many edits as needed");
  });

  it("explains when provider suggestions were filtered by safety checks", async () => {
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "codex",
      message: "Clarifies SABV reporting and balance. 1 suggestion was skipped because it was not safely placed, was a no-op, or would drop protected reference/formula text.",
      suggestions: []
    });

    render(<App />);

    const composer = screen.getByLabelText("AI instruction") as HTMLTextAreaElement;
    fireEvent.change(composer, {
      target: { value: "Tighten the SABV sentence" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    const recoveryState = await screen.findByRole("status", { name: "No reviewable AI suggestions" });
    expect(recoveryState).toHaveTextContent("No safe DOCX-placeable edits survived checks.");
    expect(recoveryState).toHaveTextContent("Try a smaller retry using one exact sentence");

    fireEvent.click(screen.getByRole("button", { name: "Retry exact text" }));

    expect(composer.value).toContain("Retry with one exact clean source-text sentence only.");
    expect(composer.value).toContain("replacement must be meaningfully different");
    expect(composer.value).toContain("Original request: Tighten the SABV sentence");
  });

  it("offers the other local provider after a timeout", async () => {
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "claude",
      message: "The claude CLI could not complete this request: claude timed out after 90s",
      suggestions: []
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText("AI provider"), {
      target: { value: "claude" }
    });
    const composer = screen.getByLabelText("AI instruction");
    fireEvent.change(composer, {
      target: { value: "Make a full R01 pass with as many edits as needed" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByRole("button", { name: "Try Codex" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try Codex" }));

    expect(screen.getByLabelText("AI provider")).toHaveValue("codex");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();
    expect((composer as HTMLTextAreaElement).value).toContain("Split the same request into a subsection-sized retry");
  });

  it("loads the R01 review preset into the composer without sending", async () => {
    render(<App />);
    openPromptLibrary();

    expect(screen.getByRole("button", { name: "Show starter skills" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Use document review prompt" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show starter skills" }));
    expect(screen.getByRole("button", { name: "Hide starter skills" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Use document review prompt" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide starter skills" }));
    expect(screen.queryByRole("button", { name: "Use document review prompt" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show starter skills" }));
    expect(screen.queryByRole("button", { name: "Use R01 review prompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show optional grant workflow" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "Research Strategy" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Show optional grant workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Use R01 review prompt" }));

    const composer = screen.getByLabelText("AI instruction");
    expect((composer as HTMLTextAreaElement).value).toContain("NIH R01 study-section grant editor");
    expect((composer as HTMLTextAreaElement).value).toContain("Preserve citation fields, formulas, figure labels");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loaded skill" })).toHaveTextContent("R01 pass");
    expect(screen.getByRole("button", { name: "Send revision request" })).not.toBeDisabled();
    expect(requestAiSuggestion).not.toHaveBeenCalled();
  });

  it("loads focused R01 pass presets into the composer without sending", async () => {
    render(<App />);
    openPromptLibrary();

    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "Research Strategy" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Show optional grant workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Use R01 Significance and Innovation prompt" }));

    const composer = screen.getByLabelText("AI instruction");
    expect((composer as HTMLTextAreaElement).value).toContain("Focus this pass only on the Background/scientific premise, Significance, and Innovation front matter");
    expect((composer as HTMLTextAreaElement).value).toContain('replace undeveloped placeholders such as "Significance. This needs to be developed"');
    expect((composer as HTMLTextAreaElement).value).toContain("strengthen the central premise and developmental model rationale");
    expect((composer as HTMLTextAreaElement).value).toContain("There is no artificial edit-count or sentence-count cap");
    expect((composer as HTMLTextAreaElement).value).toContain("split section-building into several exact-source suggestions");
    expect((composer as HTMLTextAreaElement).value).not.toContain("Prefer one sentence or one short placeholder paragraph");
    expect((composer as HTMLTextAreaElement).value).toContain("Preserve citation fields, formulas, figure labels");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loaded skill" })).toHaveTextContent("Significance");
    expect(within(screen.getByRole("button", { name: "Use R01 Significance and Innovation prompt" })).queryByText(/edits/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use R01 gap triage prompt" })).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "Use R01 gap triage prompt" })).queryByText(/edits/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use R01 Aim alignment prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use R01 aim integration prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use R01 reviewer clarity prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use R01 Approach logic prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use R01 pitfalls and outcomes prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use R01 rigor and milestones prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use R01 body-safe tracked-change prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use R01 Word-comment handoff prompt" })).toBeInTheDocument();
    expect(requestAiSuggestion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Use R01 Aim alignment prompt" }));
    expect((composer as HTMLTextAreaElement).value).toContain("Focus this pass only on Aim-level alignment");
    expect((composer as HTMLTextAreaElement).value).toContain("There is no artificial edit-count cap");
    expect((composer as HTMLTextAreaElement).value).toContain("Prefer unique, specific source-text targets");
    expect((composer as HTMLTextAreaElement).value).toContain("rather than inserting bracketed comments into the replacement");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use R01 aim integration prompt" }));
    expect((composer as HTMLTextAreaElement).value).toContain("Focus this pass only on cross-aim integration and non-duplication");
    expect((composer as HTMLTextAreaElement).value).toContain("There is no artificial edit-count cap");
    expect((composer as HTMLTextAreaElement).value).toContain("move or narrow language that makes two aims appear to test the same thing");
    expect((composer as HTMLTextAreaElement).value).toContain("rather than the replacement");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use R01 reviewer clarity prompt" }));
    expect((composer as HTMLTextAreaElement).value).toContain("Focus this pass only on reviewer-facing clarity");
    expect((composer as HTMLTextAreaElement).value).toContain("There is no artificial edit-count cap");
    expect((composer as HTMLTextAreaElement).value).toContain("when a paragraph-level rewrite is needed");
    expect((composer as HTMLTextAreaElement).value).toContain("rather than the replacement");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use R01 Approach logic prompt" }));
    expect((composer as HTMLTextAreaElement).value).toContain("Focus this pass only on Approach logic and feasibility");
    expect((composer as HTMLTextAreaElement).value).toContain("There is no artificial edit-count cap");
    expect((composer as HTMLTextAreaElement).value).toContain("strengthen model validation and perturbation interpretation");
    expect((composer as HTMLTextAreaElement).value).toContain("Prefer unique, specific source-text targets");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use R01 pitfalls and outcomes prompt" }));
    expect((composer as HTMLTextAreaElement).value).toContain("Return a balanced set of concrete exact-source edits across Aim 1, Aim 2, and Aim 3");
    expect((composer as HTMLTextAreaElement).value).toContain("blank or placeholder expected-results sections");
    expect((composer as HTMLTextAreaElement).value).toContain("replace that source text with a complete reviewer-facing expected-results, limitations, alternatives, and decision-criteria section");
    expect((composer as HTMLTextAreaElement).value).toContain("Spend most effort on the closing outcomes/pitfalls text before re-editing method placeholders");
    expect((composer as HTMLTextAreaElement).value).toContain("blanket no-risk claims");
    expect((composer as HTMLTextAreaElement).value).toContain("There is no artificial edit-count or sentence-count cap");
    expect((composer as HTMLTextAreaElement).value).toContain("when a larger paragraph-level replacement is needed");
    expect((composer as HTMLTextAreaElement).value).not.toContain("Prefer one ordinary body sentence or one short placeholder paragraph");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use R01 rigor and milestones prompt" }));
    expect((composer as HTMLTextAreaElement).value).toContain("Scientific Rigor, Reproducibility and Transparency");
    expect((composer as HTMLTextAreaElement).value).toContain("Sex as a Biological Variable");
    expect((composer as HTMLTextAreaElement).value).toContain("Expected Milestones and Impact");
    expect((composer as HTMLTextAreaElement).value).toContain("no artificial edit-count cap");
    expect((composer as HTMLTextAreaElement).value).toContain("Do not invent unsupported repositories");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use R01 body-safe tracked-change prompt" }));
    expect((composer as HTMLTextAreaElement).value).toContain("tracked-change-safe micro-edit pass");
    expect((composer as HTMLTextAreaElement).value).toContain("ordinary body paragraphs");
    expect((composer as HTMLTextAreaElement).value).toContain("Candidate ordinary body text sampled across the document with approximate locations");
    expect((composer as HTMLTextAreaElement).value).toContain("[~");
    expect((composer as HTMLTextAreaElement).value).toContain("spread returned edits across different source-text targets");
    expect((composer as HTMLTextAreaElement).value).toContain("review the proposed edit before accepting it.");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use R01 Word-comment handoff prompt" }));
    expect((composer as HTMLTextAreaElement).value).toContain("Word-comment handoff pass");
    expect((composer as HTMLTextAreaElement).value).toContain("may export as Word comments rather than body tracked changes");
    expect((composer as HTMLTextAreaElement).value).toContain("poor clean-source coverage");
    expect((composer as HTMLTextAreaElement).value).toContain("lettered sub-aims");
    expect((composer as HTMLTextAreaElement).value).toContain("do not spend all suggestions on the first subsection");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use R01 gap triage prompt" }));
    expect((composer as HTMLTextAreaElement).value).toContain("gap-triage pass");
    expect((composer as HTMLTextAreaElement).value).toContain("submission readiness");
    expect((composer as HTMLTextAreaElement).value).toContain("Return specific exact-source edits/comments only");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();
  });

  it("samples body-safe routine anchors across long documents", () => {
    const opening = "Opening premise sentence explains why single molecule measurements are necessary for reviewers to evaluate the proposed regulatory model.";
    const middleWithFigure = "Middle rationale sentence keeps the figure citation intact (Fig. 1) while describing how preliminary measurements support a feasible R01 workflow.";
    const fillers = Array.from({ length: 12 }, (_, index) => (
      `Filler body sentence ${index + 1} describes an ordinary experimental or computational detail that should remain eligible for safe tracked-change anchoring.`
    ));
    const ending = "Late alternative strategy sentence explains how the team will handle low footprint frequency while preserving reviewer confidence in feasibility.";

    const anchors = bodySafeAnchorCandidates([opening, ...fillers.slice(0, 6), middleWithFigure, ...fillers.slice(6), ending].join(" "));

    expect(anchors).toHaveLength(8);
    expect(anchors[0]).toBe(opening);
    expect(anchors.at(-1)).toBe(ending);
    expect(anchors.some((anchor) => anchor.endsWith("Fig."))).toBe(false);

    const figureAnchors = bodySafeAnchorCandidates([opening, middleWithFigure, ...fillers.slice(0, 5), ending].join(" "));
    expect(figureAnchors).toContain(middleWithFigure);
    expect(figureAnchors.some((anchor) => anchor.endsWith("Fig."))).toBe(false);

    const panelCaption = "(A) Schematic of the labeling reaction (B) Example traces from three replicate runs.";
    expect(bodySafeAnchorCandidates([opening, panelCaption, ...fillers.slice(0, 5), ending].join(" "))).not.toContain(panelCaption);
  });

  it("samples nearby alternate anchors around failed refine spans", () => {
    const before = "Nearby premise sentence explains how reviewers should interpret fallback criteria when a proposed timing assay returns ambiguous single-molecule measurements.";
    const failed = "This protected sentence previously became a Word comment because the exported DOCX could not safely patch the original tracked-change structure.";
    const after = "Nearby validation sentence explains how an orthogonal benchmark will decide whether the kinetic model remains interpretable after perturbation.";
    const far = "Far-away background sentence describes another part of the grant and should be less useful than local alternate anchors for this retry.";

    const candidates = nearbyAlternateAnchorCandidates([far, before, failed, after, far].join(" "), [failed]);

    expect(candidates).toContain(before);
    expect(candidates).toContain(after);
    expect(candidates).not.toContain(failed);
  });

  it("ranks DOCX-verified clean anchors around failed refine spans", () => {
    const far = "Far-away background sentence describes another part of the grant and should be less useful than local clean anchors for this retry.";
    const before = "Nearby clean premise sentence explains how reviewers should interpret fallback criteria when a proposed timing assay returns ambiguous measurements.";
    const failed = "This protected sentence previously became a Word comment because the exported DOCX could not safely patch the original tracked-change structure.";
    const after = "Nearby clean validation sentence explains how an orthogonal benchmark will decide whether the kinetic model remains interpretable after perturbation.";

    const candidates = nearbyDocxVerifiedAnchorCandidates(
      [far, before, failed, after, far].join(" "),
      [failed],
      [far, before, after]
    );

    expect(new Set(candidates.slice(0, 2))).toEqual(new Set([before, after]));
    expect(candidates.at(-1)).toBe(far);
  });

  it("opens supported exports in a Downloads save dialog", async () => {
    const write = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const createWritable = vi.fn(() => Promise.resolve({ close, write }));
    const showSaveFilePicker = vi.fn(() => Promise.resolve({ createWritable }));
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: showSaveFilePicker
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
        startIn: "downloads",
        suggestedName: expect.stringMatching(/^Nebula-Writer-Draft_\d{8}T\d{6}Z_review\.docx$/)
      }));
    });
    expect(showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({
      types: [expect.objectContaining({
        accept: {
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"]
        },
        description: "Word document"
      })]
    }));
    expect(createWritable).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.any(Blob));
    expect(close).toHaveBeenCalled();
  });

  it("steps through the R01 routine sequence", async () => {
    const createObjectUrl = vi.fn(() => "blob:nebula-writer-sequence");
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });

    render(<App />);

    const composer = screen.getByLabelText("AI instruction");
    openPromptLibrary();
    expect(screen.getByText("Starter skills")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load grant preset: Gap triage" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "Research Strategy" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Show optional grant workflow" }));
    const nextRoutineButton = screen.getByRole("button", { name: "Load grant preset: Gap triage" });
    expect(nextRoutineButton).toHaveTextContent("Load Gap triage");
    expect(nextRoutineButton).not.toHaveTextContent("no cap");
    fireEvent.click(nextRoutineButton);

    expect((composer as HTMLTextAreaElement).value).toContain("gap-triage pass");
    expect(screen.getByText("No exports yet")).toBeInTheDocument();
    expect(screen.getByText("Next grant pass")).toBeInTheDocument();
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loaded skill" })).toHaveTextContent("Gap triage");
    expect(screen.getByText("Loaded: Gap triage. Advances after suggestions.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load grant preset: Gap triage" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Routine export handoff" })).toHaveTextContent("Gap triage returned 1 reviewable edit.");
    fireEvent.click(screen.getByRole("button", { name: "Export Gap triage review DOCX" }));
    await waitFor(() => {
      expect(exportDocx).toHaveBeenCalledWith(expect.objectContaining({
        downloadFilename: expect.stringMatching(/^Research-Strategy_Gap-triage_\d{8}T\d{6}Z_review\.docx$/),
        trackedChanges: true
      }));
    });
    expect(screen.queryByRole("status", { name: "Routine export handoff" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Routine export summary" })).toHaveTextContent("Gap triage exported as a review DOCX.");
    expect(screen.getByRole("status", { name: "Routine export summary" })).toHaveTextContent(/File: Research-Strategy_Gap-triage_\d{8}T\d{6}Z_review\.docx/);
    expect(await screen.findByText("1 exported")).toBeInTheDocument();
    expect(screen.getByTitle("Gap triage exported")).toBeInTheDocument();
    expect(setWriterRoutineProgress).toHaveBeenCalledWith(["r01-gap-triage"], expect.anything());
    await waitFor(() => {
      expect(setWriterRoutineRun).toHaveBeenCalledWith(expect.objectContaining({
        artifactPath: null,
        label: "Gap triage",
        report: null,
        routineId: "r01-gap-triage"
      }), expect.anything());
    });
    expect(screen.getByRole("button", { name: "Continue grant path with Significance" })).toBeInTheDocument();
    expect(createObjectUrl).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:nebula-writer-sequence");
    expect(screen.getByRole("button", { name: "Load grant preset: Significance" })).toBeInTheDocument();
    vi.mocked(exportDocx).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Continue grant path with Significance" }));

    expect((composer as HTMLTextAreaElement).value).toContain("Focus this pass only on the Background/scientific premise, Significance, and Innovation front matter");
    expect(screen.getByText("Loaded: Significance. Advances after suggestions.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load grant preset: Significance" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Routine export summary" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset grant path progress" }));

    expect(screen.getByRole("button", { name: "Load grant preset: Gap triage" })).toBeInTheDocument();
    expect(screen.getByText("No exports yet")).toBeInTheDocument();
    expect(screen.queryByText("Loaded: Significance. Advances after suggestions.")).not.toBeInTheDocument();
    click.mockRestore();
  });

  it("records shared R01 routine exports through the session review endpoint", async () => {
    const createObjectUrl = vi.fn(() => "blob:shared-routine-review");
    const revokeObjectUrl = vi.fn();
    const downloadedNames: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedNames.push(this.download);
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });
    const session = {
      id: "shared-docx",
      name: "shared.docx",
      title: "shared",
      sourceDocumentId: "shared-docx",
      documentText: "Shared imported document text.",
      documentHtmlLength: "<p>Shared imported document text.</p>".length,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: [],
      routineRuns: [],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-05-25T10:08:30.429Z"
    };
    const report = {
      commentedSuggestionIds: [],
      commentedSuggestionReasons: [],
      commentedSuggestionTitles: [],
      commentedSuggestions: 0,
      matchedSuggestionIds: ["suggestion-1"],
      matchedSuggestions: 1,
      totalSuggestions: 1,
      unmatchedSuggestionIds: [],
      unmatchedSuggestionTitles: [],
      unmatchedSuggestions: 0
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "shared-docx",
      name: "shared.docx",
      html: "<p>Shared imported document text.</p>",
      plainText: "Shared imported document text.",
      messages: [],
      features: emptyFeatures
    });
    vi.mocked(exportWriterSessionReview).mockResolvedValueOnce({
      artifactPath: "/tmp/shared-review.docx",
      outputPath: "/tmp/shared-review.docx",
      reportPath: "/tmp/shared-review_report.json",
      suggestionsPath: "/tmp/shared-review_suggestions.json",
      report,
      reviewSummary: null,
      reviewPlacements: [],
      routineRun: {
        id: "run-exported",
        routineId: "r01-gap-triage",
        label: "Gap triage",
        completedAt: "2026-05-25T10:08:30.429Z",
        artifactPath: "/tmp/shared-review.docx",
        reportPath: "/tmp/shared-review_report.json",
        suggestionsPath: "/tmp/shared-review_suggestions.json",
        report
      },
      session: {
        ...session,
        routineRuns: [
          {
            id: "run-exported",
            routineId: "r01-gap-triage",
            label: "Gap triage",
            completedAt: "2026-05-25T10:08:30.429Z",
            artifactPath: "/tmp/shared-review.docx",
            reportPath: "/tmp/shared-review_report.json",
            suggestionsPath: "/tmp/shared-review_suggestions.json",
            report
          }
        ]
      }
    });
    vi.mocked(downloadWriterRoutineArtifact).mockResolvedValueOnce({
      blob: new Blob(["artifact"]),
      filename: "shared-review.docx"
    });

    const { container } = render(<App />);
    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["fake"], "shared.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });

    expect(await screen.findByText("Shared imported document text.")).toBeInTheDocument();
    openPromptLibrary();
    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "Research Strategy" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Show optional grant workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Load grant preset: Gap triage" }));
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));
    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    vi.mocked(exportDocx).mockClear();
    vi.mocked(setWriterRoutineRun).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Export Gap triage review DOCX" }));

    await waitFor(() => {
      expect(exportWriterSessionReview).toHaveBeenCalledWith(expect.objectContaining({
        pendingOnly: true,
        suggestions: expect.arrayContaining([
          expect.objectContaining({ id: "suggestion-1" })
        ]),
        routineRun: expect.objectContaining({
          label: "Gap triage",
          routineId: "r01-gap-triage"
        })
      }));
    });
    expect(downloadWriterRoutineArtifact).toHaveBeenCalledWith("run-exported");
    expect(exportDocx).not.toHaveBeenCalled();
    expect(setWriterRoutineRun).not.toHaveBeenCalled();
    expect(screen.queryByText("Latest export: Gap triage (1 tracked change, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Latest export" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("status", { name: "Routine export summary" })).toHaveTextContent("File: shared-review.docx");
    expect(createObjectUrl).toHaveBeenCalled();
    expect(downloadedNames).toContain("shared-review.docx");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:shared-routine-review");
    click.mockRestore();
  });

  it("exports a cumulative shared review carrier from the export menu", async () => {
    const createObjectUrl = vi.fn(() => "blob:cumulative-review");
    const revokeObjectUrl = vi.fn();
    const downloadedNames: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedNames.push(this.download);
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });
    const suggestions: AiSuggestion[] = [
      {
        id: "cumulative-1",
        title: "Clarify cumulative premise",
        original: "Agent imported grant text.",
        replacement: "Agent imported grant text with clearer cumulative premise.",
        rationale: "Carries a prior R01 improvement into the shared review carrier.",
        confidence: 0.92,
        target: "global",
        status: "pending"
      },
      {
        id: "cumulative-2",
        title: "Preserve protected rewrite",
        original: "Protected section text.",
        replacement: "Protected section text with a reviewer-facing rewrite.",
        rationale: "Keeps a protected-section improvement available as a Word comment.",
        confidence: 0.86,
        target: "global",
        status: "pending"
      },
      {
        id: "cumulative-3",
        title: "Preserve equation note",
        original: "Equation-bearing section text.",
        replacement: "Equation-bearing section text with a clearer interpretation note.",
        rationale: "Keeps equation-protected context available as a Word comment.",
        confidence: 0.84,
        target: "global",
        status: "pending"
      }
    ];
    const report = {
      commentedSuggestionIds: ["cumulative-2", "cumulative-3"],
      commentedSuggestionReasons: [
        "Source text is in a paragraph that already contains tracked changes.",
        "Source text is in a paragraph that contains a Word equation/math object, so Nebula preserved the edit as a Word comment instead of rewriting OMML."
      ],
      commentedSuggestionTitles: ["Preserve protected rewrite", "Preserve equation note"],
      commentedSuggestions: 2,
      matchedSuggestionIds: ["cumulative-1"],
      matchedSuggestionTitles: ["Clarify cumulative premise"],
      matchedSuggestions: 1,
      totalSuggestions: 3,
      unmatchedSuggestionIds: [],
      unmatchedSuggestionTitles: [],
      unmatchedSuggestions: 0
    };
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text. Protected section text. Equation-bearing section text.",
      documentHtmlLength: 50,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: [],
      routineRuns: [],
      suggestions,
      pendingSuggestions: suggestions.length,
      updatedAt: "2026-06-07T05:43:47.996Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text. Protected section text.</p>",
        documentHtmlLength: "<p>Agent imported grant text. Protected section text.</p>".length
      }
    });
    vi.mocked(exportWriterSessionReview).mockResolvedValueOnce({
      artifactPath: "/tmp/cumulative-review.docx",
      outputPath: "/tmp/cumulative-review.docx",
      reportPath: "/tmp/cumulative-review_report.json",
      suggestionsPath: "/tmp/cumulative-review_suggestions.json",
      report,
      reviewSummary: null,
      reviewPlacements: [],
      routineRun: {
        id: "run-cumulative",
        routineId: "r01-cumulative-review",
        label: "Current cumulative review",
        completedAt: "2026-06-07T05:44:15.000Z",
        artifactPath: "/tmp/cumulative-review.docx",
        reportPath: "/tmp/cumulative-review_report.json",
        suggestionsPath: "/tmp/cumulative-review_suggestions.json",
        report
      },
      session: {
        ...session,
        routineRuns: [
          {
            id: "run-cumulative",
            routineId: "r01-cumulative-review",
            label: "Current cumulative review",
            completedAt: "2026-06-07T05:44:15.000Z",
            artifactPath: "/tmp/cumulative-review.docx",
            reportPath: "/tmp/cumulative-review_report.json",
            suggestionsPath: "/tmp/cumulative-review_suggestions.json",
            report
          }
        ]
      }
    });
    vi.mocked(downloadWriterRoutineArtifact).mockResolvedValueOnce({
      blob: new Blob(["artifact"]),
      filename: "cumulative-review.docx"
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));
    expect(await screen.findByText("Clarify cumulative premise")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export cumulative review DOCX" }));

    await waitFor(() => {
      expect(exportWriterSessionReview).toHaveBeenCalledWith(expect.objectContaining({
        copyToDownloads: true,
        pendingOnly: true,
        suggestions: expect.arrayContaining([
          expect.objectContaining({ id: "cumulative-1" }),
          expect.objectContaining({ id: "cumulative-2" }),
          expect.objectContaining({ id: "cumulative-3" })
        ]),
        routineRun: expect.objectContaining({
          instruction: "Export all current pending review suggestions as one cumulative source-preserving Word review carrier.",
          label: "Current cumulative review",
          routineId: "r01-cumulative-review"
        })
      }));
    });
    expect(downloadWriterRoutineArtifact).toHaveBeenCalledWith("run-cumulative");
    expect(exportDocx).not.toHaveBeenCalled();
    expect(screen.queryByText("Latest export: Current cumulative review (1 tracked change, 2 Word comments, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Latest export" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Exported review DOCX (1 tracked change; 2 as Word comments)")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Last review export" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Prepared cumulative handoff: 1 body tracked change plus Word comments for Preserve protected rewrite; Preserve equation note\. Comment fallback reasons: 1 existing tracked-change paragraph; 1 equation-protected paragraph\./)).not.toBeInTheDocument();
    expect(downloadedNames).toContain("cumulative-review.docx");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:cumulative-review");
    click.mockRestore();
  });

  it("exports and loads shared Writer session snapshots", async () => {
    const createObjectUrl = vi.fn(() => "blob:session-snapshot");
    const revokeObjectUrl = vi.fn();
    const downloadedNames: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadedNames.push(this.download);
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });
    const session = {
      id: "shared-docx",
      name: "shared.docx",
      title: "shared",
      sourceDocumentId: "shared-docx",
      documentText: "Shared imported document text.",
      documentHtmlLength: "<p>Shared imported document text.</p>".length,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-gap-triage"],
      routineRuns: [],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-06-02T10:08:30.429Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "shared-docx",
      name: "shared.docx",
      html: "<p>Shared imported document text.</p>",
      plainText: "Shared imported document text.",
      messages: [],
      features: emptyFeatures
    });
    vi.mocked(importWriterSessionState).mockResolvedValueOnce({
      session: {
        ...session,
        chatMessages: [
          {
            role: "user",
            content: "Document: restore my proposal chat"
          },
          {
            role: "assistant",
            content: "Restored one proposal-facing edit."
          }
        ],
        documentText: "Restored session text.",
        documentHtml: "<p>Restored session text.</p>",
        documentHtmlLength: "<p>Restored session text.</p>".length,
        suggestions: [
          {
            id: "restored-suggestion",
            title: "Restored suggestion",
            original: "Restored session text.",
            replacement: "Restored sharper session text.",
            rationale: "Restores review queue state from the snapshot.",
            confidence: 0.91,
            target: "global",
            status: "pending"
          }
        ],
        pendingSuggestions: 1
      }
    });

    const { container } = render(<App />);
    const docxInput = container.querySelector('input[accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"]');
    if (!docxInput) {
      throw new Error("Missing DOCX file input");
    }
    fireEvent.change(docxInput, {
      target: {
        files: [new File(["fake"], "shared.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });

    expect(await screen.findByText("Shared imported document text.")).toBeInTheDocument();
    const exportButton = screen.getByRole("button", { name: "Export" });
    await waitFor(() => {
      expect(exportButton).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Export options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export session snapshot" }));

    await waitFor(() => {
      expect(exportWriterSessionState).toHaveBeenCalled();
    });
    expect(downloadedNames).toContain("shared_20260602T010203Z_nebula-session.json");
    expect(createObjectUrl).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:session-snapshot");

    const sessionInput = container.querySelector('input[accept=".json,application/json"]');
    if (!sessionInput) {
      throw new Error("Missing session snapshot file input");
    }
    fireEvent.change(sessionInput, {
      target: {
        files: [new File([JSON.stringify({ version: 1 })], "shared_nebula-session.json", { type: "application/json" })]
      }
    });

    await waitFor(() => {
      expect(importWriterSessionState).toHaveBeenCalled();
    });
    expect((await screen.findAllByText("Restored session text.")).length).toBeGreaterThan(0);
    expect(screen.getByText("Restored suggestion")).toBeInTheDocument();
    expect(screen.getByText("Document: restore my proposal chat")).toBeInTheDocument();
    expect(screen.getByText("Restored one proposal-facing edit.")).toBeInTheDocument();
    click.mockRestore();
  });

  it("saves the current prompt as a reusable preset", async () => {
    render(<App />);

    const composer = screen.getByLabelText("AI instruction");
    openPromptLibrary();
    fireEvent.change(composer, {
      target: { value: "Act as my R01 editor and tighten reviewer-facing topic sentences." }
    });
    expect(screen.getByRole("button", { name: "Show starter skills" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use structure pass prompt" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show starter skills" }));
    expect(screen.getByRole("button", { name: "Use structure pass prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use evidence check prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use tone consistency prompt" })).toBeInTheDocument();
    const savePromptButton = screen.getByRole("button", { name: "Save current skill" });
    expect(savePromptButton).toHaveTextContent("Save current skill");
    // No separate manager: saving reveals an inline name form right here.
    expect(screen.queryByLabelText("Skill name")).not.toBeInTheDocument();
    fireEvent.click(savePromptButton);
    await waitFor(() => {
      expect(screen.getByLabelText("Skill name")).toHaveFocus();
    });
    fireEvent.change(screen.getByLabelText("Skill name"), {
      target: { value: "Reviewer topic pass" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));

    // Form closes; the saved prompt appears as a chip with its own delete.
    expect(screen.queryByLabelText("Skill name")).not.toBeInTheDocument();
    expect(screen.getByText("Saved skills")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use saved skill: Reviewer topic pass" })).toBeInTheDocument();
    expect(window.localStorage.getItem("nebula-writer-routines-v1")).toContain("Reviewer topic pass");

    fireEvent.change(composer, {
      target: { value: "Different prompt" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Use saved skill: Reviewer topic pass" }));

    expect(composer).toHaveValue("Act as my R01 editor and tighten reviewer-facing topic sentences.");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete saved skill: Reviewer topic pass" }));
    expect(screen.queryByRole("button", { name: "Use saved skill: Reviewer topic pass" })).not.toBeInTheDocument();
  });

  it("sends AI requests without a suggestion cap by default", async () => {
    const emptyResponse: AiResponse = {
      provider: "codex",
      message: "No edits",
      suggestions: []
    };
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce(emptyResponse);
    render(<App />);
    // There is no manual cap control; caps come from presets/retry flows and
    // show as a dismissible chip when active.
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the R01 stronger" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    await waitFor(() => {
      expect(requestAiSuggestion).toHaveBeenCalledWith(expect.objectContaining({
        instruction: "Make the R01 stronger",
        maxSuggestions: null
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
  });

  it("lets the user interrupt an in-flight AI request and keep drafting", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(requestAiSuggestion).mockImplementationOnce((_request, options) => new Promise((_, reject) => {
      capturedSignal = options?.signal;
      capturedSignal?.addEventListener("abort", () => {
        const abortError = new Error("The request was aborted.");
        abortError.name = "AbortError";
        reject(abortError);
      });
    }));

    render(<App />);

    const composer = screen.getByLabelText("AI instruction");
    fireEvent.change(composer, {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByRole("button", { name: "Stop AI request" })).not.toBeDisabled();

    fireEvent.change(composer, {
      target: { value: "Actually, focus only on Aim 1" }
    });
    const stopButton = screen.getByRole("button", { name: "Stop AI request" });
    expect(stopButton).toHaveAttribute("aria-keyshortcuts", "Escape");
    fireEvent.keyDown(composer, { key: "Escape", code: "Escape" });

    expect(capturedSignal?.aborted).toBe(true);
    expect(await screen.findByText("Stopped the in-flight AI request. You can revise the prompt and send a new one.")).toBeInTheDocument();
    expect(composer).toHaveValue("Actually, focus only on Aim 1");
    expect(screen.getByRole("button", { name: "Send revision request" })).not.toBeDisabled();
  });

  it("sends a message typed while the AI works into the running turn, or queues it for after", async () => {
    let finish: ((value: Awaited<ReturnType<typeof requestAiSuggestion>>) => void) | undefined;
    vi.mocked(requestAiSuggestion).mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve;
    }));
    vi.mocked(steerAiRun).mockClear();
    vi.mocked(steerAiRun).mockResolvedValueOnce({ ok: true });

    render(<App />);
    const composer = screen.getByLabelText("AI instruction");
    fireEvent.change(composer, { target: { value: "Make the opening shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));
    expect(await screen.findByRole("button", { name: "Stop AI request" })).not.toBeDisabled();
    const runId = vi.mocked(requestAiSuggestion).mock.calls.at(-1)?.[0].runId;
    expect(runId).toMatch(/^run-/);

    // Send: into the running turn.
    fireEvent.change(composer, { target: { value: "Keep the citation" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now, into the running turn" }));
    await waitFor(() => expect(steerAiRun).toHaveBeenCalledWith(runId, "Keep the citation", "sidecar"));
    expect(await screen.findByText(/sent into the running turn/)).toBeInTheDocument();

    // Queue: held for the next turn.
    fireEvent.change(composer, { target: { value: "Then do Aim 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue for after this turn" }));
    expect(screen.getByText(/Queued: "Then do Aim 2"/)).toBeInTheDocument();
    expect(steerAiRun).toHaveBeenCalledTimes(1);

    finish?.({ provider: "codex", message: "Done.", suggestions: [] });
    await waitFor(() => expect(vi.mocked(requestAiSuggestion).mock.calls.at(-1)?.[0].instruction).toBe("Then do Aim 2"));
  });

  it("clears stale AI request errors as soon as the user starts a new prompt", async () => {
    vi.mocked(requestAiSuggestion).mockRejectedValueOnce(new Error("The local provider failed."));

    render(<App />);

    const composer = screen.getByLabelText("AI instruction");
    fireEvent.change(composer, {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText(/The local provider failed\./)).toBeInTheDocument();

    fireEvent.change(composer, {
      target: { value: "Try a narrower edit" }
    });

    expect(screen.queryByText(/The local provider failed\./)).not.toBeInTheDocument();
  });

  it("also sends chat with command/control Enter shortcuts", async () => {
    vi.mocked(requestAiSuggestion)
      .mockResolvedValueOnce({
        provider: "codex",
        message: "First shortcut response.",
        suggestions: []
      })
      .mockResolvedValueOnce({
        provider: "codex",
        message: "Second shortcut response.",
        suggestions: []
      });

    render(<App />);

    const composer = screen.getByLabelText("AI instruction");
    fireEvent.change(composer, {
      target: { value: "Make the opening clearer" }
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", metaKey: true });

    await waitFor(() => {
      expect(requestAiSuggestion).toHaveBeenCalledWith(expect.objectContaining({
        instruction: "Make the opening clearer"
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    vi.mocked(requestAiSuggestion).mockClear();
    fireEvent.change(composer, {
      target: { value: "Make the methods sharper" }
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(requestAiSuggestion).toHaveBeenCalledWith(expect.objectContaining({
        instruction: "Make the methods sharper"
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
  });

  it("keeps Enter available for multiline chat drafts", async () => {
    render(<App />);

    const composer = screen.getByLabelText("AI instruction");
    fireEvent.change(composer, {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    expect(requestAiSuggestion).not.toHaveBeenCalled();
    expect(composer).toHaveValue("Make the opening shorter");
  });

  it("resets chat history and pending suggestions when a DOCX is imported", async () => {
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "fresh-docx",
      name: "fresh.docx",
      html: "<p>Fresh imported document text.</p>",
      plainText: "Fresh imported document text.",
      messages: [],
      bodySafeAnchors: [
        "Aim 2 clean sentence gives reviewers an ordinary tracked-change anchor.",
        "Aim 3 clean sentence gives reviewers another ordinary tracked-change anchor.",
        "Deliver a concrete milestone using high-coverage SMF data across differentiation.",
        "This dataset will be a reusable resource for the wider research community."
      ],
      bodySafeAnchorDetails: [
        {
          section: "Aim 2A. Measure response timing",
          text: "Aim 2 clean sentence gives reviewers an ordinary tracked-change anchor."
        },
        {
          section: "Aim 3. Expected results, limitations and alternative strategies",
          text: "Aim 3 clean sentence gives reviewers another ordinary tracked-change anchor."
        },
        {
          section: "Expected Milestones and Impact",
          text: "Deliver a concrete milestone using high-coverage SMF data across differentiation."
        },
        {
          section: "Expected Milestones and Impact",
          text: "This dataset will be a reusable resource for the wider research community."
        }
      ],
      features: {
        formulas: 1,
        citationFields: 0,
        fields: 0,
        contentControls: 0,
        customXml: 0,
        hyperlinks: 0,
        bookmarks: 0,
        commentRanges: 0,
        notes: 0,
        trackedChanges: 0,
        tables: 0,
        images: 0,
        textBoxes: 0,
        bibliographySections: 0,
        preservationRecommended: false
      }
    });

    const { container } = render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Document: Make the opening shorter")).toBeInTheDocument();
    expect(await screen.findByText("One edit")).toBeInTheDocument();
    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();

    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["fake"], "fresh.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });

    expect(await screen.findByText("Imported fresh.docx")).toBeInTheDocument();
    expect(screen.queryByText("Document: Make the opening shorter")).not.toBeInTheDocument();
    expect(screen.queryByText("One edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Tighten sentence")).not.toBeInTheDocument();
  });

  it("imports source revisions as actionable inline suggestion marks", async () => {
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "revised-docx",
      name: "revised.docx",
      html: "<p>The team will measure swift red fox activity across the lazy dog baseline.</p>",
      plainText: "The team will measure swift red fox activity across the lazy dog baseline.",
      messages: [],
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      features: { ...emptyFeatures, trackedChanges: 2 },
      sourceTrackedChanges: [
        { kind: "inserted", text: "swift red fox", author: "Reviewer" },
        { kind: "deleted", text: " obsolete clause", author: "Reviewer", contextBefore: "across the lazy dog baseline" }
      ]
    });

    const { container } = render(<App />);
    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: { files: [new File(["x"], "revised.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })] }
    });

    // Phase 3 (suggesting-mode design): Word revisions arrive as real,
    // actionable suggestion marks instead of read-only highlights.
    await waitFor(() => {
      expect(container.querySelector(".ProseMirror span[data-suggestion-insertion]")).not.toBeNull();
    });
    expect(container.querySelector(".ProseMirror span[data-suggestion-insertion]")).toHaveTextContent("swift red fox");
    expect(container.querySelector(".ProseMirror span[data-suggestion-insertion]")?.getAttribute("data-author")).toBe("Reviewer");
    expect(container.querySelector(".ProseMirror span[data-suggestion-deletion]")).toHaveTextContent("obsolete clause");
    expect(await screen.findByText(/2 tracked changes from the source DOCX arrived as inline suggestions/)).toBeInTheDocument();
  });

  it("surfaces VERIFY notes as a fact-check handoff prompt", async () => {
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "verify-docx",
      name: "incite.docx",
      html: [
        "<p>Resource request: Aurora; 2,000,000 node-hours per year. [VERIFY final run ledger before submission.]</p>",
        "<p>Publications resulting from prior INCITE awards. [VERIFY]</p>",
        "<p>Core proposal text without a verification note.</p>"
      ].join(""),
      plainText: [
        "Resource request: Aurora; 2,000,000 node-hours per year. [VERIFY final run ledger before submission.]",
        "Publications resulting from prior INCITE awards. [VERIFY]",
        "Core proposal text without a verification note."
      ].join("\n"),
      messages: [],
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      features: emptyFeatures
    });

    const { container } = render(<App />);
    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["fake"], "incite.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });

    expect(await screen.findByText("Resource request: Aurora; 2,000,000 node-hours per year. [VERIFY final run ledger before submission.]")).toBeInTheDocument();
    const factCheckPrompt = screen.getByRole("button", { name: "Load VERIFY fact-check handoff prompt for 2 notes" });
    expect(factCheckPrompt).toHaveTextContent("Fact checks: 2 notes");
    expect(factCheckPrompt.getAttribute("title")).toContain("[VERIFY final run ledger before submission.]");
    fireEvent.click(factCheckPrompt);

    const composer = screen.getByLabelText("AI instruction") as HTMLTextAreaElement;
    expect(composer.value).toContain("focused fact-check handoff pass");
    expect(composer.value).toContain("Set commentOnly true for each suggestion");
    expect(composer.value).toContain("Do not invent missing measurements");
    expect(composer.value).toContain("[VERIFY final run ledger before submission.]");
    expect(composer.value).toContain("[VERIFY]");
    expect(screen.queryByText(/Capped at/)).not.toBeInTheDocument();
  });

  it("surfaces typo-prone clean anchors as a language-polish prompt", async () => {
    const typoAnchors = [
      "We will seperate the treated and control samples before measuring the response.",
      "This dataset will be a reusable resource for the the wider research community.",
      "The role of chromatin state in gene regulation is well established; However, genome wide methods rarely reach single molecule resolution.",
      "Using this data, we will rank candidate variants for follow-up experiments.",
      "While we anticipated that the assay will be widely adopted, the barrier to entry remains high."
    ];
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "language-docx",
      name: "language.docx",
      html: typoAnchors.map((anchor) => `<p>${anchor}</p>`).join(""),
      plainText: typoAnchors.join("\n"),
      messages: [],
      bodySafeAnchors: typoAnchors,
      bodySafeAnchorDetails: [
        {
          section: "Aim 2A. Measure response timing",
          text: typoAnchors[0]
        },
        {
          section: "Expected Milestones and Impact",
          text: typoAnchors[1]
        },
        {
          section: "Expected Milestones and Impact",
          text: typoAnchors[2]
        },
        {
          section: "Aim 3. Expected results, limitations and alternative strategies",
          text: typoAnchors[3]
        },
        {
          section: "Expected Milestones and Impact",
          text: typoAnchors[4]
        }
      ],
      features: emptyFeatures
    });

    const { container } = render(<App />);
    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["fake"], "language.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });

    expect(await screen.findByText(typoAnchors[1])).toBeInTheDocument();
    const languagePrompt = screen.getByRole("button", { name: "Load clean-source language polish prompt" });
    expect(languagePrompt).toHaveTextContent("Language polish: 5 samples");
    expect(languagePrompt).toHaveAttribute("title", expect.stringContaining("spelling: common misspelling"));
    expect(languagePrompt).toHaveAttribute("title", expect.stringContaining("repeated word"));
    expect(languagePrompt).toHaveAttribute("title", expect.stringContaining("capitalization: however after semicolon"));
    expect(languagePrompt).toHaveAttribute("title", expect.stringContaining("hyphenation: single-molecule"));
    fireEvent.click(languagePrompt);

    const composer = screen.getByLabelText("AI instruction") as HTMLTextAreaElement;
    expect(composer.value).toContain("narrow language-polish pass");
    expect(composer.value).toContain("fix spelling, hyphenation, capitalization, tense consistency, plural agreement, article agreement, usage, word choice, or awkward grammar only");
    expect(composer.value).toContain("Use the potential issue labels as the primary target");
    expect(composer.value).toContain("only adjust adjacent punctuation when required for the labeled fix");
    expect(composer.value).toContain("Potential issue: spelling: common misspelling");
    expect(composer.value).toContain("Potential issue: repeated word");
    expect(composer.value).toContain("Potential issue: capitalization: however after semicolon; hyphenation: single-molecule; hyphenation: genome-wide");
    expect(composer.value).toContain("Potential issue: usage: these data");
    expect(composer.value).toContain("Potential issue: tense consistency: anticipate");
    expect(composer.value).toContain(typoAnchors[0]);
    expect(composer.value).toContain(typoAnchors[1]);
    expect(composer.value).toContain(typoAnchors[2]);
    expect(composer.value).toContain(typoAnchors[3]);
    expect(composer.value).toContain(typoAnchors[4]);
    expect(screen.getByText("Capped at 3 edits per request")).toBeInTheDocument();
  });

  it("loads a DOCX opened by the shared Writer sidecar", async () => {
    const session = {
      bodySafeAnchors: [
        "This body paragraph explains why the proposed chromosome-scale methylation workflow is feasible for reviewers and identifies how preliminary capture data support the R01 premise."
      ],
      bodySafeAnchorDetails: [
        {
          section: "Approach",
          text: "This body paragraph explains why the proposed chromosome-scale methylation workflow is feasible for reviewers and identifies how preliminary capture data support the R01 premise."
        }
      ],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text.",
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-05-23T23:19:33.106Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text.</p>",
        documentHtmlLength: "<p>Agent imported grant text.</p>".length
      }
    });

    render(<App />);

    expect(await screen.findByTestId("load-shared-session")).toHaveAccessibleName("Load shared Writer session: agent.docx");
    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    await waitFor(() => {
      expect(getWriterSessionDocument).toHaveBeenCalled();
    });
    expect(await screen.findByText("Agent imported grant text.")).toBeInTheDocument();
    expect(screen.getByLabelText("Document title")).toHaveValue("Agent Grant");
    expect(screen.getByText("Loaded agent.docx from the shared Writer session. AI chat reset for this document.")).toBeInTheDocument();
  });

  it("keeps clean source-text samples out of the visible review UI", async () => {
    const coveredAnchor = "Aim 3 clean sentence gives reviewers an ordinary tracked-change anchor for the next safe edit.";
    const unusedAnchor = "Aim 3 second clean sentence remains available for another safe reviewer-facing edit.";
    const suggestion: AiSuggestion = {
      id: "covered-anchor-edit",
      title: "Clarify covered anchor",
      original: coveredAnchor,
      replacement: "Aim 3 clean sentence gives reviewers a clearer tracked-change anchor for the next safe edit.",
      rationale: "Covers the first clean anchor.",
      confidence: 0.92,
      target: "global",
      status: "pending"
    };
    const session = {
      bodySafeAnchors: [coveredAnchor, unusedAnchor],
      bodySafeAnchorDetails: [
        {
          section: "Aim 3. Expected results, limitations and alternative strategies",
          text: coveredAnchor
        },
        {
          section: "Aim 3. Expected results, limitations and alternative strategies",
          text: unusedAnchor
        }
      ],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: `${coveredAnchor} ${unusedAnchor}`,
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      suggestions: [suggestion],
      pendingSuggestions: 1,
      updatedAt: "2026-05-23T23:19:33.106Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: `<p>${coveredAnchor}</p><p>${unusedAnchor}</p>`,
        documentHtmlLength: `<p>${coveredAnchor}</p><p>${unusedAnchor}</p>`.length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(screen.queryByRole("group", { name: "Clean body anchor map" })).not.toBeInTheDocument();
  });

  it("does not show a covered clean source-text map when every sample already has a pending suggestion", async () => {
    const firstAnchor = "Aim 3 clean sentence gives reviewers an ordinary tracked-change anchor for the next safe edit.";
    const secondAnchor = "Aim 3 second clean sentence remains available for another safe reviewer-facing edit.";
    const suggestions: AiSuggestion[] = [
      {
        id: "covered-anchor-edit",
        title: "Clarify covered anchor",
        original: firstAnchor,
        replacement: "Aim 3 clean sentence gives reviewers a clearer tracked-change anchor for the next safe edit.",
        rationale: "Covers the first clean anchor.",
        confidence: 0.92,
        target: "global",
        status: "pending"
      },
      {
        id: "second-covered-anchor-edit",
        title: "Clarify second covered anchor",
        original: secondAnchor,
        replacement: "Aim 3 second clean sentence remains covered by another safe reviewer-facing edit.",
        rationale: "Covers the second clean anchor.",
        confidence: 0.91,
        target: "global",
        status: "pending"
      }
    ];
    const session = {
      bodySafeAnchors: [firstAnchor, secondAnchor],
      bodySafeAnchorDetails: [
        {
          section: "Aim 3. Expected results, limitations and alternative strategies",
          text: firstAnchor
        },
        {
          section: "Aim 3. Expected results, limitations and alternative strategies",
          text: secondAnchor
        }
      ],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: `${firstAnchor} ${secondAnchor}`,
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      suggestions,
      pendingSuggestions: 2,
      updatedAt: "2026-05-23T23:19:33.106Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: `<p>${firstAnchor}</p><p>${secondAnchor}</p>`,
        documentHtmlLength: `<p>${firstAnchor}</p><p>${secondAnchor}</p>`.length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(screen.queryByRole("group", { name: "Clean body anchor map" })).not.toBeInTheDocument();
  });

  it("refreshes the shared Writer session when the app regains focus", async () => {
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text.",
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-05-23T23:19:33.106Z"
    };
    vi.mocked(getWriterSession)
      .mockResolvedValueOnce({ session: null })
      .mockResolvedValueOnce({ session });

    render(<App />);

    await waitFor(() => expect(getWriterSession).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("load-shared-session")).not.toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));

    expect(await screen.findByTestId("load-shared-session")).toHaveAccessibleName("Load shared Writer session: agent.docx");
  });

  it("joins a document room when a #doc= link is pasted into an open tab", async () => {
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "pasted-doc",
      name: "pasted.docx",
      title: "Pasted Document",
      sourceDocumentId: "pasted-doc",
      documentText: "Pasted shared document text.",
      documentHtml: "<p>Pasted shared document text.</p>",
      documentHtmlLength: "<p>Pasted shared document text.</p>".length,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: [],
      routineRuns: [],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-06-11T00:00:00.000Z"
    };
    vi.mocked(getWriterSessionDocument).mockResolvedValue({ session });

    render(<App />);
    expect(await screen.findByText(/local-first writing workspace/)).toBeInTheDocument();

    // Simulate pasting the share link into the address bar of this open tab.
    window.location.hash = "#doc=pasted-doc";
    window.dispatchEvent(new Event("hashchange"));

    expect(await screen.findByText("Pasted shared document text.")).toBeInTheDocument();
    expect(screen.getByLabelText("Document title")).toHaveValue("Pasted Document");
    expect(vi.mocked(getWriterSessionDocument)).toHaveBeenCalledWith("pasted-doc");
  });

  it("joins an active R01 shared session via the explicit pill", async () => {
    const suggestion: AiSuggestion = {
      id: "r01-front-edit",
      title: "Clarify central premise",
      original: "Old premise sentence.",
      replacement: "Clearer premise sentence.",
      rationale: "Improves reviewer-facing framing.",
      confidence: 0.91,
      target: "global",
      status: "pending"
    };
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "r01-docx",
      name: "Research_strategy_V3.docx",
      title: "Research Strategy",
      sourceDocumentId: "r01-docx",
      documentText: "Current R01 text.",
      documentHtmlLength: 19,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-front-significance-framing"],
      routineRuns: [{
        id: "r01-cumulative-current-20260608T0149",
        routineId: "r01-cumulative-current",
        label: "Current cumulative review",
        completedAt: "2026-06-05T04:35:05.338Z"
      }],
      suggestions: [suggestion],
      pendingSuggestions: 1,
      updatedAt: "2026-06-05T04:35:05.338Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Current R01 text.</p>",
        documentHtmlLength: "<p>Current R01 text.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: Research_strategy_V3.docx" }));

    expect(await screen.findByText("Current R01 text.")).toBeInTheDocument();
    expect(getWriterSessionDocument).toHaveBeenCalled();
    expect(screen.getByLabelText("Document title")).toHaveValue("Research Strategy");
    expect(screen.getByText("Loaded Research_strategy_V3.docx from the shared Writer session. AI chat reset for this document.")).toBeInTheDocument();
    expect(screen.getByText("Clarify central premise")).toBeInTheDocument();
  });

  it("auto-syncs same-document shared suggestion additions after joining", async () => {
    const firstSuggestion: AiSuggestion = {
      id: "shared-edit-1",
      title: "First shared edit",
      original: "Current proposal text.",
      replacement: "Current proposal text with clearer framing.",
      rationale: "Initial agent edit.",
      confidence: 0.9,
      target: "global",
      status: "pending"
    };
    const secondSuggestion: AiSuggestion = {
      id: "shared-edit-2",
      title: "Second shared edit",
      original: "Current proposal text.",
      replacement: "Current proposal text with a measurable milestone.",
      rationale: "Agent added another reviewable edit after the page loaded.",
      confidence: 0.88,
      target: "global",
      status: "pending"
    };
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "incite-docx",
      name: "INCITE_Regulatory_Code_Major_Revision_v5_strong_scaling.docx",
      title: "INCITE Proposal",
      sourceDocumentId: "incite-docx",
      documentText: "Current proposal text.",
      documentHtmlLength: 24,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: [],
      routineRuns: [],
      suggestions: [firstSuggestion],
      pendingSuggestions: 1,
      updatedAt: "2026-06-08T20:20:00.000Z"
    };
    const updatedSession = {
      ...session,
      suggestions: [secondSuggestion, firstSuggestion],
      pendingSuggestions: 2,
      updatedAt: "2026-06-08T20:21:00.000Z"
    };
    vi.mocked(getWriterSession)
      .mockResolvedValueOnce({ session })
      .mockResolvedValueOnce({ session: updatedSession });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Current proposal text.</p>",
        documentHtmlLength: "<p>Current proposal text.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: INCITE_Regulatory_Code_Major_Revision_v5_strong_scaling.docx" }));

    expect(await screen.findByText("First shared edit")).toBeInTheDocument();
    expect(screen.queryByText("Second shared edit")).not.toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));

    expect(await screen.findByText("Second shared edit")).toBeInTheDocument();
    expect(screen.getByText("Synced 2 agent suggestions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync 1 agent suggestion" })).not.toBeInTheDocument();
  });

  it("joins an active proposal shared session with saved chat via the explicit pill", async () => {
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      chatMessages: [
        {
          role: "user" as const,
          content: "Make the INCITE proposal sound like a flagship DOE project."
        },
        {
          role: "assistant" as const,
          content: "Framing strengthened around flagship DOE-scale agentic discovery."
        }
      ],
      id: "incite-docx",
      name: "INCITE_Regulatory_Code_Major_Revision_v5_strong_scaling.docx",
      title: "INCITE_Regulatory_Code_Major_Revision_v5_strong_scaling",
      sourceDocumentId: "incite-docx",
      documentText: "Current INCITE proposal text.",
      documentHtmlLength: 29,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: [],
      routineRuns: [],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-06-08T19:21:00.000Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Current INCITE proposal text.</p>",
        documentHtmlLength: "<p>Current INCITE proposal text.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: INCITE_Regulatory_Code_Major_Revision_v5_strong_scaling.docx" }));

    expect(await screen.findByText("Current INCITE proposal text.")).toBeInTheDocument();
    expect(getWriterSessionDocument).toHaveBeenCalled();
    expect(screen.getByLabelText("Document title")).toHaveValue("INCITE_Regulatory_Code_Major_Revision_v5_strong_scaling");
    expect(screen.getByText("Make the INCITE proposal sound like a flagship DOE project.")).toBeInTheDocument();
    expect(screen.getByText("Framing strengthened around flagship DOE-scale agentic discovery.")).toBeInTheDocument();
    expect(screen.queryByTestId("load-shared-session")).not.toBeInTheDocument();
  });

  it("flags pending shared suggestions whose anchors are no longer visible", async () => {
    const staleSuggestion: AiSuggestion = {
      id: "stale-anchor",
      title: "Old placeholder cleanup",
      original: "Old placeholder text that was accepted in Word.",
      replacement: "Cleaner current grant text.",
      rationale: "Represents a suggestion restored from an older source snapshot.",
      confidence: 0.84,
      target: "global",
      status: "pending"
    };
    const session: WriterSessionSummary = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "refreshed-docx",
      name: "refreshed.docx",
      title: "Refreshed Grant",
      sourceDocumentId: "refreshed-docx",
      documentText: "Current refreshed grant text.",
      documentHtmlLength: 36,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: [],
      routineRuns: [],
      suggestions: [staleSuggestion],
      pendingSuggestions: 1,
      updatedAt: "2026-06-05T02:35:05.060Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Current refreshed grant text.</p>",
        documentHtmlLength: "<p>Current refreshed grant text.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: refreshed.docx" }));

    expect(await screen.findByRole("tab", { name: "Missing target" })).toBeInTheDocument();
    expect(screen.getAllByText("Missing target").some((element) => (
      element.getAttribute("title") === "This original text is not visible in the current editor text. The source DOCX may have changed or the suggestion may need a current target before acceptance."
    ))).toBe(true);
  });

  it("does not count review-carrier Word comments as missing target blockers", async () => {
    const staleSuggestion: AiSuggestion = {
      id: "stale-anchor",
      title: "Old placeholder cleanup",
      original: "Old placeholder text that is gone.",
      replacement: "Cleaner current grant text.",
      rationale: "Represents a suggestion restored from an older source snapshot.",
      confidence: 0.84,
      target: "global",
      status: "pending"
    };
    const representedSuggestion: AiSuggestion = {
      id: "represented-anchor",
      title: "Represented equation comment",
      original: "Equation paragraph text hidden by the editor view.",
      replacement: "Please preserve the equation and clarify the nearby interpretation in Word.",
      rationale: "The latest review DOCX already carries this as a Word comment.",
      confidence: 0.9,
      target: "global",
      status: "pending"
    };
    const session: WriterSessionSummary = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "refreshed-docx",
      name: "refreshed.docx",
      title: "Refreshed Grant",
      sourceDocumentId: "refreshed-docx",
      documentText: "Current refreshed grant text.",
      documentHtmlLength: 36,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: [],
      routineRuns: [{
        id: "run-word-comment",
        routineId: "r01-equation-handoff",
        label: "Aim 3C equation handoff",
        completedAt: "2026-06-07T11:15:19.725Z",
        artifactPath: "/tmp/aim3c-equation-review.docx",
        report: {
          totalSuggestions: 1,
          matchedSuggestions: 0,
          matchedSuggestionIds: [],
          matchedSuggestionTitles: [],
          commentedSuggestions: 1,
          commentedSuggestionIds: ["represented-anchor"],
          commentedSuggestionReasons: ["Source text is in a paragraph that contains a Word equation/math object."],
          commentedSuggestionTitles: ["Represented equation comment"],
          unmatchedSuggestions: 0,
          unmatchedSuggestionIds: [],
          unmatchedSuggestionTitles: []
        }
      }],
      suggestions: [staleSuggestion, representedSuggestion],
      pendingSuggestions: 2,
      updatedAt: "2026-06-07T11:15:19.725Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Current refreshed grant text.</p>",
        documentHtmlLength: "<p>Current refreshed grant text.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: refreshed.docx" }));

    const missingTargetTab = await screen.findByRole("tab", { name: "Missing target" });
    expect(within(missingTargetTab).getByText("1")).toHaveClass("review-filter-count");
    expect(within(screen.getByRole("tab", { name: "Word comments" })).getByText("1")).toHaveClass("review-filter-count");
    expect(within(screen.getByRole("button", { name: "Jump to proposed change: Represented equation comment" })).queryByText("Missing target")).not.toBeInTheDocument();

    fireEvent.click(missingTargetTab);

    expect(screen.getByRole("button", { name: "Jump to proposed change: Old placeholder cleanup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Jump to proposed change: Represented equation comment" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh 1 missing target edit" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Word comments" }));
    const representedCard = screen.getByRole("button", { name: "Jump to proposed change: Represented equation comment" });
    fireEvent.click(within(representedCard).getByRole("button", { name: "Accept" }));

    const refreshedMissingTargetTab = screen.getByRole("tab", { name: "Missing target" });
    expect(refreshedMissingTargetTab).toHaveAttribute("aria-selected", "true");
    expect(within(refreshedMissingTargetTab).getByText("2")).toHaveClass("review-filter-count");
    expect(screen.getByRole("button", { name: "Refresh 2 missing target edits" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jump to proposed change: Represented equation comment" })).toHaveTextContent("Missing target");
    expect(screen.getByText(/I could not find that original text in the current editor/)).toBeInTheDocument();
  });

  it("treats intentional Word-comment handoff runs as successful review carriers", async () => {
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text.",
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: [],
      routineRuns: [
        {
          id: "run-word-review",
          routineId: "r01-word-comment-handoff",
          label: "Aim 2 Word-comment handoff",
          completedAt: "2026-05-25T14:39:09.493Z",
          artifactPath: "/tmp/aim2-word-review.docx",
          report: {
            totalSuggestions: 6,
            matchedSuggestions: 1,
            commentedSuggestions: 5,
            commentedSuggestionReasons: [
              "Source text is in a paragraph that already contains tracked changes, so Nebula preserved the edit as a Word comment."
            ],
            commentedSuggestionTitles: ["Clarify generative model", "Define response metrics"],
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-05-25T14:39:09.493Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text.</p>",
        documentHtmlLength: "<p>Agent imported grant text.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(await screen.findByText("Agent imported grant text.")).toBeInTheDocument();
    expect(screen.queryByText("Latest export: Aim 2 Word-comment handoff (1 tracked change, 5 Word comments, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByText("Word review")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refine run for tracked changes: Aim 2 Word-comment handoff" })).not.toBeInTheDocument();
  });

  it("restores R01 routine progress for the active shared DOCX", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const createObjectUrl = vi.fn(() => "blob:writer-artifact");
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });
    const session = {
      bodySafeAnchors: [
        "This body paragraph explains why the proposed chromosome-scale methylation workflow is feasible for reviewers and identifies how preliminary capture data support the R01 premise."
      ],
      bodySafeAnchorDetails: [
        {
          section: "Approach",
          text: "This body paragraph explains why the proposed chromosome-scale methylation workflow is feasible for reviewers and identifies how preliminary capture data support the R01 premise."
        }
      ],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text. This body paragraph explains why the proposed chromosome-scale methylation workflow is feasible for reviewers and identifies how preliminary capture data support the R01 premise.",
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-significance"],
      routineRuns: [
        {
          id: "run-0",
          routineId: "current-consolidated-r01-handoff",
          label: "Current consolidated R01 handoff",
          completedAt: "2026-05-24T21:03:17.364Z",
          artifactPath: "/tmp/consolidated.docx",
          report: {
            totalSuggestions: 145,
            matchedSuggestions: 44,
            commentedSuggestions: 101,
            commentedSuggestionReasonCounts: [
              { count: 64, reason: "Source text is in a paragraph that already contains tracked changes." },
              { count: 37, reason: "Source text is in a paragraph that already contains Word comments." },
              { count: 15, reason: "Suggestion was marked comment-only for Word handoff, so Nebula preserved it as a Word comment." },
              { count: 8, reason: "Source text is in a paragraph that contains a Word equation/math object, so Nebula preserved the edit as a Word comment instead of rewriting OMML." },
              { count: 4, reason: "Source text is in a paragraph that also contains preserved DOCX media, so Nebula preserved the edit as a Word comment." },
              { count: 1, reason: "Could not find safe body source text for tracked changes; added to the review comments appendix." }
            ],
            commentedSuggestionTitles: ["Strengthen transition", "Clarify modeling premise"],
            unmatchedSuggestions: 0
          }
        },
        {
          id: "run-1",
          routineId: "r01-significance",
          label: "Significance",
          completedAt: "2026-05-23T23:19:33.106Z",
          artifactPath: "/tmp/significance.docx",
          instruction: "Original Significance prompt for editing.",
          reportPath: "/tmp/significance_report.json",
          suggestionsPath: "/tmp/significance_suggestions.json",
	          report: {
	            totalSuggestions: 5,
	            matchedSuggestions: 4,
		            commentedSuggestions: 1,
		            commentedSuggestionIds: ["synced-run-suggestion"],
		            commentedSuggestionOriginals: ["This protected premise sentence became a Word comment."],
		            commentedSuggestionReasons: ["Source text is in protected text."],
		            commentedSuggestionTitles: ["Protected premise"],
		            unmatchedSuggestions: 0
		          }
        },
        {
          id: "run-2",
          routineId: "r01-aims",
          label: "Aims",
          completedAt: "2026-05-23T22:19:33.106Z",
          artifactPath: "/tmp/aims.docx",
          report: {
            totalSuggestions: 4,
            matchedSuggestions: 3,
            commentedSuggestions: 0,
            unmatchedSuggestions: 1,
            unmatchedSuggestionTitles: ["Missing aim transition"]
          }
        },
        {
          id: "run-3",
          routineId: "r01-gap-triage",
          label: "Gap triage",
          completedAt: "2026-05-23T21:19:33.106Z",
          artifactPath: "/tmp/gap-triage.docx",
          report: {
            totalSuggestions: 6,
            matchedSuggestions: 6,
            commentedSuggestions: 0,
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-05-23T23:19:33.106Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text. This body paragraph explains why the proposed chromosome-scale methylation workflow is feasible for reviewers and identifies how preliminary capture data support the R01 premise.</p>",
        documentHtmlLength: "<p>Agent imported grant text. This body paragraph explains why the proposed chromosome-scale methylation workflow is feasible for reviewers and identifies how preliminary capture data support the R01 premise.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(await screen.findByText(/chromosome-scale methylation workflow/)).toBeInTheDocument();
    expect(screen.queryByText("1 exported")).not.toBeInTheDocument();
    expect(screen.queryByText("Review exports")).not.toBeInTheDocument();
    expect(screen.queryByText("Latest export: Current consolidated R01 handoff (44 tracked changes, 101 Word comments, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync suggestions from run: Significance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download artifact: significance.docx" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("nebula-writer-r01-progress-v1")).toContain("r01-significance");

    openPromptLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Show optional grant workflow" }));
    expect(screen.getByText("1 exported")).toBeInTheDocument();
    expect(screen.getByTitle("Significance exported")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset grant path progress" }));

    expect(screen.getByText("No exports yet")).toBeInTheDocument();
    expect(setWriterRoutineProgress).toHaveBeenCalledWith([], expect.anything());
    expect(window.localStorage.getItem("nebula-writer-r01-progress-v1")).toBe("{}");
    click.mockRestore();
  });

  it("flags thin shared routine runs so clean export is not mistaken for coverage", async () => {
    const session = {
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text with one small pitfalls edit.",
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-pitfalls"],
      routineRuns: [
        {
          id: "run-thin",
          routineId: "r01-pitfalls",
          label: "Pitfalls",
          completedAt: "2026-05-25T03:38:23.725Z",
          artifactPath: "/tmp/pitfalls.docx",
	          report: {
	            totalSuggestions: 1,
	            matchedSuggestions: 1,
	            matchedSuggestionTitles: ["Sharpen pitfalls payoff"],
	            commentedSuggestions: 0,
	            unmatchedSuggestions: 0
	          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-05-25T03:38:23.725Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text with one small pitfalls edit.</p>",
        documentHtmlLength: "<p>Agent imported grant text with one small pitfalls edit.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

	    expect(await screen.findByText("Agent imported grant text with one small pitfalls edit.")).toBeInTheDocument();
	    expect(screen.queryByText("Latest export: Pitfalls (1 tracked change, 0 unmatched)")).not.toBeInTheDocument();
	  });

  it("summarizes multi-edit all-tracked runs with matched titles", async () => {
    const session = {
      id: "agent-docx",
      name: "Research_strategy_V3.docx",
      title: "Research Strategy",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text with tracked body-safe cleanup edits.",
      documentHtmlLength: 62,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-body-safe-language-cleanup"],
      routineRuns: [
        {
          id: "run-body-safe-cleanup",
          routineId: "r01-body-safe-language-cleanup",
          label: "Body-safe language cleanup",
          completedAt: "2026-06-04T06:17:42.865Z",
          artifactPath: "/tmp/body-safe-cleanup.docx",
          report: {
            totalSuggestions: 9,
            matchedSuggestions: 9,
            matchedSuggestionTitles: [
              "Correct spelling and phrasing",
              "Clarify binding claim",
              "Fix synchronization sentence",
              "Correct process wording"
            ],
            commentedSuggestions: 0,
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-06-04T06:17:42.865Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text with tracked body-safe cleanup edits.</p>",
        documentHtmlLength: "<p>Agent imported grant text with tracked body-safe cleanup edits.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: Research_strategy_V3.docx" }));

    expect(await screen.findByText("Agent imported grant text with tracked body-safe cleanup edits.")).toBeInTheDocument();
    expect(screen.queryByText("Latest export: Body-safe language cleanup (9 tracked changes, 0 unmatched)")).not.toBeInTheDocument();
  });

  it("keeps the grant workflow hidden until a shared R01 session is loaded", async () => {
    const session = {
      id: "agent-docx",
      name: "Research_strategy_V3.docx",
      title: "Research Strategy",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text with an Aim 3 handoff.",
      documentHtmlLength: 47,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-aim3-conflict-adjudication"],
      routineRuns: [
        {
          id: "run-aim3",
          routineId: "r01-aim3-conflict-adjudication",
          label: "Aim 3 conflict adjudication",
          completedAt: "2026-06-04T15:17:44.740Z",
          artifactPath: "/tmp/aim3.docx",
          report: {
            totalSuggestions: 1,
            matchedSuggestions: 0,
            commentedSuggestions: 1,
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-06-04T15:17:44.740Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text with an Aim 3 handoff.</p>",
        documentHtmlLength: "<p>Agent imported grant text with an Aim 3 handoff.</p>".length
      }
    });

    render(<App />);
    openPromptLibrary();

    const loadSharedSession = await screen.findByRole("button", { name: "Load shared Writer session: Research_strategy_V3.docx" });
    expect(screen.queryByRole("button", { name: "Show optional grant workflow" })).not.toBeInTheDocument();

    fireEvent.click(loadSharedSession);

    expect(await screen.findByRole("button", { name: "Show optional grant workflow" })).toBeInTheDocument();
  });

  it("describes focused Word-comment section replacements as reviewable handoffs", async () => {
    const session = {
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text with a protected Significance section.",
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-significance-resource-section"],
      routineRuns: [
        {
          id: "run-word-section",
          routineId: "r01-significance-resource-section",
          label: "Significance section",
          completedAt: "2026-05-25T03:38:23.725Z",
          artifactPath: "/tmp/significance-section.docx",
          report: {
            totalSuggestions: 1,
            matchedSuggestions: 0,
            commentedSuggestions: 1,
            commentedSuggestionTitles: ["Integrated Significance and Resource Section"],
            commentedSuggestionReasons: ["Source text was found only in raw Word XML."],
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-05-25T03:38:23.725Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text with a protected Significance section.</p>",
        documentHtmlLength: "<p>Agent imported grant text with a protected Significance section.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(await screen.findByText("Agent imported grant text with a protected Significance section.")).toBeInTheDocument();
    expect(screen.queryByText("Latest export: Significance section (0 tracked changes, 1 Word comment, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refine run for tracked changes: Significance section" })).not.toBeInTheDocument();
  });

  it("describes focused outcome and alternative handoffs as section reviews", async () => {
    const session = {
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text with an Aim 1 outcomes handoff.",
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["aim1-outcomes-alternatives"],
      routineRuns: [
        {
          id: "run-aim1-outcomes",
          routineId: "aim1-outcomes-alternatives",
          label: "Aim 1 outcomes and alternatives",
          completedAt: "2026-06-04T07:17:43.029Z",
          artifactPath: "/tmp/aim1-outcomes.docx",
          report: {
            totalSuggestions: 1,
            matchedSuggestions: 0,
            commentedSuggestions: 1,
            commentedSuggestionTitles: ["Aim 1 Expected Outcomes and Alternative Strategies"],
            commentedSuggestionReasons: ["Source text was found only in raw Word XML."],
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-06-04T07:17:43.029Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text with an Aim 1 outcomes handoff.</p>",
        documentHtmlLength: "<p>Agent imported grant text with an Aim 1 outcomes handoff.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(await screen.findByText("Agent imported grant text with an Aim 1 outcomes handoff.")).toBeInTheDocument();
    expect(screen.queryByText("Latest export: Aim 1 outcomes and alternatives (0 tracked changes, 1 Word comment, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refine run for tracked changes: Aim 1 outcomes and alternatives" })).not.toBeInTheDocument();
  });

  it("phrases focused mixed handoffs without sentence fragments", async () => {
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text with an Aim 1A section.",
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-aim1a-model"],
      routineRuns: [
        {
          id: "run-mixed-section",
          routineId: "r01-focused-section-review",
          label: "Aim 1A sequence model plan rewrite",
          completedAt: "2026-05-25T03:38:23.725Z",
          artifactPath: "/tmp/aim1a-section.docx",
          report: {
            totalSuggestions: 2,
            matchedSuggestions: 1,
            matchedSuggestionTitles: ["Repair Aim 1A title"],
            commentedSuggestions: 1,
            commentedSuggestionTitles: ["Replace Aim 1A model plan"],
            commentedSuggestionReasons: ["Source text was found only in raw Word XML."],
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-05-25T03:38:23.725Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text with an Aim 1A section.</p>",
        documentHtmlLength: "<p>Agent imported grant text with an Aim 1A section.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(await screen.findByText("Agent imported grant text with an Aim 1A section.")).toBeInTheDocument();
    expect(screen.queryByText("Latest export: Aim 1A sequence model plan rewrite (1 tracked change, 1 Word comment, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByText(/plan\\. for Word review/)).not.toBeInTheDocument();
  });

  it("describes mixed placeholder-cleanup runs as successful cleanup reviews", async () => {
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "agent.docx",
      title: "Agent Grant",
      sourceDocumentId: "agent-docx",
      documentText: "Agent imported grant text with draft-note placeholders.",
      documentHtmlLength: 33,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-placeholder-cleanup"],
      routineRuns: [
        {
          id: "run-placeholder-cleanup",
          routineId: "r01-placeholder-cleanup",
          label: "Draft-note placeholder cleanup",
          completedAt: "2026-05-25T03:38:23.725Z",
          artifactPath: "/tmp/placeholder-cleanup.docx",
          report: {
            totalSuggestions: 29,
            matchedSuggestions: 26,
            matchedSuggestionTitles: ["Replace DRB dosing placeholders"],
            commentedSuggestions: 3,
            commentedSuggestionTitles: ["Integrate modeling feasibility note", "Convert Aim 3 transition-kernel notes"],
            commentedSuggestionReasons: ["Source text was found only in raw Word XML."],
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-05-25T03:38:23.725Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>Agent imported grant text with draft-note placeholders.</p>",
        documentHtmlLength: "<p>Agent imported grant text with draft-note placeholders.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: agent.docx" }));

    expect(await screen.findByText("Agent imported grant text with draft-note placeholders.")).toBeInTheDocument();
    expect(screen.queryByText("Latest export: Draft-note placeholder cleanup (26 tracked changes, 3 Word comments, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refine run for tracked changes: Draft-note placeholder cleanup" })).not.toBeInTheDocument();
  });

  it("describes all-comment section merge packets as intentional Word merge handoffs", async () => {
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "Research_strategy_V3.docx",
      title: "Research Strategy",
      sourceDocumentId: "agent-docx",
      documentText: "R01 section merge packet text.",
      documentHtmlLength: 30,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-controlling-section-merge-packet"],
      routineRuns: [
        {
          id: "run-section-merge",
          routineId: "r01-controlling-section-merge-packet",
          label: "Controlling section merge packet",
          completedAt: "2026-06-04T04:35:42.283Z",
          artifactPath: "/tmp/r01-section-merge.docx",
          report: {
            totalSuggestions: 5,
            matchedSuggestions: 0,
            matchedSuggestionTitles: [],
            commentedSuggestions: 5,
            commentedSuggestionTitles: [
              "Replace Background, Significance, and Innovation front matter",
              "Aim 1 Integrated Dynamics Section",
              "Aim 2 Integrated ERa Dynamics Section"
            ],
            commentedSuggestionReasons: ["Source text was found only in raw Word XML."],
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-06-04T04:35:42.283Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>R01 section merge packet text.</p>",
        documentHtmlLength: "<p>R01 section merge packet text.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: Research_strategy_V3.docx" }));

    expect(await screen.findByText("R01 section merge packet text.")).toBeInTheDocument();
    expect(screen.queryByText("Latest export: Controlling section merge packet (0 tracked changes, 5 Word comments, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refine run for tracked changes: Controlling section merge packet" })).not.toBeInTheDocument();
  });

  it("describes all-comment PI checklist runs as intentional decision handoffs", async () => {
    const session = {
      bodySafeAnchors: [],
      bodySafeAnchorDetails: [],
      id: "agent-docx",
      name: "Research_strategy_V3.docx",
      title: "Research Strategy",
      sourceDocumentId: "agent-docx",
      documentText: "R01 PI confirmation checklist text.",
      documentHtmlLength: 35,
      features: emptyFeatures,
      importMessages: [],
      routineProgress: ["r01-pi-confirmation-checklist"],
      routineRuns: [
        {
          id: "run-pi-checklist",
          routineId: "r01-pi-confirmation-checklist",
          label: "PI confirmation checklist",
          completedAt: "2026-06-04T05:47:42.839Z",
          artifactPath: "/tmp/r01-pi-checklist.docx",
          report: {
            totalSuggestions: 5,
            matchedSuggestions: 0,
            matchedSuggestionTitles: [],
            commentedSuggestions: 5,
            commentedSuggestionTitles: [
              "Front Matter and Preliminary Evidence PI Confirmation",
              "Aim 1 Protocol and Analysis PI Confirmation",
              "Aim 2 Experimental Scope PI Confirmation",
              "Aim 3 Enzyme and Processivity PI Confirmation",
              "Closing, Figures, and Citations PI Confirmation"
            ],
            commentedSuggestionReasons: ["Source text was found only in raw Word XML."],
            unmatchedSuggestions: 0
          }
        }
      ],
      suggestions: [],
      pendingSuggestions: 0,
      updatedAt: "2026-06-04T05:47:42.839Z"
    };
    vi.mocked(getWriterSession).mockResolvedValueOnce({ session });
    vi.mocked(getWriterSessionDocument).mockResolvedValueOnce({
      session: {
        ...session,
        documentHtml: "<p>R01 PI confirmation checklist text.</p>",
        documentHtmlLength: "<p>R01 PI confirmation checklist text.</p>".length
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Load shared Writer session: Research_strategy_V3.docx" }));

    expect(await screen.findByText("R01 PI confirmation checklist text.")).toBeInTheDocument();
    expect(screen.queryByText("Latest export: PI confirmation checklist (0 tracked changes, 5 Word comments, 0 unmatched)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refine run for tracked changes: PI confirmation checklist" })).not.toBeInTheDocument();
  });

  it("auto-syncs agent-created suggestions into the review queue for the current DOCX", async () => {
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "shared-docx",
      name: "shared.docx",
      html: "<p>Shared imported document text.</p>",
      plainText: "Shared imported document text.",
      messages: [],
      features: emptyFeatures
    });
    vi.mocked(getWriterSession).mockResolvedValueOnce({
      session: {
        id: "shared-docx",
        name: "shared.docx",
        title: "shared",
        sourceDocumentId: "shared-docx",
        documentText: "Shared imported document text.",
        documentHtmlLength: "<p>Shared imported document text.</p>".length,
        features: emptyFeatures,
        importMessages: [],
        suggestions: [
          {
            id: "agent-suggestion",
            title: "Tighten agent wording",
            original: "Shared imported document text.",
            replacement: "Shared document text.",
            rationale: "Tightens the sentence.",
            confidence: 0.88,
            target: "global",
            status: "pending"
          }
        ],
        pendingSuggestions: 1,
        updatedAt: "2026-05-23T23:19:33.106Z"
      }
    });

    const { container } = render(<App />);
    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["fake"], "shared.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });

    expect(await screen.findByText("Tighten agent wording")).toBeInTheDocument();
    expect(screen.getByText("Synced 1 agent suggestion")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync 1 agent suggestion" })).not.toBeInTheDocument();
  });

  it("shows when long global AI reviews use complete-document coverage passes", async () => {
    const longText = `Long grant sentence ${"x".repeat(AI_CONTEXT_CHAR_LIMIT + 1_000)}`;
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "long-docx",
      name: "long.docx",
      html: `<p>${longText}</p>`,
      plainText: longText,
      messages: [],
      features: {
        formulas: 1,
        citationFields: 0,
        fields: 0,
        contentControls: 0,
        customXml: 0,
        hyperlinks: 0,
        bookmarks: 0,
        commentRanges: 0,
        notes: 0,
        trackedChanges: 0,
        tables: 0,
        images: 0,
        textBoxes: 0,
        bibliographySections: 0,
        preservationRecommended: false
      }
    });

    const { container } = render(<App />);
    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["fake"], "long.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });

    expect(await screen.findByText("Imported long.docx")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make this R01-ready" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Document exceeds one AI request budget; using complete-document coverage passes.")).toBeInTheDocument();
    await waitFor(() => {
      expect(requestAiSuggestion).toHaveBeenCalledWith(expect.objectContaining({
        documentText: expect.stringContaining("Long grant sentence"),
        mode: "global"
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
  });

  it("shows tracked export match and appendix counts", async () => {
    const createObjectUrl = vi.fn(() => "blob:nebula-writer");
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });
    vi.mocked(exportDocx)
      .mockResolvedValueOnce({
        blob: new Blob(["docx"]),
        report: {
          commentedSuggestionIds: ["suggestion-1"],
          commentedSuggestionReasons: ["Source text is in a paragraph that already contains tracked changes, so Nebula preserved the edit as a Word comment."],
          commentedSuggestionTitles: ["Tighten sentence"],
          commentedSuggestions: 1,
          matchedSuggestionIds: ["suggestion-other-1", "suggestion-other-2"],
          matchedSuggestions: 2,
          totalSuggestions: 3,
          unmatchedSuggestionIds: [],
          unmatchedSuggestionTitles: [],
          unmatchedSuggestions: 0
        }
      })
      .mockResolvedValueOnce({
        blob: new Blob(["docx"]),
        report: {
          commentedSuggestionIds: [],
          commentedSuggestionReasons: [],
          commentedSuggestionTitles: [],
          commentedSuggestions: 0,
          matchedSuggestionIds: ["suggestion-1"],
          matchedSuggestions: 1,
          totalSuggestions: 1,
          unmatchedSuggestionIds: [],
          unmatchedSuggestionTitles: [],
          unmatchedSuggestions: 0
        }
      });

    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    await waitFor(() => {
      expect(exportDocx).toHaveBeenCalledWith(expect.objectContaining({
        trackedChanges: true
      }));
    });
    expect(await screen.findByText("Exported review DOCX (2 tracked changes; 1 as Word comments)")).toBeInTheDocument();
    expect(screen.queryByText("Added protected-structure suggestions as Word comments: Tighten sentence. Reason: Source text is in a paragraph that already contains tracked changes, so Nebula preserved the edit as a Word comment.")).not.toBeInTheDocument();
    expect(screen.getByText("Word comment")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Last review export" })).not.toBeInTheDocument();
    expect(screen.queryByText("Open Word comments for: Tighten sentence. Reason: Source text is in a paragraph that already contains tracked changes, so Nebula preserved the edit as a Word comment.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show Word comment suggestion: Tighten sentence" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refine Word comment or unresolved suggestions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry review export" })).not.toBeInTheDocument();
    expect(exportDocx).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:nebula-writer");

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(screen.queryByRole("status", { name: "Last review export" })).not.toBeInTheDocument();
    click.mockRestore();
  });

  it("surfaces unresolved export items even when other suggestions became Word comments", async () => {
    const createObjectUrl = vi.fn(() => "blob:mixed-review");
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });
    vi.mocked(exportDocx).mockResolvedValueOnce({
      blob: new Blob(["docx"]),
      report: {
        commentedSuggestionIds: ["suggestion-1"],
        commentedSuggestionReasons: ["Source text is in a paragraph that already contains tracked changes."],
        commentedSuggestionTitles: ["Tighten sentence"],
        commentedSuggestions: 1,
        matchedSuggestionIds: ["suggestion-other-1", "suggestion-other-2"],
        matchedSuggestions: 2,
        totalSuggestions: 4,
        unmatchedSuggestionIds: ["missing-model-premise"],
        unmatchedSuggestionTitles: ["Missing model premise"],
        unmatchedSuggestions: 1
      }
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the Aim 3C model section reviewable" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));
    expect(await screen.findByText("Tighten sentence")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    expect(await screen.findByText("Exported review DOCX (2 tracked changes; 1 as Word comments; 1 unresolved)")).toBeInTheDocument();
    expect(screen.queryByText("Could not place unresolved suggestions: Missing model premise. 1 other suggestion exported as Word comment.")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Last review export" })).not.toBeInTheDocument();
    expect(screen.queryByText("Could not place: Missing model premise. 1 other suggestion exported as Word comment.")).not.toBeInTheDocument();

    click.mockRestore();
  });

  it("treats Word-comment handoff routine exports as intentional review carriers", async () => {
    const createObjectUrl = vi.fn(() => "blob:word-handoff");
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });
    vi.mocked(requestAiSuggestion).mockResolvedValueOnce({
      provider: "codex",
      message: "Four exact-source edits proposed for Aim 2B/2C R01 readiness.",
      suggestions: [
        {
          id: "handoff-1",
          title: "Replace placeholder stimulus",
          original: "in response to XXX",
          replacement: "in response to defined differentiation cues across the Aim 2 time course",
          rationale: "Replaces a placeholder with reviewer-facing experimental scope.",
          confidence: 0.86,
          target: "global",
          status: "pending"
        },
        {
          id: "handoff-2",
          title: "Specify model benchmark",
          original: "We will train model for all measured timepoints.",
          replacement: "We will benchmark a sequence-conditioned model across all measured time points.",
          rationale: "Adds a measurable model-development outcome.",
          confidence: 0.82,
          target: "global",
          status: "pending"
        },
        {
          id: "handoff-3",
          title: "Quantify response metrics",
          original: "We will quantify response curve parameters such as delay and speed.",
          replacement: "We will quantify onset delay, half-time, maximum slope, and response amplitude.",
          rationale: "Makes the expected outcome measurable.",
          confidence: 0.84,
          target: "global",
          status: "pending"
        }
      ]
    });
    vi.mocked(exportDocx).mockResolvedValueOnce({
      blob: new Blob(["docx"]),
      report: {
        commentedSuggestionIds: ["handoff-2", "handoff-3"],
        commentedSuggestionReasons: ["Source text is in a paragraph that already contains tracked changes, so Nebula preserved the edit as a Word comment."],
        commentedSuggestionTitles: ["Specify model benchmark", "Quantify response metrics"],
        commentedSuggestions: 2,
        matchedSuggestionIds: ["handoff-1"],
        matchedSuggestions: 1,
        totalSuggestions: 3,
        unmatchedSuggestionIds: [],
        unmatchedSuggestionTitles: [],
        unmatchedSuggestions: 0
      }
    });

    render(<App />);
    openPromptLibrary();

    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "Research Strategy" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Show optional grant workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Use R01 Word-comment handoff prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    expect(await screen.findByText("Replace placeholder stimulus")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Routine export handoff" })).toHaveTextContent("Word comments returned 3 reviewable edits.");
    fireEvent.click(screen.getByRole("button", { name: "Export Word comments review DOCX" }));

    await waitFor(() => {
      expect(exportDocx).toHaveBeenCalledWith(expect.objectContaining({
        downloadFilename: expect.stringMatching(/^Research-Strategy_Word-comments_\d{8}T\d{6}Z_review\.docx$/),
        trackedChanges: true,
        suggestions: expect.arrayContaining([
          expect.objectContaining({ id: "handoff-1" }),
          expect.objectContaining({ id: "handoff-2" }),
          expect.objectContaining({ id: "handoff-3" })
        ])
      }));
    });
    expect(screen.queryByText(/Prepared Word-comment handoff: Specify model benchmark; Quantify response metrics\./)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Routine export summary" })).toHaveTextContent("Word comments exported: 1 tracked change, 2 Word comments");
    expect(screen.queryByRole("status", { name: "Last review export" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Word review carrier: Specify model benchmark; Quantify response metrics\./).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Refine Word comment or unresolved suggestions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refine run for tracked changes: Word comments" })).not.toBeInTheDocument();
    expect(createObjectUrl).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:word-handoff");
    click.mockRestore();
  });

  it("does not expose Demo AI in the provider picker", async () => {
    render(<App />);

    expect(await screen.findByRole("combobox", { name: "AI provider" })).toHaveValue("codex");
    expect(screen.queryByRole("option", { name: "Demo AI" })).not.toBeInTheDocument();
    // Options carry a per-provider readiness suffix (" ✓ ready" / " — not found"),
    // so match by prefix.
    expect(screen.getByRole("option", { name: /^Codex CLI/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^Claude Code/ })).toBeInTheDocument();
  });

  it("opens the agent terminal via hop from the chat header", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open agent terminal" }));

    await waitFor(() => expect(ensureAgentTerminal).toHaveBeenCalledWith("codex", "sidecar"));
    expect(openSpy).toHaveBeenCalledWith("https://hop.zhoulab.io/s/writer-agent/", "_blank", "noopener");
    openSpy.mockRestore();
  });

  it("runs a selected provider smoke test from the toolbar", async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Smoke test Codex CLI" }));

    await waitFor(() => {
      expect(runProviderSmokeTest).toHaveBeenCalledWith("codex");
    });
    expect(await screen.findByText(/Codex smoke test passed/)).toBeInTheDocument();
  });

  it("shows provider override details in the CLI status tooltip", async () => {
    vi.mocked(getHealth).mockResolvedValueOnce({
      ok: true,
      cliEnabled: true,
      cliTimeout: {
        env: "WRITER_CLI_TIMEOUT_MS",
        value: "slow",
        timeoutMs: 180000,
        defaultMs: 180000,
        minMs: 100,
        maxMs: 600000,
        valid: false,
        clamped: false,
        detail: "WRITER_CLI_TIMEOUT_MS=slow is not a valid millisecond timeout; using 180s."
      },
      providers: ["codex", "claude"],
      providerStatus: [
        {
          name: "codex",
          available: true,
          enabled: true,
          detail: "Uses WRITER_CODEX_PATH (/custom/bin/codex)",
          overrideEnv: "WRITER_CODEX_PATH",
          overrideValue: "./custom/bin/codex",
          path: "/custom/bin/codex",
          version: "codex-cli test"
        }
      ]
    });

    render(<App />);

    const providerSelect = screen.getByLabelText("AI provider").closest(".provider-select");
    await waitFor(() => {
      expect(providerSelect).toHaveAttribute("title", expect.stringContaining("Codex CLI ready"));
    });
    expect(providerSelect).toHaveAttribute("title", expect.stringContaining("WRITER_CODEX_PATH=./custom/bin/codex"));
    expect(providerSelect).toHaveAttribute("title", expect.stringContaining("/custom/bin/codex"));
    expect(providerSelect).toHaveAttribute("title", expect.stringContaining("WRITER_CLI_TIMEOUT_MS=slow"));
  });

  it("keeps richer imported DOCX HTML visible in the editor", async () => {
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "rich-docx",
      name: "rich.docx",
      html: [
        "<p><u>Underlined</u> H<sub>2</sub>O <sup>2</sup> <a href=\"https://example.com\">link</a></p>",
        "<p><span data-docx-equation=\"true\" data-docx-equation-text=\"x+y\" data-docx-mathml=\"&lt;math xmlns=&quot;http://www.w3.org/1998/Math/MathML&quot;&gt;&lt;mrow&gt;&lt;mi&gt;x&lt;/mi&gt;&lt;mo&gt;+&lt;/mo&gt;&lt;mi&gt;y&lt;/mi&gt;&lt;/mrow&gt;&lt;/math&gt;\" data-docx-mathjax-svg=\"&lt;mjx-container class=&quot;MathJax&quot;&gt;&lt;svg role=&quot;img&quot;&gt;&lt;/svg&gt;&lt;/mjx-container&gt;\" role=\"math\" aria-label=\"Word equation preview: x+y\" title=\"Word equation preview; original OMML is preserved in source DOCX\">x+y</span></p>",
        "<table><tbody><tr><th><p>Term</p></th><td><p>Definition</p></td></tr></tbody></table>",
        "<p><img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"Tiny figure\" /></p>"
      ].join(""),
      plainText: "Underlined H2O 2 link x+y Term Definition",
      messages: [],
      bodySafeAnchors: [
        "Aim 2 clean sentence gives reviewers an ordinary tracked-change anchor.",
        "Aim 3 clean sentence gives reviewers another ordinary tracked-change anchor.",
        "Deliver a concrete milestone using high-coverage SMF data across differentiation.",
        "This dataset will be a reusable resource for the wider research community."
      ],
      bodySafeAnchorDetails: [
        {
          section: "Aim 2A. Measure response timing",
          text: "Aim 2 clean sentence gives reviewers an ordinary tracked-change anchor."
        },
        {
          section: "Aim 3. Expected results, limitations and alternative strategies",
          text: "Aim 3 clean sentence gives reviewers another ordinary tracked-change anchor."
        },
        {
          section: "Expected Milestones and Impact",
          text: "Deliver a concrete milestone using high-coverage SMF data across differentiation."
        },
        {
          section: "Expected Milestones and Impact",
          text: "This dataset will be a reusable resource for the wider research community."
        }
      ],
      features: {
        formulas: 1,
        citationFields: 0,
        fields: 0,
        contentControls: 0,
        customXml: 0,
        hyperlinks: 1,
        bookmarks: 0,
        commentRanges: 0,
        notes: 0,
        trackedChanges: 0,
        tables: 1,
        images: 1,
        textBoxes: 0,
        bibliographySections: 0,
        preservationRecommended: true
      }
    });

    const { container } = render(<App />);
    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["fake"], "rich.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });

    expect(await screen.findByText("Definition")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "link" })).toHaveAttribute("href", "https://example.com");
    expect(await screen.findByTitle(/Word equation preview/)).toHaveTextContent("x+y");
    expect(screen.getByLabelText("Word equation preview: x+y")).toHaveAttribute("data-docx-equation", "true");
    expect(screen.getByLabelText("Word equation preview: x+y").querySelector("mjx-container")).toBeInTheDocument();
    expect(screen.getByAltText("Tiny figure")).toBeInTheDocument();
    const preservationSummary = await screen.findByTitle(/Word math formulas are shown as protected browser previews/);
    expect(preservationSummary).toBeInTheDocument();
    expect(preservationSummary).toHaveAttribute("title", expect.stringContaining("original equation XML is preserved"));
    const thinAnchorPrompt = screen.getByRole("button", { name: "Load clean-source prompt for thin Aim coverage: Aim 2, Aim 3" });
    expect(thinAnchorPrompt).toHaveTextContent("4 clean source samples; thin Aim coverage: Aim 2, Aim 3");
    expect(thinAnchorPrompt).toHaveAttribute("title", expect.stringContaining("Aim 2: 1; Aim 3: 1"));
    fireEvent.click(thinAnchorPrompt);
    const composer = screen.getByLabelText("AI instruction") as HTMLTextAreaElement;
    expect(composer.value).toContain("narrow body-safe pass for sections with few clean source-text samples: Aim 2, Aim 3");
    expect(composer.value).toContain("Aim 2 clean sentence gives reviewers an ordinary tracked-change anchor.");
    expect(composer.value).toContain("Aim 3 clean sentence gives reviewers another ordinary tracked-change anchor.");
    expect(screen.getByText("Capped at 2 edits per request")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Clean body anchor map" })).not.toBeInTheDocument();

    const milestonesPrompt = screen.getByRole("button", { name: "Load clean-source milestones payoff prompt" });
    expect(milestonesPrompt).toHaveTextContent("Milestones payoff: 2 samples");
    expect(milestonesPrompt).toHaveAttribute("title", expect.stringContaining("2 Expected Milestones and Impact clean source-text samples"));
    fireEvent.click(milestonesPrompt);
    expect(composer.value).toContain("narrow Expected Milestones and Impact payoff pass");
    expect(composer.value).toContain("Deliver a concrete milestone using high-coverage SMF data across differentiation.");
    expect(composer.value).toContain("This dataset will be a reusable resource for the wider research community.");
    expect(composer.value).not.toContain("Aim 2 clean sentence gives reviewers an ordinary tracked-change anchor.");
    expect(screen.getByText("Capped at 2 edits per request")).toBeInTheDocument();
  });

  it("keeps an imported DOCX text box visibly marked in the editor", async () => {
    vi.mocked(importDocx).mockResolvedValueOnce({
      id: "text-box-docx",
      name: "textbox.docx",
      html: "<p data-docx-text-box=\"true\">SMF data capture happened in a Word text box.</p>",
      plainText: "SMF data capture happened in a Word text box.",
      messages: [],
      features: {
        formulas: 0,
        citationFields: 0,
        fields: 0,
        contentControls: 0,
        customXml: 0,
        hyperlinks: 0,
        bookmarks: 0,
        commentRanges: 0,
        notes: 0,
        trackedChanges: 0,
        tables: 0,
        images: 0,
        textBoxes: 1,
        bibliographySections: 0,
        preservationRecommended: true
      }
    });

    const { container } = render(<App />);
    const input = container.querySelector("input[type='file']");
    if (!input) {
      throw new Error("Missing file input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["fake"], "textbox.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })]
      }
    });

    const paragraph = await screen.findByText("SMF data capture happened in a Word text box.");
    expect(paragraph.closest("p")).toHaveAttribute("data-docx-text-box", "true");
    expect(await screen.findByTitle(/1 text box/)).toBeInTheDocument();
  });

  it("blocks AI requests when local CLI execution is locked", async () => {
    vi.mocked(getHealth).mockResolvedValueOnce({
      ok: true,
      cliEnabled: false,
      providers: ["codex", "claude"],
      providerStatus: [
        {
          name: "codex",
          available: true,
          enabled: false,
          detail: "Local CLI execution disabled via WRITER_ALLOW_CLI=0",
          overrideEnv: "WRITER_CODEX_PATH",
          overrideValue: null,
          path: "/usr/local/bin/codex",
          version: "codex-cli test"
        }
      ]
    });

    render(<App />);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Make the opening shorter" }
    });

    expect(await screen.findByText("CLI locked by WRITER_ALLOW_CLI=0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send revision request" })).toBeDisabled();
    expect(requestAiSuggestion).not.toHaveBeenCalled();
  });

  it("attaches reference files and sends them with the AI request", async () => {
    vi.mocked(uploadAiAttachment).mockResolvedValueOnce({
      name: "notes.md",
      path: "/tmp/attachments/x-notes.md",
      text: "reviewer notes"
    });

    render(<App />);

    await screen.findByRole("button", { name: "Attach a reference file" });
    const attachmentInput = document.querySelector('input[type="file"][multiple]') as HTMLInputElement;
    fireEvent.change(attachmentInput, {
      target: { files: [new File(["reviewer notes"], "notes.md", { type: "text/markdown" })] }
    });

    expect(await screen.findByText("notes.md")).toBeInTheDocument();
    expect(uploadAiAttachment).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Align the aims with the attached notes" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));

    await waitFor(() => expect(requestAiSuggestion).toHaveBeenCalled());
    const sentRequest = vi.mocked(requestAiSuggestion).mock.calls[0][0];
    expect(sentRequest.attachments).toEqual([
      expect.objectContaining({ name: "notes.md", path: "/tmp/attachments/x-notes.md", text: "reviewer notes" })
    ]);
    // Attachments are sticky context: the chip STAYS after sending so it never
    // needs re-attaching, and a follow-up message includes it again.
    expect(document.querySelector(".attachment-chip")).toBeInTheDocument();
    expect(screen.getByText("In context:")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("AI instruction"), {
      target: { value: "Now tighten the second aim too" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send revision request" }));
    await waitFor(() => expect(requestAiSuggestion).toHaveBeenCalledTimes(2));
    const followUp = vi.mocked(requestAiSuggestion).mock.calls[1][0];
    expect(followUp.attachments).toEqual([
      expect.objectContaining({ name: "notes.md", path: "/tmp/attachments/x-notes.md" })
    ]);
  });

  it("opens the AI onboarding guide when no CLI is found and remembers dismissal for the session", async () => {
    vi.mocked(getHealth).mockResolvedValueOnce({
      ok: true,
      cliEnabled: true,
      providers: [],
      providerStatus: [
        {
          name: "codex",
          available: false,
          enabled: false,
          detail: "codex was not found on PATH",
          overrideEnv: "WRITER_CODEX_PATH",
          overrideValue: null,
          path: null,
          version: null
        },
        {
          name: "claude",
          available: false,
          enabled: false,
          detail: "claude was not found on PATH",
          overrideEnv: "WRITER_CLAUDE_PATH",
          overrideValue: null,
          path: null,
          version: null
        }
      ]
    });

    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Set up AI for this Writer" });
    expect(dialog).toHaveTextContent("npm install -g @openai/codex");
    expect(dialog).toHaveTextContent("npm install -g @anthropic-ai/claude-code");

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog", { name: "Set up AI for this Writer" })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem("nebula-writer-ai-setup-dismissed")).toBe("1");
  });

  it("keeps the onboarding guide closed when at least one CLI is available", async () => {
    vi.mocked(getHealth).mockResolvedValueOnce({
      ok: true,
      cliEnabled: true,
      providers: ["claude"],
      providerStatus: [
        {
          name: "codex",
          available: false,
          enabled: false,
          detail: "codex was not found on PATH",
          overrideEnv: "WRITER_CODEX_PATH",
          overrideValue: null,
          path: null,
          version: null
        },
        {
          name: "claude",
          available: true,
          enabled: true,
          detail: "Uses /usr/local/bin/claude",
          overrideEnv: "WRITER_CLAUDE_PATH",
          overrideValue: null,
          path: "/usr/local/bin/claude",
          version: "Claude Code test"
        }
      ]
    });

    render(<App />);

    // One provider works: the app falls back to it, nothing is blocked, and
    // the onboarding guide must stay closed.
    await waitFor(() => expect(screen.getByLabelText("AI provider")).toHaveValue("claude"));
    expect(screen.queryByRole("dialog", { name: "Set up AI for this Writer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up AI" })).not.toBeInTheDocument();
  });

  it("opens the cloud onboarding guide when no AI runner is connected", async () => {
    vi.mocked(getHealth).mockResolvedValueOnce({
      ok: true,
      cloud: true,
      cliEnabled: false,
      providers: [],
      providerStatus: [
        {
          name: "codex",
          available: false,
          enabled: false,
          detail: "AI offline.",
          overrideEnv: "",
          overrideValue: null
        },
        {
          name: "claude",
          available: false,
          enabled: false,
          detail: "AI offline.",
          overrideEnv: "",
          overrideValue: null
        }
      ]
    });

    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Set up AI for this Writer" });
    expect(dialog).toHaveTextContent("WRITER_ALLOWED_ORIGINS");
    expect(dialog).toHaveTextContent("git clone");
  });

  it("guides a localhost sidecar-down visitor to just start the sidecar", async () => {
    // Health probe fails outright (sidecar not running). jsdom serves from
    // localhost, so the repo is present — a single `npm run sidecar` suffices
    // and the guide must NOT drag them through git clone.
    vi.mocked(getHealth).mockRejectedValueOnce(new Error("fetch failed"));

    render(<App />);

    const dialog = await screen.findByRole("dialog", { name: "Set up AI for this Writer" });
    expect(dialog).toHaveTextContent("npm run sidecar");
    expect(dialog).not.toHaveTextContent("git clone");
  });
});
