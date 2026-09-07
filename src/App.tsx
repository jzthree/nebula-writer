import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { wordDiffSegments } from "./wordDiff";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Underline from "@tiptap/extension-underline";
import { mergeAttributes, Node as TiptapNode } from "@tiptap/core";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { ySyncPluginKey, yUndoPluginKey } from "y-prosemirror";
import { getCollabSession, setCollabUserName, whenCollabSynced, type CollabSession } from "./collab";
import { clearDocIdFromLocation, collaboratorShareUrl, documentShareUrl, getStoredShareToken, parseCloudSyncFromLocation, parseDocIdFromLocation, shareTokenQuerySuffix, writeCloudSyncToLocation, writeDocIdToLocation } from "./shareToken";
import { isSafariBrowser } from "./browser";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Activity,
  Copy,
  Download,
  FilePenLine,
  FileText,
  History,
  Highlighter,
  List,
  LocateFixed,
  Loader2,
  SquareTerminal,
  MessageSquarePlus,
  MessageSquareText,
  Wrench,
  FilePlus2,
  PanelRight,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  Send,
  SkipForward,
  Sparkles,
  Search,
  Square,
  Undo2,
  Upload,
  Users,
  X,
  Eye,
  EyeOff
} from "lucide-react";
import { AgentTerminal } from "./AgentTerminal";
import { appendWriterChatMessages, createWriterSession, downloadWriterRoutineArtifact, ensureAgentTerminal, ensureCollabBridge, getLocalAiHealth, getLocalAiProgress, exportDocxLocally, importDocxLocally, requestLocalAiSuggestion, exportDocx, exportWriterSessionReview, exportWriterSessionState, getAiProgress, getHealth, getShareInfo, getWriterAutosavedSessions, getWriterSession, getWriterSessionDocument, importDocx, importWriterSessionState, loadWriterAutosavedSession, recordWriterSuggestions, requestAiSuggestion, runProviderSmokeTest, setWriterRoutineProgress, setWriterRoutineRun, setWriterSuggestionStatus, SidecarHttpError, syncWriterRoutineSuggestions, uploadAiAttachment, type ExportDocxResult, type ExportReport, type HealthResponse, type SuggestionStatusConflict } from "./api";
import { applySuggestion, centerEditorRange, centerSuggestionTarget, findSuggestionRange, findTextRange, getSelectionContext, leadingAnchorContext, materializeSourceTrackedChanges, normalizeText, primeSuggestionRangeCache, replacementToContent, selectSuggestionTarget, suggestionsFromSuggestionMarks, trailingAnchorContext } from "./editorOps";
import { addReviewTrace, clearReviewHighlight, removeReviewTrace, ReviewHighlight, setReviewHighlight, setReviewTraces, type ReviewTrace } from "./reviewHighlight";
import { setSourceRevisionHighlight, SourceRevisionHighlight, type SourceRevisionMark } from "./sourceRevisionHighlight";
import { HeadingEnter } from "./headingEnter";
import { UndoGuard } from "./undoGuard";
import { applyReplacementAsSuggestionMarks, resolveSuggestionMarks, SuggestingRouter, SuggestionDeletion, SuggestionInsertion } from "./suggesting";
import { RetainedSelection } from "./retainedSelection";
import { AI_ATTACHMENT_LIMIT, AI_CONTEXT_CHAR_LIMIT, AI_TOOL_ACCESS_LEVELS, DEFAULT_AI_TOOL_ACCESS, formatElapsedSince, isAiToolAccess, isLocalHostname, type AiAttachment, type AiToolAccess, type AiProviderName, type AiRequest, type ImportedDocument, type AiResponse, type AiSuggestion, type DocxBodySafeAnchor, type DocxFeatureSummary, type ProviderHealth, type ProviderSmokeResponse, type SelectionContext, type SourceTrackedChangePreview, type WriterAutosavedSessionSummary, type WriterChatMessage, type WriterReviewSourceDocument, type WriterRoutineRun, type WriterRoutineRunReport, type WriterSessionDocument, type WriterSessionSummary } from "./shared";
import { generalBuiltInRoutines, r01BuiltInRoutines, r01RoutineSequence, type WritingRoutine } from "./writingRoutines";

type InteractiveProviderName = Exclude<AiProviderName, "demo">;
type ExportDispositionReport = ExportReport | WriterRoutineRunReport;

interface SaveFilePickerAcceptType {
  accept: Record<string, string[]>;
  description: string;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  startIn?: "downloads";
  types?: SaveFilePickerAcceptType[];
}

interface SaveFileWritable {
  close(): Promise<void>;
  write(data: Blob): Promise<void>;
}

interface SaveFileHandle {
  createWritable(): Promise<SaveFileWritable>;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<SaveFileHandle>;
  }
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  author?: string | null;
  createdAt?: string | null;
}

interface EmptyAiResult {
  instruction: string;
  message: string;
  mode: "global" | "selection";
  provider: InteractiveProviderName;
}

interface SequenceReviewHandoff {
  instruction?: string;
  label: string;
  routineId: string;
  suggestionCount: number;
}

interface SequenceExportSummary {
  filename?: string;
  label: string;
  report: ExportReport | null;
  routineId: string;
}

interface RoutineIntent {
  label: string;
  routineId: string;
}

interface ExportReportDisplayOptions {
  cumulativeHandoff?: boolean;
  wordCommentHandoff?: boolean;
}

interface ReviewBacklogStatus {
  detail: string;
  headline: string;
}

interface ReviewBacklogClipboardInput extends ReviewBacklogStatus {
  currentFilter: string;
  latestArtifactPath?: string | null;
  latestRunLabel?: string | null;
}

interface SuggestionExportDisposition {
  kind: "tracked" | "commented" | "unresolved";
  label: string;
  title: string;
}

interface SharedRunSuggestionDisposition {
  kind: "latest" | "recent";
  label: string;
  placement: "tracked" | "commented" | "unresolved";
  title: string;
}

type ReviewFilter = "pending" | "priority" | "clean" | "conflicts" | "source-moved" | "source-revisions" | "latest" | "duplicates" | "word-comments" | "fact-checks" | "all";
type ReviewNavigationPointerDown = { container: HTMLElement; x: number; y: number };

type EditorTrackedChangeKind = "insert" | "delete" | "replace";
type EditorTrackedChangeSource = "user" | "ai";

interface EditorTrackedChange {
  /**
   * Word/sentence-expanded versions of original/replacement used as the review
   * export anchor. Minimal diffs ("a"→"o") are unmatchable and dangerously
   * ambiguous in the source DOCX; the expanded pair carries enough surrounding
   * words to anchor the edit at the right spot.
   */
  anchorOriginal?: string | null;
  anchorReplacement?: string | null;
  /** Display name of who made the change (collaborator name, or the AI suggestion's proposer). */
  author?: string | null;
  createdAt: string;
  from: number;
  id: string;
  kind: EditorTrackedChangeKind;
  original: string;
  replacement: string;
  source: EditorTrackedChangeSource;
  title: string;
  to: number;
}

const starterDocument = `
  <h1>Nebula Writer Draft</h1>
  <p>This is a local-first writing workspace for revising DOCX documents with AI. Select a sentence or paragraph, ask for a change, and review the proposed edit before accepting it.</p>
  <p>Codex and Claude Code providers are routed through the local sidecar when CLI execution is enabled.</p>
`;
const maxAutomaticPendingReviewTraces = 24;
const maxTrackedEditorChanges = 500;
const reviewBacklogPressureThreshold = 100;

const readyMessage = "Ready. Import a DOCX or start writing, then ask for a global or selection-specific revision.";
const cumulativeReviewIntent: RoutineIntent = {
  label: "Current cumulative review",
  routineId: "r01-cumulative-review"
};
const cumulativeReviewInstruction = "Export all current pending review suggestions as one cumulative source-preserving Word review carrier.";
const maxSuggestionsErrorMessage = "Suggestion cap must be blank or a positive whole number.";
const routinesStorageKey = "nebula-writer-routines-v1";
const sequenceProgressStorageKey = "nebula-writer-r01-progress-v1";
const bodySafeReplacementCharacterLimit = 260;
const verificationNoteLimit = 12;
const r01WordCommentHandoffRoutine = r01BuiltInRoutines.find((routine) => routine.id === "r01-word-comment-handoff") ?? null;
function isR01WritingContext(context: {
  completedRoutineIds: string[];
  documentNote: string;
  documentTitle: string;
  loadedRoutineIntent: RoutineIntent | null;
  sourceDocumentId: string | null;
}): boolean {
  if (context.loadedRoutineIntent?.routineId.startsWith("r01-") || context.completedRoutineIds.length) {
    return true;
  }
  const writingContextText = [
    context.documentTitle,
    context.documentNote,
    context.sourceDocumentId
  ].filter(Boolean).join(" ").replace(/[_-]+/g, " ");
  return /\b(r01|grant|research strategy)\b/i.test(writingContextText);
}

function sharedSuggestionsAreAdditionsOnly(sharedSuggestions: AiSuggestion[], localSuggestions: AiSuggestion[]): boolean {
  const sharedStatuses = new Map(sharedSuggestions.map((suggestion) => [suggestion.id, suggestion.status]));
  let hasNewSuggestion = false;
  for (const suggestion of sharedSuggestions) {
    if (!localSuggestions.some((localSuggestion) => localSuggestion.id === suggestion.id)) {
      hasNewSuggestion = true;
      break;
    }
  }
  if (!hasNewSuggestion) {
    return false;
  }
  return localSuggestions.every((suggestion) => sharedStatuses.get(suggestion.id) === suggestion.status);
}

/** The original and revised text of a decided suggestion, as the review card showed it. */
function DecidedChange({ suggestion }: { suggestion: AiSuggestion }) {
  const segments = suggestion.commentOnly ? null : wordDiffSegments(suggestion.original, suggestion.replacement);
  return (
    <div className="review-activity-change">
      {segments ? (
        <p className="diff-inline">
          {segments.map((segment, index) => segment.type === "same"
            ? <span key={index}>{segment.text}</span>
            : segment.type === "del"
              ? <del key={index}>{segment.text}</del>
              : <ins key={index}>{segment.text}</ins>)}
        </p>
      ) : null}
      <div className="diff-block">
        <p className="original">{suggestion.original}</p>
        {suggestion.commentOnly ? null : <p className="replacement">{suggestion.replacement || "(deleted)"}</p>}
      </div>
      {suggestion.rationale ? <p className="rationale">{suggestion.rationale}</p> : null}
    </div>
  );
}

function createSystemMessage(content = readyMessage): ChatMessage {
  return {
    id: `system-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: "system",
    content
  };
}

function chatMessagesForSession(messages: ChatMessage[]): WriterChatMessage[] {
  return messages
    .filter((message) => message.content.trim())
    .slice(-100)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.trim(),
      author: message.author ?? null,
      createdAt: message.createdAt ?? null
    }));
}

function chatMessagesFromSession(sessionMessages: WriterChatMessage[] | undefined, fallbackSystemMessage: string): ChatMessage[] {
  const restored = (sessionMessages ?? [])
    .filter((message) => message.content.trim())
    .slice(-100)
    .map((message) => ({
      id: message.id || `restored-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: message.role,
      content: message.content.trim(),
      author: message.author ?? null,
      createdAt: message.createdAt ?? null
    }));
  return restored.length ? restored : [createSystemMessage(fallbackSystemMessage)];
}

const DocxParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      docxTextBox: {
        default: false,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-docx-text-box") === "true",
        renderHTML: (attributes) => attributes.docxTextBox
          ? {
            "data-docx-text-box": "true",
            title: "Imported DOCX text box"
          }
          : {}
      }
    };
  }
});

const docxEquationPreviewTitle = "Word equation preview; original OMML is preserved in source DOCX";
const docxEquationPreviewAriaLabel = "Word equation preview";

const DocxEquation = TiptapNode.create({
  name: "docxEquation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-docx-equation-text") || element.textContent || "",
        renderHTML: (attributes) => attributes.text
          ? {
            "data-docx-equation-text": attributes.text
          }
          : {}
      },
      mathml: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-docx-mathml") || "",
        renderHTML: (attributes) => attributes.mathml
          ? {
            "data-docx-mathml": attributes.mathml
          }
          : {}
      },
      renderedSvg: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-docx-mathjax-svg") || "",
        renderHTML: (attributes) => attributes.renderedSvg
          ? {
            "data-docx-mathjax-svg": attributes.renderedSvg
          }
          : {}
      },
      ariaLabel: {
        default: docxEquationPreviewAriaLabel,
        parseHTML: (element: HTMLElement) => element.getAttribute("aria-label") || docxEquationPreviewAriaLabel,
        renderHTML: (attributes) => ({
          "aria-label": attributes.ariaLabel || docxEquationPreviewAriaLabel
        })
      },
      role: {
        default: "math",
        parseHTML: (element: HTMLElement) => element.getAttribute("role") || "math",
        renderHTML: (attributes) => ({
          role: attributes.role || "math"
        })
      },
      title: {
        default: docxEquationPreviewTitle,
        parseHTML: (element: HTMLElement) => element.getAttribute("title") || docxEquationPreviewTitle,
        renderHTML: (attributes) => ({
          title: attributes.title || docxEquationPreviewTitle
        })
      }
    };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-docx-equation=\"true\"]"
      }
    ];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-docx-equation": "true" }), node.attrs.text || ""];
  },
  renderText({ node }) {
    return node.attrs.text || "";
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      renderDocxEquationPreview(dom, node.attrs);
      return {
        dom,
        ignoreMutation: () => true,
        update: (updatedNode) => {
          if (updatedNode.type.name !== this.name) {
            return false;
          }
          renderDocxEquationPreview(dom, updatedNode.attrs);
          return true;
        }
      };
    };
  }
});

function renderDocxEquationPreview(dom: HTMLElement, attrs: Record<string, unknown>): void {
  const text = stringAttr(attrs.text);
  const renderedSvg = stringAttr(attrs.renderedSvg);
  const mathml = stringAttr(attrs.mathml);
  dom.setAttribute("data-docx-equation", "true");
  if (text) {
    dom.setAttribute("data-docx-equation-text", text);
  } else {
    dom.removeAttribute("data-docx-equation-text");
  }
  if (mathml) {
    dom.setAttribute("data-docx-mathml", mathml);
  } else {
    dom.removeAttribute("data-docx-mathml");
  }
  if (renderedSvg) {
    dom.setAttribute("data-docx-mathjax-svg", renderedSvg);
  } else {
    dom.removeAttribute("data-docx-mathjax-svg");
  }
  dom.setAttribute("role", stringAttr(attrs.role) || "math");
  dom.setAttribute("aria-label", stringAttr(attrs.ariaLabel) || (text ? `Word equation preview: ${text}` : docxEquationPreviewAriaLabel));
  dom.setAttribute("title", stringAttr(attrs.title) || docxEquationPreviewTitle);
  if (renderedSvg) {
    dom.innerHTML = renderedSvg;
    dom.querySelector("mjx-container")?.setAttribute("aria-hidden", "true");
    const fallback = document.createElement("span");
    fallback.className = "docx-equation-text-fallback";
    fallback.textContent = text;
    dom.appendChild(fallback);
  } else {
    dom.textContent = text || "Word equation";
  }
}

function stringAttr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export { wordDiffSegments, type DiffSegment } from "./wordDiff";

function SetupCommand({ command, onCopied }: { command: string; onCopied: (note: string) => void }) {
  return (
    <span className="setup-command">
      <code>{command}</code>
      <button
        type="button"
        onClick={() => void copyTextToClipboard(command).then((copied) => onCopied(copied ? "Command copied" : "Copy failed " + String.fromCharCode(0x2014) + " select the text manually"))}
        aria-label={`Copy command: ${command}`}
        title="Copy command"
      >
        <Copy size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

export function App() {
  const [documentTitle, setDocumentTitle] = useState("Nebula Writer Draft");
  // Persisted so a reload reattaches to the SAME provider's terminal session
  // (the PTY room is per-provider; resetting to the default silently attached
  // a fresh codex instead of the user's running claude).
  const [provider, setProviderState] = useState<InteractiveProviderName>(() => {
    try {
      const stored = window.localStorage.getItem("nebula-writer-provider");
      return stored === "claude" || stored === "codex" ? stored : "codex";
    } catch {
      return "codex";
    }
  });
  // Tool access for AI requests: "everything your CLI has" unless narrowed here.
  const [toolAccess, setToolAccessState] = useState<AiToolAccess>(() => {
    try {
      const stored = window.localStorage.getItem("nebula-writer-tool-access");
      return isAiToolAccess(stored) ? stored : DEFAULT_AI_TOOL_ACCESS;
    } catch {
      return DEFAULT_AI_TOOL_ACCESS;
    }
  });
  const setToolAccess = useCallback((next: AiToolAccess) => {
    setToolAccessState(next);
    try {
      window.localStorage.setItem("nebula-writer-tool-access", next);
    } catch {
      // Storage unavailable; the choice just won't persist.
    }
  }, []);
  const setProvider = useCallback((next: InteractiveProviderName) => {
    setProviderState(next);
    try {
      window.localStorage.setItem("nebula-writer-provider", next);
    } catch {
      // storage unavailable — selection just won't persist
    }
  }, []);
  const [maxSuggestionsInput, setMaxSuggestionsInput] = useState("");
  const [userRoutines, setUserRoutines] = useState<WritingRoutine[]>(() => loadUserRoutines());
  const [savePromptFormOpen, setSavePromptFormOpen] = useState(false);
  const [routineName, setRoutineName] = useState("");
  const [starterPromptsOpen, setStarterPromptsOpen] = useState(false);
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
  const [r01RoutinePanelOpen, setR01RoutinePanelOpen] = useState(false);
  const [routineSequenceIndex, setRoutineSequenceIndex] = useState(0);
  const [loadedSequenceRoutineId, setLoadedSequenceRoutineId] = useState<string | null>(null);
  const [loadedRoutineIntent, setLoadedRoutineIntent] = useState<RoutineIntent | null>(null);
  const [sequenceReviewHandoff, setSequenceReviewHandoff] = useState<SequenceReviewHandoff | null>(null);
  const [sequenceExportSummary, setSequenceExportSummary] = useState<SequenceExportSummary | null>(null);
  const [completedSequenceRoutineIds, setCompletedSequenceRoutineIds] = useState<string[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  // True once a health probe has failed with no earlier success — locally
  // that means the sidecar isn't running (the page itself came from vite).
  const [healthProbeFailed, setHealthProbeFailed] = useState(false);
  const cloudMode = health?.cloud === true;
  // Local-first mode: the app is served by the local sidecar (same origin as
  // AI + the terminal). The agent terminal embeds inline here; on the cloud
  // origin it can't (cross-origin), so it points the user to their local Writer.
  const localMode = health?.local === true;
  // "Run npm run sidecar from the repo" only makes sense on the machine that
  // serves the app. A hosted page (writer.zhoulab.io, a LAN share) is viewed
  // by people who may not have the repo at all, so their setup must start from
  // git clone. localhost is the only origin where the repo is guaranteed
  // present (vite served this very page from it).
  const isLocalHost = useMemo(() => {
    if (typeof window === "undefined") {
      return true;
    }
    return isLocalHostname(window.location.hostname);
  }, []);
  // Personal AI runner: on cloud deployments, each visitor's browser probes
  // their OWN machine's Writer sidecar; when it's up, AI requests run on
  // their CLI account instead of the shared bridge.
  const [localAi, setLocalAi] = useState<HealthResponse | null>(null);
  const [setupGuideOpen, setSetupGuideOpen] = useState(false);
  const inSafari = useMemo(() => typeof navigator !== "undefined" && isSafariBrowser(navigator.userAgent), []);
  const localAiActive = cloudMode && localAi !== null;
  const localAiActiveRef = useRef(false);
  localAiActiveRef.current = localAiActive;
  const healthForAi = localAiActive ? localAi : health;
  // Why AI is unusable right now, if it is. Nothing meaningful works without
  // a provider, so this single value drives the onboarding guide: the cloud
  // deployment has no AI runner connected, the local sidecar is down, its
  // CLIs are missing from PATH, or CLI execution is locked by config.
  const aiSetupReason: "cloud-offline" | "sidecar-down" | "cli-missing" | "cli-locked" | null = (() => {
    if (cloudMode) {
      return !health?.cliEnabled && !localAi ? "cloud-offline" : null;
    }
    if (health === null) {
      return healthProbeFailed ? "sidecar-down" : null;
    }
    if (!(health.providerStatus ?? []).some((status) => status.available)) {
      return "cli-missing";
    }
    if (!health.cliEnabled) {
      return "cli-locked";
    }
    return null;
  })();
  const aiSetupReasonRef = useRef(aiSetupReason);
  aiSetupReasonRef.current = aiSetupReason;
  // No usable AI provider: open the onboarding guide — connecting one is the
  // prerequisite for everything else. Auto-opens once per browsing session
  // (dismissing sticks until the next visit, and the "Set up AI" button
  // reopens it any time).
  useEffect(() => {
    if (aiSetupReason === null) {
      return;
    }
    try {
      if (window.sessionStorage.getItem("nebula-writer-ai-setup-dismissed")) {
        return;
      }
    } catch {
      return;
    }
    setSetupGuideOpen(true);
  }, [aiSetupReason]);

  function dismissSetupGuide() {
    setSetupGuideOpen(false);
    try {
      window.sessionStorage.setItem("nebula-writer-ai-setup-dismissed", "1");
    } catch {
      // Private browsing; the guide just reappears next visit.
    }
  }

  useEffect(() => {
    if (!cloudMode || import.meta.env.MODE === "test") {
      return;
    }
    let cancelled = false;
    const probe = () => {
      getLocalAiHealth()
        .then((result) => {
          if (!cancelled) {
            setLocalAi(result.ok && result.cliEnabled ? result : null);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setLocalAi(null);
          }
        });
    };
    probe();
    const interval = window.setInterval(probe, 20000);
    window.addEventListener("focus", probe);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", probe);
    };
  }, [cloudMode]);
  const [instruction, setInstruction] = useState("");
  // Reference files attached to the next AI request. The file rides to the
  // sidecar (the machine the CLI runs on); the chip here holds the returned
  // { name, path, text } and clears once the request is sent.
  const [pendingAttachments, setPendingAttachments] = useState<AiAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [agentTerminalBusy, setAgentTerminalBusy] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  // Agentic engine conversations: one CLI session per document+provider so
  // follow-up chat messages share context. Keyed client-side; the sidecar
  // just resumes whatever id we hand it.
  const agentSessionsRef = useRef<Record<string, string>>({});
  // Start over with the AI: forget every provider session for this document and
  // reset the transcript. Pending suggestions and attachments stay (parity with
  // the Word pane's "Start a new conversation").
  const startNewConversation = useCallback(() => {
    agentSessionsRef.current = {};
    setMessages([createSystemMessage("New conversation — earlier turns are no longer sent to the AI. Pending suggestions and attachments stay.")]);
  }, []);
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  // A selection is not a "mode": it's context that auto-attaches to the next
  // message and can be detached (or re-attached) with one click.
  const [detachedSelectionKey, setDetachedSelectionKey] = useState<string | null>(null);
  const currentSelectionKey = selection ? `${selection.from}:${selection.to}:${selection.text.length}` : null;
  const selectionAttached = Boolean(selection && detachedSelectionKey !== currentSelectionKey);
  const scope: "global" | "selection" = selectionAttached ? "selection" : "global";
  function setScope(next: "global" | "selection") {
    setDetachedSelectionKey(next === "global" ? currentSelectionKey : null);
  }
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("pending");
  const [reviewSearchQuery, setReviewSearchQuery] = useState("");
  const [showSourceRevisionsInDocument, setShowSourceRevisionsInDocument] = useState(false);
  const [highlightSourceRevisionsInline, setHighlightSourceRevisionsInline] = useState(false);
  const [sourceRevisionSearchQuery, setSourceRevisionSearchQuery] = useState("");
  const [activeSourceRevisionIndex, setActiveSourceRevisionIndex] = useState(0);
  const [wordCommentOverlapOnly, setWordCommentOverlapOnly] = useState(false);
  const [manualMissingTargetSuggestionIds, setManualMissingTargetSuggestionIds] = useState<string[]>([]);
  const [sourceDocumentId, setSourceDocumentId] = useState<string | null>(null);
  // True only when the current document came from a real imported DOCX (a
  // source package exists server-side for source-preserving export).
  const [sourceDocxImported, setSourceDocxImported] = useState(false);
  const [sourceFeatures, setSourceFeatures] = useState<DocxFeatureSummary | null>(null);
  const [sourceTrackedChanges, setSourceTrackedChanges] = useState<SourceTrackedChangePreview[]>([]);
  const [docxBodySafeAnchors, setDocxBodySafeAnchors] = useState<string[]>([]);
  const [docxBodySafeAnchorDetails, setDocxBodySafeAnchorDetails] = useState<DocxBodySafeAnchor[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    // Scratch drafts keep their chat in this browser; shared documents
    // rehydrate from the session instead.
    if (!parseDocIdFromLocation()) {
      try {
        const saved = window.localStorage.getItem("nebula-writer-scratch-chat");
        const parsed = saved ? JSON.parse(saved) as ChatMessage[] : null;
        if (Array.isArray(parsed) && parsed.length) {
          return parsed;
        }
      } catch {
        // Fall through to the default greeting.
      }
    }
    return [createSystemMessage()];
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestionSyncFailureCount, setSuggestionSyncFailureCount] = useState(0);
  const [suggestionSyncRetrying, setSuggestionSyncRetrying] = useState(false);
  const [aiProgressNote, setAiProgressNote] = useState<string | null>(null);
  // Latest stage of the AI request this tab is waiting on: pushed over the
  // /events socket as it changes, with GET /api/ai/progress as the fallback.
  const liveAiProgressRef = useRef<{ stage: string; passIndex: number | null; passTotal: number | null; startedAt: string } | null>(null);
  const [remoteAiProgress, setRemoteAiProgress] = useState<{ provider: string; requestedBy: string | null; stage: string } | null>(null);
  const [remoteAiQueue, setRemoteAiQueue] = useState<Array<{ provider: string; requestedBy: string | null }>>([]);
  const [documentNoteDetail, setDocumentNoteDetail] = useState("");
  // Import conversion notes shown as a persistent, dismissible banner —
  // fidelity warnings must survive the next transient status note.
  const [importFidelityNotices, setImportFidelityNotices] = useState<ImportFidelityNotice[]>([]);
  const [reviewPersonFilter, setReviewPersonFilter] = useState<string | null>(null);
  const [reviewActivityOpen, setReviewActivityOpen] = useState(false);
  const [collaborators, setCollaborators] = useState<Array<{ color: string; name: string }>>([]);
  const [ownTabCount, setOwnTabCount] = useState(1);
  const [collabConnection, setCollabConnection] = useState<"connected" | "connecting" | "disconnected" | null>(null);
  const [syncOutage, setSyncOutage] = useState(false);
  const [aiPaneSplit, setAiPaneSplit] = useState(() => {
    try {
      const saved = Number.parseFloat(window.localStorage.getItem("nebula-writer-ai-split") ?? "");
      return Number.isFinite(saved) && saved >= 0.2 && saved <= 0.8 ? saved : 0.48;
    } catch {
      return 0.48;
    }
  });
  // Clean view (docs/suggesting-mode.md): preview the document with every
  // suggestion applied — insertions plain, deletions hidden. View-only while
  // active so hidden text can't be edited around; session-only state.
  const [cleanView, setCleanView] = useState(false);
  // In-document controls: clicking a suggestion mark opens a small popover
  // with Accept/Reject at the pointer (docs/suggesting-mode.md "inline ...
  // accept/reject"). The editor's DOM click handler is created once, so it
  // reads the current cluster list through a ref.
  const [markPopover, setMarkPopover] = useState<{ x: number; y: number; suggestion: AiSuggestion } | null>(null);
  const inlineMarkSuggestionsRef = useRef<AiSuggestion[]>([]);

  // Local mode: the agent terminal docks under the editor (Chrome-devtools
  // style) and folds to a slim bar; persisted per browser.
  const [terminalDockOpen, setTerminalDockOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("nebula-terminal-dock") !== "folded";
    } catch {
      return true;
    }
  });
  function toggleTerminalDock() {
    setTerminalDockOpen((open) => {
      const next = !open;
      try {
        window.localStorage.setItem("nebula-terminal-dock", next ? "open" : "folded");
      } catch {
        // private mode — session-only
      }
      if (next) {
        // Deliberate open: hand the keyboard to the terminal. (The terminal
        // never takes focus on its own — socket connects are not user intent.)
        window.setTimeout(() => {
          document.querySelector<HTMLElement>(".terminal-dock .xterm-helper-textarea")?.focus();
        }, 120);
      }
      return next;
    });
  }
  const [collapsedAiPanel, setCollapsedAiPanel] = useState<"chat" | "review" | null>(() => {
    try {
      const saved = window.localStorage.getItem("nebula-writer-ai-collapsed");
      return saved === "chat" || saved === "review" ? saved : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem("nebula-writer-ai-split", String(aiPaneSplit));
      if (collapsedAiPanel) {
        window.localStorage.setItem("nebula-writer-ai-collapsed", collapsedAiPanel);
      } else {
        window.localStorage.removeItem("nebula-writer-ai-collapsed");
      }
    } catch {
      // Ignore.
    }
  }, [aiPaneSplit, collapsedAiPanel]);

  function toggleAiPanelCollapse(panel: "chat" | "review") {
    setCollapsedAiPanel((current) => (current === panel ? null : panel));
  }

  function startAiPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const pane = event.currentTarget.parentElement;
    if (!pane) {
      return;
    }
    event.preventDefault();
    const rect = pane.getBoundingClientRect();
    const move = (pointer: PointerEvent) => {
      const ratio = Math.min(0.8, Math.max(0.2, (pointer.clientY - rect.top) / rect.height));
      setAiPaneSplit(ratio);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  const syncFailureStreakRef = useRef(0);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareInfo, setShareInfo] = useState<{ sharable: boolean; shareUrls: string[] } | null>(null);
  const [shareUrlCopied, setShareUrlCopied] = useState(false);
  const [collabNameDraft, setCollabNameDraft] = useState("");
  const [autoAdvanceReview, setAutoAdvanceReview] = useState(() => {
    try {
      return window.localStorage.getItem("nebula-writer-auto-advance-review") !== "0";
    } catch {
      return true;
    }
  });
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);
  const [providerCheck, setProviderCheck] = useState<ProviderSmokeResponse | null>(null);
  const [documentNote, setDocumentNote] = useState("Unsaved local draft");
  // Status notes are transient: they confirm an action, then get out of the
  // way (the persistent facts live in the title field and detail pills).
  useEffect(() => {
    if (!documentNote) {
      return;
    }
    const timer = window.setTimeout(() => { setDocumentNote(""); setDocumentNoteDetail(""); }, 6000);
    return () => window.clearTimeout(timer);
  }, [documentNote]);
  const [sharedSession, setSharedSession] = useState<WriterSessionSummary | null>(null);
  const [lastExportReport, setLastExportReport] = useState<ExportReport | null>(null);
  const [lastExportContext, setLastExportContext] = useState<RoutineIntent | null>(null);
  const [lastExportFilename, setLastExportFilename] = useState<string | null>(null);
  const [emptyAiResult, setEmptyAiResult] = useState<EmptyAiResult | null>(null);
  const [copiedArtifactRunId, setCopiedArtifactRunId] = useState<string | null>(null);
  const [copiedRoutineSummaryRunId, setCopiedRoutineSummaryRunId] = useState<string | null>(null);
  const [copiedSuggestionId, setCopiedSuggestionId] = useState<string | null>(null);
  const [copiedOverlapGroupSuggestionId, setCopiedOverlapGroupSuggestionId] = useState<string | null>(null);
  const [copiedVisibleSuggestionSignature, setCopiedVisibleSuggestionSignature] = useState<string | null>(null);
  const [dismissedBacklogSummarySignature, setDismissedBacklogSummarySignature] = useState<string | null>(null);
  const [visibleSuggestionCopyText, setVisibleSuggestionCopyText] = useState("");
  const [overlapGroupCopyText, setOverlapGroupCopyText] = useState<{ suggestionId: string; title: string; text: string } | null>(null);
  const [routineSummaryCopyText, setRoutineSummaryCopyText] = useState<{ runId: string; text: string } | null>(null);
  const [routineEditsCopyText, setRoutineEditsCopyText] = useState<{ runId: string; text: string } | null>(null);
  const [routineWordCommentsCopyText, setRoutineWordCommentsCopyText] = useState<{ runId: string; text: string } | null>(null);
  const [autosavedSessions, setAutosavedSessions] = useState<WriterAutosavedSessionSummary[]>([]);
  const [autosaveMenuOpen, setAutosaveMenuOpen] = useState(false);
  const [autosaveSessionsLoading, setAutosaveSessionsLoading] = useState(false);
  const [editorTrackedChanges, setEditorTrackedChanges] = useState<EditorTrackedChange[]>([]);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionInputRef = useRef<HTMLInputElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const autosaveMenuRef = useRef<HTMLDivElement | null>(null);
  const shareMenuRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const routineNameInputRef = useRef<HTMLInputElement | null>(null);
  const aiRequestInFlightRef = useRef(false);
  const aiAbortControllerRef = useRef<AbortController | null>(null);
  const aiRequestSeqRef = useRef(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const suggestionCardRefs = useRef(new Map<string, HTMLElement>());
  const pendingSuggestionCardScrollRef = useRef<string | null>(null);
  const pendingSuggestionEditorCenterRef = useRef<string | null>(null);
  const activeSuggestionUpdateFrameRef = useRef<number | null>(null);
  const instantLocatedSuggestionIdRef = useRef<string | null>(null);
  const relocatedAcceptConfirmRef = useRef<string | null>(null);
  const failedStatusSyncsRef = useRef(new Map<string, AiSuggestion["status"]>());
  const acceptedReviewTracesRef = useRef<ReviewTrace[]>([]);
  const userReviewTracesRef = useRef<ReviewTrace[]>([]);
  // Running user edit, so consecutive keystrokes coalesce into one tracked
  // change instead of one-per-character, and backspacing just-typed text
  // shrinks/cancels that insertion instead of logging a deletion.
  const [collabMetaVersion, setCollabMetaVersion] = useState(0);

  // Per-document key under which this browser persists user tracked changes so
  // they survive a refresh (the document text already persists via Yjs/local
  // autosave; the annotation layer did not, until now).
  const restoredTrackedForDocRef = useRef<string | null>(null);
  // Per-user edit mode (Google-Docs style). Local, persisted per browser.
  // Shared docs default to Editing; AI always suggests regardless.
  const [editMode, setEditMode] = useState<"editing" | "suggesting">(() => {
    try {
      return window.localStorage.getItem("nebula-writer-edit-mode") === "suggesting" ? "suggesting" : "editing";
    } catch {
      return "editing";
    }
  });
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;
  useEffect(() => {
    try {
      window.localStorage.setItem("nebula-writer-edit-mode", editMode);
    } catch {
      // ignore
    }
  }, [editMode]);
  const pendingSuggestionsRef = useRef<AiSuggestion[]>([]);
  const syncedChatMessageIdsRef = useRef(new Set<string>());
  const reviewNavigationPointerDownRef = useRef<{ container: HTMLElement; x: number; y: number } | null>(null);
  const visibleCopyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlapGroupCopyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const routineSummaryCopyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const routineEditsCopyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const routineWordCommentsCopyTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const suppressUserTrackingRef = useRef(false);
  const lastEditorTextSnapshotRef = useRef<string | null>(null);
  const sharedSessionDocumentLoadingRef = useRef(false);
  const pendingSharedSessionLoadRef = useRef(false);
  const generalRoutinePresets = generalBuiltInRoutines;
  const showR01RoutinePath = isR01WritingContext({
    completedRoutineIds: completedSequenceRoutineIds,
    documentNote,
    documentTitle,
    loadedRoutineIntent,
    sourceDocumentId
  });

  // Document identity: null = a private scratch draft (clean slate at the root
  // URL); a docId means we are in that document's shared room. Changing it
  // recreates the editor bound to the new room's Yjs doc.
  const [docId, setDocIdState] = useState<string | null>(() => parseDocIdFromLocation());
  // Cloud-synced sharing: when the URL carries &sync=cloud (or the user starts
  // sharing), this doc's room is bridged through the cloud relay so
  // collaborators' own local Writers converge on it.
  const [cloudSynced, setCloudSynced] = useState<boolean>(() => parseCloudSyncFromLocation());
  const pendingRoomSeedRef = useRef<{
    docId: string;
    html: string;
    session?: WriterSessionSummary;
    sessionNotes?: { documentNote: string; systemMessage: string };
    /** Word revisions from a fresh DOCX import, materialized as inline suggestion marks after seeding. */
    sourceTrackedChanges?: SourceTrackedChangePreview[];
  } | null>(null);
  const collabSession = useMemo(() => getCollabSession(docId), [docId]);

  // Keep the cloud bridge alive for cloud-synced docs: the LOCAL server joins
  // the cloud relay room (text + presence + suggestion map). Idempotent; the
  // server owns the connection, so a page reload doesn't drop collaborators.
  useEffect(() => {
    if (!docId || !cloudSynced || !localMode) {
      return;
    }
    writeCloudSyncToLocation();
    void ensureCollabBridge(docId).catch(() => {
      // Local server unreachable — the health probe surfaces that separately.
    });
  }, [docId, cloudSynced, localMode]);
  const docIdRef = useRef(docId);
  docIdRef.current = docId;

  useEffect(() => {
    // Re-bind to the active room's meta map whenever the session changes; a
    // stale binding (from before an in-tab room switch) would stop tracking the
    // live doc's sessionId stamp and metadata adoption would miss it.
    const meta = collabSession.doc.getMap("nebula-meta");
    const bump = () => setCollabMetaVersion((version) => version + 1);
    meta.observe(bump);
    bump();
    return () => meta.unobserve(bump);
  }, [collabSession]);

  // Refresh-proofing: scratch chat, the composer draft, and (elsewhere) the
  // scratch document itself persist in this browser.

  // Recent shared documents, for the clean-slate launcher.
  const recentDocs = useMemo<Array<{ id: string; name: string }>>(() => {
    if (docId) {
      return [];
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem("nebula-writer-recent-docs") ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === "string") : [];
    } catch {
      return [];
    }
  }, [docId]);

  useEffect(() => {
    if (!docId || !sharedSession || sharedSession.sourceDocumentId !== docId) {
      return;
    }
    try {
      const raw = JSON.parse(window.localStorage.getItem("nebula-writer-recent-docs") ?? "[]");
      const existing = Array.isArray(raw) ? raw.filter((entry) => entry && entry.id !== docId) : [];
      const next = [{ id: docId, name: sharedSession.title || sharedSession.name }, ...existing].slice(0, 8);
      window.localStorage.setItem("nebula-writer-recent-docs", JSON.stringify(next));
    } catch {
      // Ignore.
    }
  }, [docId, sharedSession]);

  useEffect(() => {
    if (docId) {
      return;
    }
    try {
      window.localStorage.setItem("nebula-writer-scratch-chat", JSON.stringify(messages.slice(-100)));
    } catch {
      // Storage full/unavailable; chat just won't survive a refresh.
    }
  }, [docId, messages]);

  useEffect(() => {
    try {
      const key = `nebula-writer-composer:${docId ?? "local"}`;
      if (instruction) {
        window.localStorage.setItem(key, instruction);
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      // Ignore.
    }
  }, [docId, instruction]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(`nebula-writer-composer:${docId ?? "local"}`);
      if (saved) {
        setInstruction((current) => current || saved);
      }
    } catch {
      // Ignore.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const linkForOtherBrowser = useMemo(() => {
    const token = getStoredShareToken();
    const base = `${window.location.origin}/${token ? `#share=${token}` : ""}`;
    return docId ? documentShareUrl(base, docId) : base;
  }, [docId]);
  const eventsReconnectRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    // Closing triggers the socket's own reconnect, which picks up the new doc.
    eventsReconnectRef.current?.();
  }, [docId]);

  function adoptDocId(nextDocId: string) {
    if (nextDocId === docId) {
      return;
    }
    writeDocIdToLocation(nextDocId);
    setDocIdState(nextDocId);
  }

  // Freshly loaded/seeded content is the document's BASELINE, not an edit the
  // user made — so it must not sit in the undo history. Two harms if it does:
  // undo can silently erase a document you just opened, and — worse —
  // mashing Cmd-Z past all content to the empty doc triggers a Yjs
  // reconciliation the undo manager captures as a new item, which destroys the
  // redo stack (Cmd-Shift-Z then can't bring the draft back). Clearing the
  // undo manager after a seed makes the seed the earliest undo state, so a
  // storm stops there instead of emptying the doc. Deferred a frame so the
  // seed transaction has settled into the Yjs history first.
  // Toolbar buttons must not steal focus from the editor on mousedown, or the
  // first keystroke after a click is lost. Applied to every format button.
  function preventEditorBlur(event: ReactPointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
  }

  function resetUndoBaseline(target: Editor | null) {
    const activeEditor = target ?? editor;
    if (!activeEditor) {
      return;
    }
    requestAnimationFrame(() => {
      try {
        const undoManager = yUndoPluginKey.getState(activeEditor.state)?.undoManager as
          | { clear: () => void }
          | undefined;
        undoManager?.clear();
      } catch {
        // y-undo not bound yet (no collab provider) — nothing to reset.
      }
    });
  }

  // Pasting a #doc= link into an already-open tab only changes the fragment —
  // no page load happens — so follow hash changes to join (or leave) rooms.
  useEffect(() => {
    function handleHashChange() {
      const next = parseDocIdFromLocation();
      setDocIdState((current) => (next === current ? current : next));
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3]
        },
        paragraph: false,
        // Collaboration provides Yjs-backed undo/redo; the built-in history
        // plugin conflicts with it.
        history: false
      }),
      Collaboration.configure({
        document: collabSession.doc
      }),
      ...(collabSession.provider
        ? [CollaborationCursor.configure({
          provider: collabSession.provider,
          user: collabSession.user
        })]
        : []),
      DocxParagraph,
      DocxEquation,
      Link.configure({
        openOnClick: false,
        autolink: false
      }),
      Image.configure({
        allowBase64: true,
        inline: false
      }),
      Table.configure({
        resizable: false
      }),
      TableRow,
      TableHeader,
      TableCell,
      Underline,
      Subscript,
      Superscript,
      Placeholder.configure({
        placeholder: "Start writing, paste text, or import a DOCX..."
      }),
      ReviewHighlight,
      SourceRevisionHighlight,
      HeadingEnter,
      UndoGuard,
      SuggestionInsertion,
      SuggestionDeletion,
      SuggestingRouter.configure({
        // Programmatic edits (AI suggestion applies, undo replays) must not be
        // re-routed into suggestion marks, so honor the same suppression flag
        // the diff tracker uses.
        isSuggesting: () => editModeRef.current === "suggesting" && !suppressUserTrackingRef.current,
        getAuthor: () => ({
          author: collabSession.user.identity,
          authorName: collabSession.user.name,
          color: collabSession.user.color,
          role: "human"
        })
      }),
      RetainedSelection
    ],
    // No static initial content: with collaboration the document state lives in
    // the shared Yjs doc and is seeded once after the first sync (see below).
    editorProps: {
      attributes: {
        class: "document-surface",
        "aria-label": "Document editor"
      },
      handleDOMEvents: {
        click: (view, event) => {
          const markSpan = event.target instanceof Element
            ? event.target.closest("[data-suggestion-insertion], [data-suggestion-deletion]")
            : null;
          if (markSpan && view.dom.contains(markSpan)) {
            const pos = view.posAtDOM(markSpan, 0);
            const cluster = inlineMarkSuggestionsRef.current.find((candidate) => candidate.range
              && pos >= candidate.range.from - 1 && pos <= candidate.range.to + 1);
            if (cluster) {
              setMarkPopover({ x: event.clientX, y: event.clientY, suggestion: cluster });
              return true;
            }
          }
          setMarkPopover(null);
          return handleEditorTraceDomClick(event);
        }
      }
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      updateSelectionFromEditor(activeEditor);
    },
    onUpdate: ({ editor: activeEditor }) => {
      // The diff-based human audit log is retired (suggestion marks are the
      // tracking); keep the snapshot baseline other flows compare against.
      lastEditorTextSnapshotRef.current = editorTextSnapshot(activeEditor).text;
      updateSelectionFromEditor(activeEditor);
    }
    // Recreate the editor whenever the document room changes.
  }, [collabSession]);

  // Opt-in inspection hook for the self-test harness (?devtools): exposes the
  // live editor so tests can read undo-manager state, marks, and selection —
  // no production behavior change without the flag.
  useEffect(() => {
    if (editor && new URLSearchParams(window.location.search).has("devtools")) {
      (window as unknown as { __nebulaEditor?: unknown }).__nebulaEditor = editor;
    }
  }, [editor]);

  // Health probe. While AI is unusable it re-polls: the sidecar re-resolves
  // the CLIs on every /api/health call (and the cloud worker re-checks its
  // bridge), so installing a CLI or starting the sidecar lights the
  // providers up without a reload. Transient failures keep the last known
  // health rather than misreporting a working setup as gone.
  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      void getHealth()
        .then((result) => {
          if (!cancelled) {
            setHealth(result);
            setHealthProbeFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHealthProbeFailed(true);
          }
        });
    };
    probe();
    if (import.meta.env.MODE === "test") {
      return () => {
        cancelled = true;
      };
    }
    const reprobeIfBlocked = () => {
      if (aiSetupReasonRef.current !== null) {
        probe();
      }
    };
    const interval = window.setInterval(reprobeIfBlocked, 20000);
    window.addEventListener("focus", reprobeIfBlocked);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", reprobeIfBlocked);
    };
  }, []);

  // When the blocker clears (CLI installed, sidecar started, bridge or local
  // runner connected), close the auto-opened guide and confirm out loud.
  const previousAiSetupReason = useRef(aiSetupReason);
  useEffect(() => {
    const wasBlocked = previousAiSetupReason.current !== null;
    previousAiSetupReason.current = aiSetupReason;
    if (wasBlocked && aiSetupReason === null && setupGuideOpen) {
      setSetupGuideOpen(false);
      setDocumentNote("AI is ready — provider detected.");
    }
  }, [aiSetupReason, setupGuideOpen]);

  useEffect(() => {
    if (!editor || docId) {
      return;
    }
    let timer: number | null = null;
    const save = () => {
      try {
        window.localStorage.setItem("nebula-writer-scratch-draft", editor.getHTML());
      } catch {
        // Ignore.
      }
    };
    const onUpdate = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(save, 800);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [editor, docId]);

  // Room content bootstrap, run once per (editor, room) pair after first sync:
  // 1. A pending seed (we just imported/created this document) writes content.
  // 2. Joining an existing room: content arrives via sync; if the room is
  //    empty (e.g. after a sidecar restart), pull the document from the
  //    session and seed it.
  // 3. A private scratch room seeds the welcome document.
  useEffect(() => {
    if (!editor) {
      return;
    }
    whenCollabSynced(collabSession, (synced) => {
      if (editor.isDestroyed) {
        return;
      }
      // Effects can run while the previous room's editor is still mounted
      // (recreation happens in useEditor's own effect). Only proceed once the
      // editor is genuinely bound to this room's Yjs doc.
      const collabExtension = editor.extensionManager.extensions.find((extension) => extension.name === "collaboration");
      if (collabExtension && (collabExtension.options as { document?: unknown }).document !== collabSession.doc) {
        return;
      }
      const meta = collabSession.doc.getMap<boolean | string>("nebula-meta");
      const hasContent = Boolean(editor.state.doc.textContent.trim());
      const pendingSeed = pendingRoomSeedRef.current;
      if (pendingSeed && pendingSeed.docId === docId) {
        pendingRoomSeedRef.current = null;
        if (!hasContent) {
          suppressUserTrackingRef.current = true;
          editor.commands.setContent(pendingSeed.html || "<p></p>");
          // Phase 3: a fresh import's Word revisions arrive as actionable
          // inline suggestion marks (only when this client seeds the room —
          // rejoined rooms already carry their marks via Yjs).
          const { materialized, remaining } = materializeSourceTrackedChanges(editor, pendingSeed.sourceTrackedChanges ?? []);
          suppressUserTrackingRef.current = false;
          if (materialized > 0) {
            // Materialized revisions live as marks now; the read-only preview
            // pane keeps only the ones that could not be placed.
            setSourceTrackedChanges(remaining);
            appendMessage("system", `${materialized} tracked change${materialized === 1 ? "" : "s"} from the source DOCX arrived as inline suggestions — accept or reject them in the document.`);
          }
        }
        meta.set("seeded", true);
        meta.set("sessionId", pendingSeed.docId);
        lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
        // Release the tracking hold taken before the room swap (auto-promote)
        // — unconditionally: the hasContent branch above may not have run.
        suppressUserTrackingRef.current = false;
        if (pendingSeed.session && pendingSeed.sessionNotes) {
          // Metadata after content, so suggestion anchors are checked against
          // the real document rather than a still-empty editor.
          applySessionMetadata(pendingSeed.session, pendingSeed.sessionNotes);
        }
        resetUndoBaseline(editor);
        return;
      }
      if (hasContent || meta.get("seeded")) {
        meta.set("seeded", true);
        lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
        // Refresh/rejoin into a live room: the content synced, but chat,
        // suggestions, and title live in the session — rehydrate them.
        if (docId && rehydratedDocRef.current !== docId) {
          rehydratedDocRef.current = docId;
          void getWriterSessionDocument(docId)
            .then((result) => {
              if (result.session && !editor.isDestroyed) {
                applySessionMetadata(result.session, {
                  documentNote: `Rejoined ${result.session.name}`,
                  systemMessage: `Rejoined the shared document ${result.session.name}.`
                });
              }
            })
            .catch(() => undefined);
        }
        return;
      }
      if (docId && !synced && collabSession.provider) {
        // A real provider exists but sync timed out (sidecar down/restarting)
        // and the room is still empty. A matching queued import was already
        // seeded above; here the content lives only on the unreachable server,
        // so surface an offline note instead of hanging on a blank page. Edits
        // merge once sync recovers. (Provider-less local/test sessions fall
        // through to the normal session-pull seed below.)
        setDocumentNote("Live sync is unavailable — working offline; changes will sync when the connection returns.");
        return;
      }
      if (docId) {
        void getWriterSessionDocument(docId)
          .then((result) => {
            // Re-check after the network round-trip: a co-editor recovering the
            // same empty room may have seeded and synced content (or claimed the
            // seed) while this request was in flight. Re-seeding on top would
            // duplicate the document, so bail if content arrived or the room was
            // already claimed by another client.
            if (editor.isDestroyed || editor.state.doc.textContent.trim()) {
              return;
            }
            if (!result.session) {
              // A cloud-synced doc may simply still be arriving through the
              // relay — NEVER drop its id (that silently reverts the user to a
              // private draft while they think they're on the shared doc).
              // Content will appear via Yjs sync; the session follows.
              if (cloudSynced) {
                setDocumentNote("Connecting to the shared document through the relay…");
                return;
              }
              // No session for this id and the room is empty: either a dead
              // share link, or — critically — an id the user navigated to
              // directly (a bookmark, a hand-typed link). Do NOT clear the id
              // and mint a new private draft: that silently strands whatever
              // they write in a different room, so reopening the id they see in
              // their URL shows nothing. Instead ADOPT this id as a fresh local
              // draft — mark the room seeded so it persists here, and any typing
              // saves to the id in the address bar. (A truly dead link simply
              // becomes a new blank doc under that id, which is what the user
              // clicked anyway.)
              setDocumentNote("Starting a new document here.");
              collabSession.doc.transact(() => {
                meta.set("seeded", true);
                meta.set("seededBy", collabSession.user.identity);
              });
              lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
              resetUndoBaseline(editor);
              return;
            }
            applySessionMetadata(result.session, {
              documentNote: `Opened shared document: ${result.session.name}`,
              systemMessage: `Opened ${result.session.name} from its share link.`
            });
            // Claim the seed atomically: only the client that flips "seeded"
            // from unset writes the content; a loser that observes the winner's
            // claim skips setContent (metadata rehydration above still runs).
            let wonSeedClaim = false;
            collabSession.doc.transact(() => {
              if (!meta.get("seeded")) {
                meta.set("seeded", true);
                meta.set("seededBy", collabSession.user.identity);
                wonSeedClaim = true;
              }
            });
            if (!wonSeedClaim) {
              return;
            }
            suppressUserTrackingRef.current = true;
            editor.commands.setContent(result.session.documentHtml || "<p></p>");
            suppressUserTrackingRef.current = false;
            meta.set("sessionId", result.session.sourceDocumentId);
            lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
            resetUndoBaseline(editor);
          })
          .catch(() => undefined);
        return;
      }
      meta.set("seeded", true);
      let scratchDraft: string | null = null;
      try {
        scratchDraft = window.localStorage.getItem("nebula-writer-scratch-draft");
      } catch {
        scratchDraft = null;
      }
      const hasDraft = Boolean(scratchDraft && scratchDraft.replace(/<[^>]+>/g, "").trim());
      suppressUserTrackingRef.current = true;
      editor.commands.setContent(hasDraft ? (scratchDraft as string) : starterDocument);
      lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
      suppressUserTrackingRef.current = false;
      resetUndoBaseline(editor);
      if (hasDraft) {
        setDocumentNote("Restored your draft from this browser");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, collabSession, docId]);

  // Track who else is in the live document (names/colors shown on their cursors).
  useEffect(() => {
    const awareness = collabSession.provider?.awareness;
    if (!awareness) {
      // Switched into a private/scratch room with no live presence: clear any
      // collaborators left over from the previous shared room.
      setCollaborators([]);
      setOwnTabCount(1);
      return;
    }
    const updateCollaborators = () => {
      // Dedupe by stable browser identity so the same person's extra tabs or a
      // reload's lingering presence collapses to one entry — and never count
      // our own identity, even from another tab.
      const byIdentity = new Map<string, { color: string; name: string }>();
      let ownTabs = 0;
      awareness.getStates().forEach((state) => {
        const user = (state as { user?: { color?: string; identity?: string; name?: string } }).user;
        // Presence requires the stable identity field: connections without one
        // are stale pages running an old bundle, not real collaborators.
        if (!user?.name || !user.identity) {
          return;
        }
        if (user.identity === collabSession.user.identity) {
          ownTabs += 1;
          return;
        }
        if (!byIdentity.has(user.identity)) {
          byIdentity.set(user.identity, { color: user.color ?? "#1a73e8", name: user.name });
        }
      });
      setCollaborators([...byIdentity.values()]);
      setOwnTabCount(Math.max(1, ownTabs));
    };
    updateCollaborators();
    awareness.on("change", updateCollaborators);
    return () => awareness.off("change", updateCollaborators);
    // Re-subscribe when the session changes: after an in-tab room switch (share
    // link, DOCX import) the previous binding would leave the presence list
    // stale, and a scratch-to-shared transition would never attach at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collabSession]);

  useEffect(() => {
    saveUserRoutines(userRoutines);
  }, [userRoutines]);

  useEffect(() => {
    if (!sharedSession || sharedSession.sourceDocumentId !== sourceDocumentId || !sharedSession.routineProgress?.length) {
      return;
    }
    const restored = restoreSequenceProgress(sourceDocumentId, sharedSession.routineProgress);
    setCompletedSequenceRoutineIds((current) => areStringArraysEqual(current, restored) ? current : restored);
  }, [sharedSession, sourceDocumentId]);

  useEffect(() => {
    if (!showR01RoutinePath && r01RoutinePanelOpen) {
      setR01RoutinePanelOpen(false);
    }
  }, [r01RoutinePanelOpen, showR01RoutinePath]);

  useEffect(() => {
    let cancelled = false;

    async function refreshSharedSession() {
      try {
        // In a document room, follow that document's session; at the root,
        // surface whatever document is live so the join pill can offer it.
        const result = await getWriterSession(docIdRef.current ?? undefined);
        if (!cancelled) {
          setSharedSession(result.session);
          syncFailureStreakRef.current = 0;
          setSyncOutage(false);
        }
      } catch {
        if (!cancelled) {
          setSharedSession(null);
          // Only a joined document has something to lose; surface persistent
          // failure instead of letting the session quietly go stale.
          if (docIdRef.current) {
            syncFailureStreakRef.current += 1;
            if (syncFailureStreakRef.current >= 3) {
              setSyncOutage(true);
            }
          }
        }
      }
    }

    void refreshSharedSession();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void refreshSharedSession();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    // The /events push channel delivers every session mutation instantly, so
    // the periodic poll is only a FALLBACK for when that socket is down. On a
    // metered host (Cloudflare bills every request) an always-on 30s poll
    // burns ~2,880 requests/day per idle/background tab for nothing, so it
    // runs only while the push channel is disconnected and the tab is visible.
    let eventsConnected = false;
    const interval = window.setInterval(() => {
      if (eventsConnected || document.hidden) {
        return;
      }
      void refreshSharedSession();
    }, 30000);

    let eventsSocket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 3000;
    const MAX_RECONNECT_DELAY = 60000;
    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    const connectEvents = () => {
      if (cancelled || import.meta.env.MODE === "test" || typeof WebSocket === "undefined") {
        return;
      }
      clearReconnect();
      // No room to subscribe to (a scratch draft has no ?doc=, which the cloud
      // rejects 400) or a backgrounded tab: don't open a socket at all. Left
      // ungated, a doc-less or hidden tab reconnected on a fixed 3s timer
      // forever — ~57k Worker requests/day per tab on a metered host, enough to
      // exhaust the free tier. The docId effect and the visibility handler
      // below (re)connect only when it actually matters.
      if (!docIdRef.current || document.hidden) {
        eventsConnected = false;
        return;
      }
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      try {
        const tokenSuffix = shareTokenQuerySuffix();
        const currentDocId = docIdRef.current;
        eventsSocket = new WebSocket(`${protocol}//${window.location.host}/events${tokenSuffix}${currentDocId ? `${tokenSuffix ? "&" : "?"}doc=${encodeURIComponent(currentDocId)}` : ""}`);
      } catch {
        return;
      }
      eventsSocket.onopen = () => {
        eventsConnected = true;
        reconnectDelay = 3000;
      };
      eventsSocket.onmessage = (event) => {
        let payload: { progress?: { provider?: string; stage?: string } | null; type?: string } | null = null;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          payload = null;
        }
        if (payload?.type === "ai-progress") {
          // Someone (a collaborator or an agent) is running an AI request
          // through the shared sidecar — show its live stage to everyone.
          const progress = payload.progress as { provider?: string; requestedBy?: string | null; stage?: string } | null;
          setRemoteAiProgress(progress && progress.provider && progress.stage
            ? { provider: progress.provider, requestedBy: progress.requestedBy ?? null, stage: progress.stage }
            : null);
          const live = payload.progress as { stage?: string; passIndex?: number | null; passTotal?: number | null; startedAt?: string } | null;
          liveAiProgressRef.current = live && live.stage
            ? { stage: live.stage, passIndex: live.passIndex ?? null, passTotal: live.passTotal ?? null, startedAt: live.startedAt ?? new Date().toISOString() }
            : null;
          const queue = (payload as { queue?: Array<{ provider?: string; requestedBy?: string | null }> }).queue;
          setRemoteAiQueue(Array.isArray(queue)
            ? queue.filter((entry) => entry?.provider).map((entry) => ({ provider: entry.provider as string, requestedBy: entry.requestedBy ?? null }))
            : []);
          return;
        }
        void refreshSharedSession();
      };
      eventsSocket.onclose = () => {
        eventsConnected = false;
        // Push channel down: the visible 30s fallback poll (above) catches up,
        // so we don't spend a request refreshing on every close. Reconnect with
        // capped exponential backoff instead of a fixed 3s hammer; connectEvents
        // no-ops while hidden or doc-less, which naturally pauses the loop.
        if (!cancelled) {
          clearReconnect();
          reconnectTimer = window.setTimeout(connectEvents, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        }
      };
      eventsSocket.onerror = () => {
        eventsSocket?.close();
      };
    };
    connectEvents();
    // A docId change reconnects to the right room; if no socket exists yet
    // (scratch draft → opened a doc), start one instead of just closing.
    eventsReconnectRef.current = () => {
      reconnectDelay = 3000;
      if (eventsSocket) {
        eventsSocket.close();
      } else {
        connectEvents();
      }
    };
    // Returning to a visible tab that has a doc but no live socket resumes the
    // push channel (reconnects are paused while hidden to save requests).
    const resumeEventsWhenVisible = () => {
      if (!document.hidden && docIdRef.current && !eventsConnected) {
        reconnectDelay = 3000;
        connectEvents();
      }
    };
    document.addEventListener("visibilitychange", resumeEventsWhenVisible);
    window.addEventListener("focus", resumeEventsWhenVisible);

    return () => {
      cancelled = true;
      eventsReconnectRef.current = null;
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", resumeEventsWhenVisible);
      document.removeEventListener("visibilitychange", resumeEventsWhenVisible);
      clearReconnect();
      eventsSocket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!editor || !pendingSharedSessionLoadRef.current || busy !== null) {
      return;
    }
    pendingSharedSessionLoadRef.current = false;
    void handleLoadSharedSession();
  }, [busy, editor]);

  // Clean-slate principle: visiting the root never auto-loads someone else's
  // live document. The status-row pill offers an explicit join instead.

  useEffect(() => {
    const statuses = healthForAi?.providerStatus ?? [];
    const selected = statuses.find((status) => status.name === provider);
    if (selected && !selected.available) {
      const fallback = statuses.find((status) => status.name !== "demo" && status.available)?.name as InteractiveProviderName | undefined;
      if (fallback && fallback !== provider) {
        setProvider(fallback);
      }
    }
  }, [healthForAi, provider]);

  useEffect(() => {
    setProviderCheck(null);
  }, [provider]);

  useEffect(() => {
    if (!exportMenuOpen && !autosaveMenuOpen && !shareMenuOpen) {
      return;
    }
    function closeToolbarMenus(event: globalThis.MouseEvent) {
      const target = event.target;
      if (target instanceof Node && exportMenuRef.current && !exportMenuRef.current.contains(target)) {
        setExportMenuOpen(false);
      }
      if (target instanceof Node && autosaveMenuRef.current && !autosaveMenuRef.current.contains(target)) {
        setAutosaveMenuOpen(false);
      }
      if (target instanceof Node && shareMenuRef.current && !shareMenuRef.current.contains(target)) {
        setShareMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", closeToolbarMenus);
    return () => window.removeEventListener("mousedown", closeToolbarMenus);
  }, [autosaveMenuOpen, exportMenuOpen, shareMenuOpen]);

  useEffect(() => {
    void refreshAutosavedSessions();
  }, []);

  useEffect(() => {
    if (!editor) {
      return;
    }
    lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    const dom = editor.view.dom;
    const handleClick = (event: globalThis.MouseEvent) => {
      handleEditorTraceDomClick(event);
    };
    dom.addEventListener("click", handleClick, true);
    return () => {
      dom.removeEventListener("click", handleClick, true);
    };
  }, [editor]);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList) {
      return;
    }
    if (typeof messageList.scrollTo === "function") {
      messageList.scrollTo({
        top: messageList.scrollHeight,
        behavior: "smooth"
      });
      return;
    }
    messageList.scrollTop = messageList.scrollHeight;
  }, [busy, messages]);

  // Outbound chat sync: append-only. Each locally created message is sent once
  // by id; the sidecar dedupes, so concurrent writers never erase each other.
  useEffect(() => {
    if (!sourceDocumentId || busy === "Loading shared session" || busy === "Loading session snapshot") {
      return;
    }
    // System messages are per-user workflow narration ("Accepted: X",
    // "Copied…", conflict notices written in first/second person). They are
    // local UI feedback, not conversation — broadcasting them shows a
    // collaborator text that is at best noise and at worst nonsensical on
    // their screen ("Bob already marked… your rejection"). Only the actual
    // conversation — typed prompts and AI responses — syncs.
    const unsynced = messages.filter((message) => message.role !== "system" && message.content.trim() && !syncedChatMessageIdsRef.current.has(message.id));
    if (!unsynced.length) {
      return;
    }
    unsynced.forEach((message) => syncedChatMessageIdsRef.current.add(message.id));
    const expectedSessionId = sharedSession && sharedSession.sourceDocumentId === sourceDocumentId ? sharedSession.id : undefined;
    // No cleanup cancellation: re-renders are frequent right after an AI
    // response, and cancelling here silently dropped marked-as-synced
    // messages. The server dedupes by id, so a stray double-send is harmless.
    window.setTimeout(() => {
      void appendWriterChatMessages(chatMessagesForSession(unsynced), expectedSessionId ? { expectedSessionId } : {})
        .catch(() => {
          // Allow a later effect run to retry these messages.
          unsynced.forEach((message) => syncedChatMessageIdsRef.current.delete(message.id));
        });
    }, 300);
  }, [busy, messages, sharedSession, sourceDocumentId]);

  // Inbound chat sync: merge collaborators' messages by id, ordered by time.
  useEffect(() => {
    if (!sharedSession || sharedSession.sourceDocumentId !== sourceDocumentId || !sharedSession.chatMessages?.length) {
      return;
    }
    const remote = sharedSession.chatMessages.filter((message): message is WriterChatMessage & { id: string } => Boolean(message.id && message.content.trim()));
    if (!remote.length) {
      return;
    }
    setMessages((current) => {
      const knownIds = new Set(current.map((message) => message.id));
      const additions = remote.filter((message) => !knownIds.has(message.id));
      if (!additions.length) {
        return current;
      }
      additions.forEach((message) => syncedChatMessageIdsRef.current.add(message.id));
      const merged = [
        ...current,
        ...additions.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          author: message.author ?? null,
          createdAt: message.createdAt ?? null
        }))
      ];
      return merged.sort((left, right) => {
        const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
        const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
        return leftTime - rightTime;
      });
    });
  }, [sharedSession, sourceDocumentId]);

  useEffect(() => {
    if (!activeSuggestionId) {
      return;
    }
    if (pendingSuggestionCardScrollRef.current !== activeSuggestionId) {
      return;
    }
    pendingSuggestionCardScrollRef.current = null;
    const card = suggestionCardRefs.current.get(activeSuggestionId);
    if (card && typeof card.scrollIntoView === "function") {
      scrollSuggestionCardElementIntoView(card);
    }
  }, [activeSuggestionId]);

  useEffect(() => () => {
    if (activeSuggestionUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(activeSuggestionUpdateFrameRef.current);
      activeSuggestionUpdateFrameRef.current = null;
    }
    if (editor) {
      clearReviewHighlight(editor);
      setReviewTraces(editor, []);
    }
  }, [editor]);

  const pendingSuggestions = useMemo(
    () => suggestions.filter((suggestion) => suggestion.status === "pending"),
    [suggestions]
  );
  useEffect(() => {
    pendingSuggestionsRef.current = pendingSuggestions;
  }, [pendingSuggestions]);
  const exportableEditorTrackedSuggestions = useMemo(
    () => sourceDocumentId ? editorTrackedChanges.map(editorTrackedChangeToSuggestion).filter(isAiSuggestion) : [],
    [editorTrackedChanges, sourceDocumentId]
  );
  // Suggesting-mode edits live as inline marks in the document; this list
  // powers the sidebar cards, the in-document popover, AND the Word review
  // export. Gate on the editor only — NOT on sourceDocumentId: a collaborator
  // who joined via a cloud share link may have no source document, but the
  // marks are in the doc in front of them and must be resolvable.
  // Re-derive on every doc-changing TRANSACTION, not just React re-renders:
  // a remote collaborator's marks arrive via ySync with no local state
  // change, and their card must not wait for an unrelated re-render.
  const [editorDocVersion, setEditorDocVersion] = useState(0);
  useEffect(() => {
    if (!editor) {
      return;
    }
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) {
        setEditorDocVersion((version) => version + 1);
      }
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);
  const suggestionMarkExportSuggestions = useMemo(
    () => editor ? suggestionsFromSuggestionMarks(editor) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, editorDocVersion]
  );
  useEffect(() => {
    inlineMarkSuggestionsRef.current = suggestionMarkExportSuggestions;
    setMarkPopover((current) => {
      if (!current) {
        return current;
      }
      // Keep the popover only while its cluster still exists (someone may
      // have resolved it from the sidebar or another client).
      return suggestionMarkExportSuggestions.some((candidate) => candidate.id === current.suggestion.id) ? current : null;
    });
  }, [suggestionMarkExportSuggestions]);

  const reviewExportSuggestions = useMemo(
    () => mergeReviewExportSuggestions(pendingSuggestions, [...exportableEditorTrackedSuggestions, ...suggestionMarkExportSuggestions]),
    [exportableEditorTrackedSuggestions, pendingSuggestions, suggestionMarkExportSuggestions]
  );
  const hasReviewExportCandidates = reviewExportSuggestions.length > 0;
  const browserTrackedReviewExportCount = exportableEditorTrackedSuggestions.length;
  const reviewExportCandidateCount = reviewExportSuggestions.length;
  const canExportCumulativeReview = Boolean(
    editor
    && sourceDocumentId
    && sharedSession?.sourceDocumentId === sourceDocumentId
    && pendingSuggestions.length > 0
  );
  const cumulativeReviewExportTitle = canExportCumulativeReview
    ? `Export all ${pendingSuggestions.length} current pending edit${pendingSuggestions.length === 1 ? "" : "s"} as one cumulative Word review carrier. Includes every pending suggestion, regardless of the active review filter.`
    : "Load the shared source DOCX session with pending edits before exporting a cumulative review carrier";
  // Source-preserving export needs a REAL imported source DOCX package.
  // sourceDocumentId alone no longer implies one: every local draft gets an id
  // via auto-session/share now, and exporting those must rebuild from the
  // editor HTML (the source-DOCX path 400s without a package).
  const hasSourceDocx = sourceDocxImported || Boolean(sharedSession?.sourceDocument);
  const defaultExportUsesReviewCarrier = Boolean((sourceDocumentId && hasSourceDocx) || hasReviewExportCandidates);
  const defaultExportTitle = sourceDocumentId && hasSourceDocx
    ? "Export a source-preserving review DOCX from the original Word file"
    : hasReviewExportCandidates
      ? "Export a review DOCX with pending changes"
      : "Export a rebuilt DOCX from the browser editor";
  const nextR01Routine = r01RoutineSequence[routineSequenceIndex % r01RoutineSequence.length];
  const completedSequenceRoutineCount = r01RoutineSequence.filter((routine) => completedSequenceRoutineIds.includes(routine.id)).length;
  const loadedSequenceRoutine = loadedSequenceRoutineId
    ? r01RoutineSequence.find((routine) => routine.id === loadedSequenceRoutineId) ?? null
    : null;
  const syncReviewTraces = useCallback(() => {
    if (!editor) {
      return;
    }

    const traceCandidates = boundedPendingTraceCandidates(pendingSuggestions, activeSuggestionId);
    primeSuggestionRangeCache(editor, traceCandidates);
    const pendingTraces = traceCandidates.flatMap((suggestion): ReviewTrace[] => {
      const range = findSuggestionRange(editor, suggestion);
      return range ? [{
        id: suggestion.id,
        replacementText: suggestion.replacement,
        status: "pending",
        title: suggestion.title,
        ...range
      }] : [];
    });
    const docEnd = editor.state.doc.content.size;
    acceptedReviewTracesRef.current = acceptedReviewTracesRef.current.filter((trace) => trace.from < trace.to && trace.to <= docEnd);
    userReviewTracesRef.current = userReviewTracesRef.current.filter((trace) => trace.from <= trace.to && trace.to <= docEnd);
    setReviewTraces(editor, [...pendingTraces, ...acceptedReviewTracesRef.current, ...userReviewTracesRef.current]);
    const pendingCenterId = pendingSuggestionEditorCenterRef.current;
    if (pendingCenterId) {
      const pendingCenterSuggestion = pendingSuggestions.find((suggestion) => suggestion.id === pendingCenterId);
      if (!pendingCenterSuggestion) {
        pendingSuggestionEditorCenterRef.current = null;
        return;
      }
      const pendingCenterRange = pendingTraces.find((trace) => trace.id === pendingCenterId) ?? findSuggestionRange(editor, pendingCenterSuggestion);
      if (centerSuggestionTarget(editor, pendingCenterSuggestion, pendingCenterRange)) {
        pendingSuggestionEditorCenterRef.current = null;
      }
    }
  }, [activeSuggestionId, editor, pendingSuggestions]);

  useLayoutEffect(() => {
    syncReviewTraces();
  }, [syncReviewTraces]);

  // Restore this document's persisted user tracked changes once its content has
  // loaded (so positions line up). Runs once per document; on a plain refresh
  // the content is identical, so the saved offsets are still valid.
  useEffect(() => {
    if (!editor) {
      return;
    }
    const key = docId ?? "local";
    if (restoredTrackedForDocRef.current === key) {
      return;
    }
    if (!editor.state.doc.textContent.trim()) {
      return; // wait for content
    }
    restoredTrackedForDocRef.current = key;
    let saved: EditorTrackedChange[] = [];
    try {
      const raw = window.localStorage.getItem(`nebula-writer-tracked:${key}`);
      saved = raw ? (JSON.parse(raw) as EditorTrackedChange[]) : [];
    } catch {
      return;
    }
    const docEnd = editor.state.doc.content.size;
    const valid = saved.filter((change) => change && change.source === "user"
      && typeof change.from === "number" && typeof change.to === "number"
      && change.from >= 0 && change.to <= docEnd && change.from <= change.to);
    if (!valid.length) {
      return;
    }
    setEditorTrackedChanges((current) => {
      const ids = new Set(current.map((change) => change.id));
      return [...valid.filter((change) => !ids.has(change.id)), ...current].slice(0, 80);
    });
    const restoredTraces: ReviewTrace[] = valid.map((change) => ({
      id: change.id,
      status: change.kind === "delete" ? "user-delete" : "user-insert",
      deletedText: change.original,
      from: change.from,
      to: change.to,
      title: editorTrackedChangeTraceTitle(change.kind, change.original, change.replacement)
    }));
    const restoredIds = new Set(restoredTraces.map((trace) => trace.id));
    userReviewTracesRef.current = [...restoredTraces, ...userReviewTracesRef.current.filter((trace) => !restoredIds.has(trace.id))].slice(0, 80);
    syncReviewTraces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, docId, collabMetaVersion]);

  // Persist user tracked changes — but only after the restore pass for this
  // document has run, so the empty initial state can't wipe saved data first.
  useEffect(() => {
    const key = docId ?? "local";
    if (restoredTrackedForDocRef.current !== key) {
      return;
    }
    const userChanges = editorTrackedChanges.filter((change) => change.source === "user");
    try {
      if (userChanges.length) {
        window.localStorage.setItem(`nebula-writer-tracked:${key}`, JSON.stringify(userChanges));
      } else {
        window.localStorage.removeItem(`nebula-writer-tracked:${key}`);
      }
    } catch {
      // Storage unavailable; tracked changes just won't survive a refresh.
    }
  }, [docId, editorTrackedChanges]);

  useEffect(() => {
    if (busy !== "Asking AI") {
      setAiProgressNote(null);
      return;
    }
    let cancelled = false;
    // Stage changes arrive live over the /events socket (see connectEvents);
    // a 1s tick keeps the elapsed time honest between them, matching the Word
    // pane's running turn. Polling remains the fallback when the push channel
    // is down.
    const render = () => {
      const progress = liveAiProgressRef.current;
      if (!progress) {
        setAiProgressNote(null);
        return;
      }
      const pass = progress.passIndex !== null && progress.passTotal !== null && progress.passTotal > 1
        ? ` (pass ${progress.passIndex} of ${progress.passTotal})`
        : "";
      setAiProgressNote(`${progress.stage}${pass} (${formatElapsedSince(progress.startedAt)} elapsed)`);
    };
    const poll = async () => {
      try {
        const result = localAiActiveRef.current ? await getLocalAiProgress() : await getAiProgress();
        if (cancelled) {
          return;
        }
        const progress = result.progress;
        liveAiProgressRef.current = progress
          ? { stage: progress.stage, passIndex: progress.passIndex, passTotal: progress.passTotal, startedAt: progress.startedAt }
          : null;
        render();
      } catch {
        // Sidecar unreachable mid-request; keep the plain busy label.
      }
    };
    void poll();
    const tick = window.setInterval(render, 1000);
    // 5s, not 2s: on a metered cloud host the local user's own AI progress
    // polls the Worker during minutes-long passes; a slightly coarser note is
    // a fine trade. (Local-runner progress hits localhost and is free either way.)
    const interval = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      void poll();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
      window.clearInterval(interval);
      liveAiProgressRef.current = null;
      setAiProgressNote(null);
    };
  }, [busy]);

  useEffect(() => {
    if (!exportMenuOpen) {
      return;
    }
    exportMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [exportMenuOpen]);

  useEffect(() => {
    if (!autosaveMenuOpen || autosaveSessionsLoading) {
      return;
    }
    autosaveMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [autosaveMenuOpen, autosaveSessionsLoading]);

  // Inline source-revision highlighting: feed the marks + on/off flag to the
  // editor decoration plugin. Re-runs when the toggle, the revisions, or the
  // text changes (so anchors re-match after edits).
  useEffect(() => {
    if (!editor) {
      return;
    }
    const marks: SourceRevisionMark[] = highlightSourceRevisionsInline
      ? sourceTrackedChanges.map((change) => ({ kind: change.kind, text: change.text, contextBefore: change.contextBefore }))
      : [];
    setSourceRevisionHighlight(editor, highlightSourceRevisionsInline, marks);
  }, [editor, highlightSourceRevisionsInline, sourceTrackedChanges, lastEditorTextSnapshotRef.current]);

  // A collaborator importing/opening a DOCX delivers the *content* to this tab
  // via Yjs, but title, session id, suggestions, and chat are session metadata.
  // Once the collab doc is stamped with the shared session's id, adopt that
  // metadata here so both tabs are fully in sync (not just the text).

  // Surface websocket health: when the room connection drops, edits keep
  // applying locally (CRDT) and sync on reconnect — say so instead of
  // silently diverging.
  useEffect(() => {
    const provider = collabSession.provider;
    if (!provider) {
      setCollabConnection(null);
      return;
    }
    setCollabConnection(provider.wsconnected ? "connected" : "connecting");
    const onStatus = (event: { status: string }) => {
      setCollabConnection(event.status === "connected" ? "connected" : event.status === "connecting" ? "connecting" : "disconnected");
    };
    provider.on("status", onStatus);
    return () => provider.off("status", onStatus);
  }, [collabSession]);

  const adoptedSharedDocRef = useRef<string | null>(null);
  const rehydratedDocRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sharedSession || busy !== null) {
      return;
    }
    const target = sharedSession.sourceDocumentId;
    if (!target || target === sourceDocumentId || adoptedSharedDocRef.current === target) {
      return;
    }
    if (collabSession.doc.getMap("nebula-meta").get("sessionId") !== target) {
      return;
    }
    adoptedSharedDocRef.current = target;
    applySessionMetadata(sharedSession, {
      documentNote: `Following shared document: ${sharedSession.name}`,
      systemMessage: `Now following the shared document ${sharedSession.name}.`
    });
    if (editor) {
      lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, collabMetaVersion, sharedSession, sourceDocumentId]);

  // Confirm a successful join for collaborators arriving via a share link —
  // otherwise they land on a seemingly ordinary page with no acknowledgement.
  const shareJoinAnnouncedRef = useRef(false);
  useEffect(() => {
    if (shareJoinAnnouncedRef.current || !sharedSession || !getStoredShareToken()) {
      return;
    }
    shareJoinAnnouncedRef.current = true;
    setDocumentNote(`Joined shared session: ${sharedSession.name}`);
    appendMessage("system", `You joined the shared session "${sharedSession.name}" as ${collabSession.user.name}. You can change your cursor name from the Share menu (people icon).`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedSession]);

  const pendingSuggestionCount = pendingSuggestions.length;
  const trackedEditorChangeCount = editorTrackedChanges.length;
  const suggestionMarkCount = suggestionMarkExportSuggestions.length;
  useEffect(() => {
    if (!pendingSuggestionCount && !trackedEditorChangeCount && !suggestionSyncFailureCount && !suggestionMarkCount) {
      return;
    }
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [pendingSuggestionCount, trackedEditorChangeCount, suggestionSyncFailureCount, suggestionMarkCount]);

  const sharedSessionIsDifferentDocument = Boolean(sharedSession && sharedSession.sourceDocumentId !== sourceDocumentId);
  const sharedSuggestionChanges = useMemo(() => {
    if (!sharedSession || sharedSession.sourceDocumentId !== sourceDocumentId) {
      return 0;
    }
    const currentSuggestions = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion.status]));
    return sharedSession.suggestions.filter((suggestion) => currentSuggestions.get(suggestion.id) !== suggestion.status).length;
  }, [sharedSession, sourceDocumentId, suggestions]);
  const shouldAutoSyncSharedSuggestionAdds = useMemo(() => {
    if (!sharedSession || sharedSession.sourceDocumentId !== sourceDocumentId) {
      return false;
    }
    return sharedSuggestionsAreAdditionsOnly(sharedSession.suggestions, suggestions);
  }, [sharedSession, sourceDocumentId, suggestions]);
  useEffect(() => {
    if (!sharedSession || busy !== null || !shouldAutoSyncSharedSuggestionAdds) {
      return;
    }
    setSuggestions(adoptSharedSuggestions(sharedSession.suggestions));
    setDocumentNote(`Synced ${sharedSession.pendingSuggestions} agent suggestion${sharedSession.pendingSuggestions === 1 ? "" : "s"}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, sharedSession, shouldAutoSyncSharedSuggestionAdds]);
  const recentSharedRoutineRuns = useMemo(() => {
    if (!sharedSession || sharedSession.sourceDocumentId !== sourceDocumentId) {
      return [];
    }
    return sharedSession.routineRuns ?? [];
  }, [sharedSession, sourceDocumentId]);
  const sharedRunSuggestionDispositions = useMemo(
    () => sharedRunSuggestionDispositionMap(recentSharedRoutineRuns),
    [recentSharedRoutineRuns]
  );
  const representedPendingSuggestions = useMemo(
    () => pendingSuggestions.filter((suggestion) => {
      const disposition = sharedRunDispositionForSuggestion(sharedRunSuggestionDispositions, suggestion);
      return disposition ? sharedRunDispositionHasReviewCoverage(disposition) : false;
    }),
    [pendingSuggestions, sharedRunSuggestionDispositions]
  );
  const latestRoutineRun = recentSharedRoutineRuns[0] ?? null;
  const latestRunSuggestions = useMemo(
    () => routineRunSuggestions(latestRoutineRun, suggestions),
    [latestRoutineRun, suggestions]
  );
  const latestRunPendingSuggestions = useMemo(
    () => latestRunSuggestions.filter((suggestion) => suggestion.status === "pending"),
    [latestRunSuggestions]
  );
  const showLatestRunFilter = latestRunSuggestions.length > 0 || reviewFilter === "latest";
  const latestExportDispositionReport: ExportDispositionReport | null = lastExportReport ?? latestRoutineRun?.report ?? null;
  const wordCommentPendingSuggestions = useMemo(
    () => latestExportDispositionReport
      ? pendingSuggestions.filter((suggestion) => reportListIncludes(
        latestExportDispositionReport.commentedSuggestionIds ?? [],
        latestExportDispositionReport.commentedSuggestionTitles ?? [],
        suggestion
      ))
      : [],
    [latestExportDispositionReport, pendingSuggestions]
  );
  const showWordCommentFilter = wordCommentPendingSuggestions.length > 0 || reviewFilter === "word-comments";
  const wordCommentFilterTitle = useMemo(() => {
    const countLabel = labelCount(wordCommentPendingSuggestions.length, "Word-comment edit") ?? "Word-comment edits";
    const reasonSummary = latestExportDispositionReport
      ? formatCommentFallbackReasonSentence(
        latestExportDispositionReport.commentedSuggestionReasons,
        "commentedSuggestionReasonCounts" in latestExportDispositionReport
          ? latestExportDispositionReport.commentedSuggestionReasonCounts
          : undefined
      ).trim()
      : "";
    return reasonSummary
      ? `Show ${countLabel} preserved as Word comments in the latest review export. ${reasonSummary}`
      : `Show ${countLabel} preserved as Word comments in the latest review export`;
  }, [latestExportDispositionReport, wordCommentPendingSuggestions.length]);
  const wordCommentReviewStatus = useMemo(
    () => wordCommentReviewStatusForReport(latestExportDispositionReport, wordCommentPendingSuggestions),
    [latestExportDispositionReport, wordCommentPendingSuggestions]
  );
  const factCheckPendingSuggestions = useMemo(
    () => pendingSuggestions.filter((suggestion) => isPiFactCheckSuggestion(suggestion)),
    [pendingSuggestions]
  );
  const showFactCheckFilter = factCheckPendingSuggestions.length > 0 || reviewFilter === "fact-checks";
  const wordCommentOverlapSuggestions = useMemo(
    () => wordCommentOverlappingSuggestions(wordCommentPendingSuggestions),
    [wordCommentPendingSuggestions]
  );
  const wordCommentOverlapLeadSuggestions = useMemo(
    () => wordCommentOverlapRepresentativeSuggestions(wordCommentPendingSuggestions),
    [wordCommentPendingSuggestions]
  );
  const wordCommentOverlapGroupCount = useMemo(
    () => wordCommentOverlapGroupCountForSuggestions(wordCommentPendingSuggestions),
    [wordCommentPendingSuggestions]
  );
  const showDuplicateTargetFilter = wordCommentOverlapGroupCount > 0 || reviewFilter === "duplicates";
  const wordCommentOverlapGroupSizeBySuggestionId = useMemo(
    () => wordCommentOverlapGroupSizeBySuggestionIdForSuggestions(wordCommentPendingSuggestions),
    [wordCommentPendingSuggestions]
  );
  const wordCommentOverlapGroupBySuggestionId = useMemo(
    () => wordCommentOverlapGroupBySuggestionIdForSuggestions(wordCommentPendingSuggestions),
    [wordCommentPendingSuggestions]
  );
  const wordCommentOverlapGroupTitleSummaryBySuggestionId = useMemo(
    () => wordCommentOverlapGroupTitleSummaryBySuggestionIdForSuggestions(wordCommentPendingSuggestions),
    [wordCommentPendingSuggestions]
  );
  const activeWordCommentSuggestions = wordCommentOverlapOnly ? wordCommentOverlapLeadSuggestions : wordCommentPendingSuggestions;
  const pendingSuggestionAnchorCounts = useMemo(
    () => pendingSuggestionAnchorCountMap(pendingSuggestions),
    [pendingSuggestions]
  );
  const pendingConflictAnchorGroupCount = useMemo(
    () => conflictAnchorGroupCount(pendingSuggestionAnchorCounts),
    [pendingSuggestionAnchorCounts]
  );
  const pendingSuggestionAnchorPositions = useMemo(
    () => pendingSuggestionAnchorPositionMap(pendingSuggestions),
    [pendingSuggestions]
  );
  const conflictPendingSuggestions = useMemo(
    () => pendingSuggestionsSortedByAnchorConflict(pendingSuggestions, pendingSuggestionAnchorCounts),
    [pendingSuggestionAnchorCounts, pendingSuggestions]
  );
  const topConflictAnchor = useMemo(
    () => topConflictAnchorSummary(conflictPendingSuggestions),
    [conflictPendingSuggestions]
  );
  const showConflictFilter = conflictPendingSuggestions.length > 0 || reviewFilter === "conflicts";
  const recentSharedRunSuggestionIds = useMemo(
    () => sharedRunSuggestionIdSet(recentSharedRoutineRuns),
    [recentSharedRoutineRuns]
  );
  const sharedAnchorDismissibleAlternatives = useMemo(
    () => pendingSharedAnchorAlternativesWithExportedWinner(pendingSuggestions, recentSharedRunSuggestionIds),
    [pendingSuggestions, recentSharedRunSuggestionIds]
  );
  const sharedAnchorAlternativeActionLabel = labelCount(sharedAnchorDismissibleAlternatives.length, "non-winner alternative");
  const normalizedCurrentDocumentTextForFilter = editor ? normalizeText(editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n\n")) : "";
  const manualMissingTargetSuggestionIdSet = useMemo(
    () => new Set(manualMissingTargetSuggestionIds),
    [manualMissingTargetSuggestionIds]
  );
  const sourceMovedPendingSuggestions = useMemo(
    () => pendingSuggestions.filter((suggestion) => {
      if (manualMissingTargetSuggestionIdSet.has(suggestion.id)) {
        return true;
      }
      const disposition = sharedRunDispositionForSuggestion(sharedRunSuggestionDispositions, suggestion);
      if (disposition && sharedRunDispositionHasReviewCoverage(disposition)) {
        return false;
      }
      return suggestionAnchorVisibilityWarning(suggestion, normalizedCurrentDocumentTextForFilter);
    }),
    [manualMissingTargetSuggestionIdSet, normalizedCurrentDocumentTextForFilter, pendingSuggestions, sharedRunSuggestionDispositions]
  );
  const showSourceMovedFilter = sourceMovedPendingSuggestions.length > 0 || reviewFilter === "source-moved";
  const sourceMovedActionLabel = labelCount(sourceMovedPendingSuggestions.length, "missing target edit");
  const showSourceRevisionFilter = sourceTrackedChanges.length > 0 || reviewFilter === "source-revisions";
  const cleanPacketPendingSuggestions = useMemo(
    () => pendingSuggestionsForCleanPacket(pendingSuggestions, pendingSuggestionAnchorCounts, normalizedCurrentDocumentTextForFilter),
    [normalizedCurrentDocumentTextForFilter, pendingSuggestionAnchorCounts, pendingSuggestions]
  );
  const showCleanPacketFilter = cleanPacketPendingSuggestions.length > 0 || reviewFilter === "clean";
  const priorityPendingSuggestions = useMemo(
    () => uniqueSuggestionsById([
      ...latestRunPendingSuggestions,
      ...wordCommentPendingSuggestions,
      ...sourceMovedPendingSuggestions,
      ...conflictPendingSuggestions
    ]),
    [conflictPendingSuggestions, latestRunPendingSuggestions, sourceMovedPendingSuggestions, wordCommentPendingSuggestions]
  );
  const showPriorityFilter = priorityPendingSuggestions.length > 0 || reviewFilter === "priority";
  const reviewBacklogStatus = useMemo(
    () => reviewBacklogPressureStatus({
      conflictCount: conflictPendingSuggestions.length,
      conflictGroupCount: pendingConflictAnchorGroupCount,
      dismissibleConflictCount: sharedAnchorDismissibleAlternatives.length,
      latestPendingCount: latestRunPendingSuggestions.length,
      pendingCount: pendingSuggestions.length,
      representedConflictCount: conflictPendingSuggestions.filter((suggestion) => {
        const disposition = sharedRunDispositionForSuggestion(sharedRunSuggestionDispositions, suggestion);
        return disposition ? sharedRunDispositionHasReviewCoverage(disposition) : false;
      }).length,
      representedPendingCount: representedPendingSuggestions.length,
      sourceMovedCount: sourceMovedPendingSuggestions.length,
      wordCommentCount: wordCommentPendingSuggestions.length
    }),
    [
      conflictPendingSuggestions.length,
      latestRunPendingSuggestions.length,
      pendingConflictAnchorGroupCount,
      pendingSuggestions.length,
      sharedAnchorDismissibleAlternatives.length,
      sharedRunSuggestionDispositions,
      representedPendingSuggestions.length,
      sourceMovedPendingSuggestions.length,
      wordCommentPendingSuggestions.length
    ]
  );
  const reviewBacklogSummarySignature = reviewBacklogStatus
    ? [
        reviewBacklogStatus.headline,
        reviewBacklogStatus.detail,
        latestRoutineRun?.id ?? ""
      ].join("\u0000")
    : "";
  const showReviewBacklogStatus = Boolean(
    reviewBacklogStatus
    && reviewBacklogSummarySignature
    && dismissedBacklogSummarySignature !== reviewBacklogSummarySignature
  );
  useEffect(() => {
    if (reviewFilter === "latest" && !showLatestRunFilter) {
      setReviewFilter("pending");
    }
    if (reviewFilter === "conflicts" && !showConflictFilter) {
      setReviewFilter("pending");
    }
    if (reviewFilter === "source-moved" && !showSourceMovedFilter) {
      setReviewFilter("pending");
    }
    if (reviewFilter === "source-revisions" && !showSourceRevisionFilter) {
      setReviewFilter("pending");
    }
    if (reviewFilter === "clean" && !showCleanPacketFilter) {
      setReviewFilter("pending");
    }
    if (reviewFilter === "word-comments" && !showWordCommentFilter) {
      setReviewFilter("pending");
    }
    if (reviewFilter === "fact-checks" && !showFactCheckFilter) {
      setReviewFilter("pending");
    }
    if (reviewFilter === "duplicates" && !showDuplicateTargetFilter) {
      setReviewFilter("pending");
    }
    if (reviewFilter === "priority" && !showPriorityFilter) {
      setReviewFilter("pending");
    }
  }, [reviewFilter, showCleanPacketFilter, showConflictFilter, showDuplicateTargetFilter, showFactCheckFilter, showLatestRunFilter, showPriorityFilter, showSourceMovedFilter, showSourceRevisionFilter, showWordCommentFilter]);
  useEffect(() => {
    if (reviewFilter !== "word-comments" && wordCommentOverlapOnly) {
      setWordCommentOverlapOnly(false);
    }
  }, [reviewFilter, wordCommentOverlapOnly]);
  useEffect(() => {
    if (!sourceTrackedChanges.length) {
      if (showSourceRevisionsInDocument) {
        setShowSourceRevisionsInDocument(false);
      }
      if (activeSourceRevisionIndex !== 0) {
        setActiveSourceRevisionIndex(0);
      }
      return;
    }
    if (activeSourceRevisionIndex >= sourceTrackedChanges.length) {
      setActiveSourceRevisionIndex(sourceTrackedChanges.length - 1);
    }
  }, [activeSourceRevisionIndex, showSourceRevisionsInDocument, sourceTrackedChanges.length]);
  useEffect(() => {
    if (!wordCommentOverlapSuggestions.length && wordCommentOverlapOnly) {
      setWordCommentOverlapOnly(false);
    }
  }, [wordCommentOverlapOnly, wordCommentOverlapSuggestions.length]);
  const reviewSearchTerms = useMemo(
    () => reviewSearchTermsForQuery(reviewSearchQuery),
    [reviewSearchQuery]
  );
  const reviewSearchActive = reviewSearchTerms.length > 0;
  const sourceRevisionSearchTerms = useMemo(
    () => reviewSearchTermsForQuery(sourceRevisionSearchQuery),
    [sourceRevisionSearchQuery]
  );
  const sourceRevisionSearchActive = sourceRevisionSearchTerms.length > 0;
  const unfilteredVisibleSuggestions = reviewFilter === "latest"
    ? latestRunPendingSuggestions
    : reviewFilter === "priority"
      ? priorityPendingSuggestions
    : reviewFilter === "clean"
      ? cleanPacketPendingSuggestions
    : reviewFilter === "conflicts"
      ? conflictPendingSuggestions
    : reviewFilter === "source-moved"
      ? sourceMovedPendingSuggestions
    : reviewFilter === "source-revisions"
      ? []
    : reviewFilter === "duplicates"
      ? wordCommentOverlapLeadSuggestions
    : reviewFilter === "word-comments"
      ? activeWordCommentSuggestions
    : reviewFilter === "fact-checks"
      ? factCheckPendingSuggestions
    : reviewFilter === "pending"
      ? pendingSuggestions
      : suggestions;
  const unfilteredReviewNavigationSuggestions = reviewFilter === "latest"
    ? latestRunPendingSuggestions
    : reviewFilter === "priority"
      ? priorityPendingSuggestions
    : reviewFilter === "clean"
      ? cleanPacketPendingSuggestions
    : reviewFilter === "conflicts"
      ? conflictPendingSuggestions
    : reviewFilter === "source-moved"
      ? sourceMovedPendingSuggestions
    : reviewFilter === "source-revisions"
      ? []
    : reviewFilter === "duplicates"
      ? wordCommentOverlapLeadSuggestions
    : reviewFilter === "word-comments"
      ? activeWordCommentSuggestions
    : reviewFilter === "fact-checks"
      ? factCheckPendingSuggestions
      : pendingSuggestions;
  const reviewActivity = useMemo(() => {
    return suggestions
      .filter((suggestion) => suggestion.status !== "pending" && suggestion.decidedAt)
      .sort((left, right) => Date.parse(right.decidedAt ?? "") - Date.parse(left.decidedAt ?? ""))
      .slice(0, 12)
      .map((suggestion) => ({
        id: suggestion.id,
        suggestion,
        text: `${suggestion.decidedBy ?? "Someone"} ${suggestion.status} "${suggestion.title}"`,
        time: suggestion.decidedAt ? formatDecisionTime(suggestion.decidedAt) : ""
      }));
  }, [suggestions]);
  const reviewPeople = useMemo(() => {
    const people = new Set<string>();
    suggestions.forEach((suggestion) => {
      if (suggestion.proposedBy) {
        people.add(suggestion.proposedBy);
      }
      if (suggestion.decidedBy) {
        people.add(suggestion.decidedBy);
      }
    });
    return [...people].sort();
  }, [suggestions]);
  const visibleSuggestions = useMemo(
    () => filterSuggestionsByReviewSearch(unfilteredVisibleSuggestions, reviewSearchTerms)
      .filter((suggestion) => !reviewPersonFilter
        || suggestion.proposedBy === reviewPersonFilter
        || suggestion.decidedBy === reviewPersonFilter),
    [reviewPersonFilter, reviewSearchTerms, unfilteredVisibleSuggestions]
  );
  const reviewNavigationSuggestions = useMemo(
    () => filterSuggestionsByReviewSearch(unfilteredReviewNavigationSuggestions, reviewSearchTerms),
    [reviewSearchTerms, unfilteredReviewNavigationSuggestions]
  );
  const sourceMovedPendingSuggestionIdSet = useMemo(
    () => new Set(sourceMovedPendingSuggestions.map((suggestion) => suggestion.id)),
    [sourceMovedPendingSuggestions]
  );
  const documentReviewNavigationSuggestions = useMemo(
    () => reviewFilter === "source-moved"
      ? reviewNavigationSuggestions
      : reviewNavigationSuggestions.filter((suggestion) => !sourceMovedPendingSuggestionIdSet.has(suggestion.id)),
    [reviewFilter, reviewNavigationSuggestions, sourceMovedPendingSuggestionIdSet]
  );
  const documentReviewSkippedMissingTargetCount = reviewNavigationSuggestions.length - documentReviewNavigationSuggestions.length;
  const reviewSearchBaseCount = unfilteredVisibleSuggestions.length;
  const reviewSearchMatchLabel = reviewSearchActive
    ? `${visibleSuggestions.length} ${visibleSuggestions.length === 1 ? "match" : "matches"}`
    : `${labelCount(reviewSearchBaseCount, "change") ?? "0 changes"}`;
  const sourceRevisionNavigationEntries = useMemo(
    () => sourceTrackedChanges
      .map((change, index) => ({ change, index }))
      .filter(({ change }) => sourceRevisionMatchesSearch(change, sourceRevisionSearchTerms)),
    [sourceRevisionSearchTerms, sourceTrackedChanges]
  );
  const activeSourceRevisionEntryIndex = useMemo(
    () => sourceRevisionNavigationEntries.findIndex((entry) => entry.index === activeSourceRevisionIndex),
    [activeSourceRevisionIndex, sourceRevisionNavigationEntries]
  );
  const sourceRevisionNavigationIndex = sourceRevisionNavigationEntries.length
    ? activeSourceRevisionEntryIndex >= 0
      ? activeSourceRevisionEntryIndex + 1
      : 1
    : 0;
  const sourceRevisionSearchMatchLabel = sourceRevisionSearchActive
    ? `${sourceRevisionNavigationEntries.length} ${sourceRevisionNavigationEntries.length === 1 ? "match" : "matches"}`
    : `${labelCount(sourceTrackedChanges.length, "revision") ?? "0 revisions"}`;
  const visibleSuggestionCopySignature = useMemo(
    () => `${reviewFilter}:${visibleSuggestions.map((suggestion) => suggestion.id).join(",")}`,
    [reviewFilter, visibleSuggestions]
  );
  useEffect(() => {
    setVisibleSuggestionCopyText("");
    setOverlapGroupCopyText(null);
  }, [visibleSuggestionCopySignature]);
  useEffect(() => {
    if (!visibleSuggestionCopyText) {
      return;
    }
    window.setTimeout(() => {
      visibleCopyTextAreaRef.current?.focus();
      visibleCopyTextAreaRef.current?.select();
    }, 0);
  }, [visibleSuggestionCopyText]);
  useEffect(() => {
    if (!overlapGroupCopyText) {
      return;
    }
    window.setTimeout(() => {
      overlapGroupCopyTextAreaRef.current?.focus();
      overlapGroupCopyTextAreaRef.current?.select();
    }, 0);
  }, [overlapGroupCopyText]);
  useEffect(() => {
    if (!routineSummaryCopyText) {
      return;
    }
    window.setTimeout(() => {
      routineSummaryCopyTextAreaRef.current?.focus();
      routineSummaryCopyTextAreaRef.current?.select();
    }, 0);
  }, [routineSummaryCopyText]);
  useEffect(() => {
    if (!routineEditsCopyText) {
      return;
    }
    window.setTimeout(() => {
      routineEditsCopyTextAreaRef.current?.focus();
      routineEditsCopyTextAreaRef.current?.select();
    }, 0);
  }, [routineEditsCopyText]);
  useEffect(() => {
    if (!routineWordCommentsCopyText) {
      return;
    }
    window.setTimeout(() => {
      routineWordCommentsCopyTextAreaRef.current?.focus();
      routineWordCommentsCopyTextAreaRef.current?.select();
    }, 0);
  }, [routineWordCommentsCopyText]);
  const activePendingIndex = useMemo(
    () => reviewNavigationSuggestions.findIndex((suggestion) => suggestion.id === activeSuggestionId),
    [activeSuggestionId, reviewNavigationSuggestions]
  );
  const reviewNavigationIndex = activePendingIndex >= 0 ? activePendingIndex + 1 : reviewNavigationSuggestions.length ? 1 : 0;
  const activeDocumentReviewIndex = useMemo(
    () => documentReviewNavigationSuggestions.findIndex((suggestion) => suggestion.id === activeSuggestionId),
    [activeSuggestionId, documentReviewNavigationSuggestions]
  );
  const documentReviewNavigationIndex = activeDocumentReviewIndex >= 0
    ? activeDocumentReviewIndex + 1
    : documentReviewNavigationSuggestions.length
      ? 1
      : 0;
  const activeSourceRevision = sourceTrackedChanges[activeSourceRevisionIndex] ?? null;
  const bodySafeAnchorCounts = useMemo(
    () => bodySafeAnchorSectionCounts(docxBodySafeAnchorDetails),
    [docxBodySafeAnchorDetails]
  );
  const thinBodySafeAimSections = useMemo(
    () => bodySafeThinAimSections(bodySafeAnchorCounts),
    [bodySafeAnchorCounts]
  );
  const milestonesBodySafeAnchors = useMemo(
    () => bodySafeAnchorsForSection(docxBodySafeAnchorDetails, "Expected Milestones and Impact"),
    [docxBodySafeAnchorDetails]
  );
  const uncoveredMilestonesBodySafeAnchors = useMemo(
    () => bodySafeUncoveredAnchors(milestonesBodySafeAnchors, pendingSuggestions),
    [milestonesBodySafeAnchors, pendingSuggestions]
  );
  const languagePolishBodySafeAnchors = useMemo(
    () => bodySafeLanguagePolishAnchors(docxBodySafeAnchorDetails),
    [docxBodySafeAnchorDetails]
  );
  const uncoveredLanguagePolishBodySafeAnchors = useMemo(
    () => bodySafeUncoveredAnchors(languagePolishBodySafeAnchors, pendingSuggestions),
    [languagePolishBodySafeAnchors, pendingSuggestions]
  );
  const plainText = useCallback(() => {
    if (!editor) {
      return "";
    }
    return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n\n");
  }, [editor]);
  const currentDocumentText = editor ? plainText() : "";
  const normalizedCurrentDocumentText = useMemo(() => normalizeText(currentDocumentText), [currentDocumentText]);
  const verificationNotes = editor ? verificationNoteCandidates(currentDocumentText) : [];
  const userTrackedChangeCount = editorTrackedChanges.filter((change) => change.source === "user").length;
  const aiTrackedChangeCount = editorTrackedChanges.filter((change) => change.source === "ai").length;
  // Shared across collaborators (derived from suggestion state), unlike the
  // local-only editorTrackedChanges list.
  const acceptedSuggestionCount = suggestions.filter((suggestion) => suggestion.status === "accepted").length;
  const latestTrackedChanges = editorTrackedChanges.slice(0, 4);

  function updateSelectionFromEditor(activeEditor: Editor) {
    const context = getSelectionContext(activeEditor);
    // Keep the last real selection when the editor isn't focused — e.g. the
    // user selected a passage and clicked into the chat box. Only an active,
    // in-editor collapse should clear Selection mode.
    if (context || activeEditor.isFocused) {
      setSelection(context);
    }
  }

  function removeEditorTrackedChange(id: string) {
    setEditorTrackedChanges((current) => current.filter((existing) => existing.id !== id));
  }

  function recordEditorTrackedChange(change: Omit<EditorTrackedChange, "createdAt">) {
    setEditorTrackedChanges((current) => [
      {
        ...change,
        createdAt: new Date().toISOString()
      },
      ...current.filter((existing) => existing.id !== change.id)
      // Changes beyond the cap silently drop from review export, so keep it
      // far above what a long editing session produces.
    ].slice(0, maxTrackedEditorChanges));
  }

  function resetEditorTrackedChangeState() {
    setEditorTrackedChanges([]);
    acceptedReviewTracesRef.current = [];
    userReviewTracesRef.current = [];
    if (editor) {
      setReviewTraces(editor, []);
      window.setTimeout(() => {
        lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
      }, 0);
    } else {
      lastEditorTextSnapshotRef.current = null;
    }
  }

  function clearEditorTrackedChanges() {
    setEditorTrackedChanges([]);
    acceptedReviewTracesRef.current = [];
    userReviewTracesRef.current = [];
    syncReviewTraces();
    setDocumentNote("Cleared browser change markers");
  }

  function applySessionDocument(session: WriterSessionDocument, options: { documentNote: string; systemMessage: string }) {
    if (session.sourceDocumentId === docId && editor) {
      // Already in this document's room: replace content in place.
      suppressUserTrackingRef.current = true;
      editor.commands.setContent(session.documentHtml || "<p></p>");
      lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
      suppressUserTrackingRef.current = false;
      collabSession.doc.getMap("nebula-meta").set("sessionId", session.sourceDocumentId);
      applySessionMetadata(session, options);
    } else {
      // Different document: queue content + metadata for its room and switch
      // (the editor is recreated bound to that room and seeds on first sync).
      pendingRoomSeedRef.current = {
        docId: session.sourceDocumentId,
        html: session.documentHtml,
        session,
        sessionNotes: options
      };
      adoptDocId(session.sourceDocumentId);
    }
  }

  function applySessionMetadata(session: WriterSessionSummary, options: { documentNote: string; systemMessage: string }) {
    setDocumentTitle(session.title || session.name.replace(/\.docx$/i, ""));
    setSourceDocumentId(session.sourceDocumentId);
    setSourceDocxImported(Boolean(session.sourceDocument));
    setSourceFeatures(session.features);
    setSourceTrackedChanges(session.sourceTrackedChanges ?? []);
    setDocxBodySafeAnchors(session.bodySafeAnchors ?? []);
    setDocxBodySafeAnchorDetails(anchorDetailsFromImport(session.bodySafeAnchors ?? [], session.bodySafeAnchorDetails));
    setDocumentNoteDetail(documentDetailTooltip(session.features, session.importMessages ?? []));
    setSuggestions(session.suggestions);
    setManualMissingTargetSuggestionIds([]);
    resetEditorTrackedChangeState();
    setReviewFilter("pending");
    setLastExportReport(null);
    setLastExportContext(null);
    setLastExportFilename(null);
    setSequenceReviewHandoff(null);
    setSequenceExportSummary(null);
    setLoadedRoutineIntent(null);
    setCompletedSequenceRoutineIds(restoreSequenceProgress(session.sourceDocumentId, session.routineProgress ?? []));
    setEmptyAiResult(null);
    clearLocatedSuggestion();
    setDocumentNote(options.documentNote);
    const restoredMessages = chatMessagesFromSession(session.chatMessages, options.systemMessage);
    // Messages restored from the session are already on the sidecar.
    restoredMessages.forEach((message) => syncedChatMessageIdsRef.current.add(message.id));
    setMessages(restoredMessages);
    setSharedSession(session);
  }

  function confirmDiscardPendingWork(action: string): boolean {
    const pendingCount = suggestions.filter((suggestion) => suggestion.status === "pending").length;
    const trackedCount = editorTrackedChanges.length;
    if (!pendingCount && !trackedCount) {
      return true;
    }
    if (typeof window === "undefined" || typeof window.confirm !== "function") {
      return true;
    }
    const parts = [
      pendingCount ? `${pendingCount} pending suggestion${pendingCount === 1 ? "" : "s"}` : null,
      trackedCount ? `${trackedCount} tracked editor change${trackedCount === 1 ? "" : "s"}` : null
    ].filter(Boolean);
    const result = window.confirm(`You have ${parts.join(" and ")} that will be discarded if you ${action}. Continue?`);
    // Treat only an explicit Cancel as a stop; jsdom's unimplemented confirm returns undefined.
    return result !== false;
  }

  async function handleImport(file: File) {
    if (!confirmDiscardPendingWork(`import ${file.name}`)) {
      setDocumentNote("Import canceled");
      return;
    }
    setError(null);
    setBusy("Importing DOCX");
    try {
      let imported: ImportedDocument;
      if (cloudMode) {
        // The edge has no DOCX pipeline: convert on the user's own Writer
        // (full-fidelity import), then create the cloud document from it.
        if (!localAi) {
          setError("Importing a DOCX here uses your local Writer for conversion. Start it first (see the setup guide), then drop the file again.");
          setSetupGuideOpen(true);
          return;
        }
        const converted = await importDocxLocally(file);
        const created = await createWriterSession({
          title: converted.name.replace(/\.docx$/i, ""),
          name: converted.name,
          html: converted.html,
          text: converted.plainText,
          features: converted.features,
          importMessages: converted.messages,
          bodySafeAnchors: converted.bodySafeAnchors,
          bodySafeAnchorDetails: converted.bodySafeAnchorDetails,
          sourceTrackedChanges: converted.sourceTrackedChanges
        });
        if (!created.session) {
          throw new Error("the cloud Writer did not create a document for the import");
        }
        imported = { ...converted, id: created.session.sourceDocumentId };
      } else {
        imported = await importDocx(file);
      }
      if (imported.id === docId && editor) {
        suppressUserTrackingRef.current = true;
        editor.commands.setContent(imported.html || "<p></p>");
        // Phase 3: Word revisions arrive as actionable inline suggestions.
        const { materialized, remaining } = materializeSourceTrackedChanges(editor, imported.sourceTrackedChanges ?? []);
        lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
        suppressUserTrackingRef.current = false;
        collabSession.doc.getMap("nebula-meta").set("sessionId", imported.id);
        if (materialized > 0) {
          setSourceTrackedChanges(remaining);
          appendMessage("system", `${materialized} tracked change${materialized === 1 ? "" : "s"} from the source DOCX arrived as inline suggestions — accept or reject them in the document.`);
        }
      } else {
        // The imported document gets its own room; the editor recreates bound
        // to it and seeds this content on first sync. The URL now carries the
        // document id, so sharing the URL shares this document.
        pendingRoomSeedRef.current = { docId: imported.id, html: imported.html, sourceTrackedChanges: imported.sourceTrackedChanges };
        adoptDocId(imported.id);
      }
      setDocumentTitle(imported.name.replace(/\.docx$/i, ""));
      setSourceDocumentId(imported.id);
      // A real DOCX import creates a source package server-side.
      setSourceDocxImported(true);
      setSourceFeatures(imported.features);
      setSourceTrackedChanges(imported.sourceTrackedChanges ?? []);
      setDocxBodySafeAnchors(imported.bodySafeAnchors ?? []);
      setDocxBodySafeAnchorDetails(anchorDetailsFromImport(imported.bodySafeAnchors ?? [], imported.bodySafeAnchorDetails));
      setSuggestions([]);
      setManualMissingTargetSuggestionIds([]);
      resetEditorTrackedChangeState();
      setReviewFilter("pending");
      setLastExportReport(null);
      setLastExportContext(null);
      setSequenceReviewHandoff(null);
      setSequenceExportSummary(null);
      setLoadedRoutineIntent(null);
      setCompletedSequenceRoutineIds(loadSequenceProgress(imported.id));
      setEmptyAiResult(null);
      clearLocatedSuggestion();
      setDocumentNote(`Imported ${imported.name}`);
      // Conversion details (Word fidelity warnings) ride along as a tooltip on
      // this transient note — reachable right when they matter, no permanent chrome.
      setDocumentNoteDetail(documentDetailTooltip(imported.features, imported.messages));
      setImportFidelityNotices(fidelityNoticesFromImportMessages(imported.messages));
      setMessages([createSystemMessage()]);
      // A new document starts a fresh conversation, so its sticky attachments
      // are no longer in context — clear them.
      setPendingAttachments([]);
    } catch (importError) {
      suppressUserTrackingRef.current = false;
      setError(describeError(`Import failed for ${file.name}`, importError, "the DOCX could not be read or converted"));
    } finally {
      setBusy(null);
    }
  }

  async function handleExport(trackedChanges = false) {
    if (!editor) {
      return;
    }
    if (cloudMode && !localAi) {
      setError("Exporting a DOCX here uses your local Writer for conversion. Start it first (see the setup guide).");
      setSetupGuideOpen(true);
      return;
    }
    setError(null);
    setBusy(trackedChanges ? "Exporting review DOCX" : "Exporting DOCX");
    try {
      const shouldRecordSharedRoutineExport = trackedChanges && sequenceReviewHandoff && sourceDocumentId && sharedSession?.sourceDocumentId === sourceDocumentId;
      const exportContext = trackedChanges
        ? reviewExportContext(sequenceReviewHandoff, sequenceExportSummary)
        : null;
      const requestedDownloadFilename = trackedChanges ? reviewDownloadFilename(documentTitle, exportContext) : undefined;
      const exportResult: ExportDocxResult & { session?: WriterSessionSummary | null } = shouldRecordSharedRoutineExport
        ? await exportRecordedSharedRoutineReview(sequenceReviewHandoff)
        : await (cloudMode ? exportDocxLocally : exportDocx)({
          downloadFilename: requestedDownloadFilename,
          title: documentTitle,
          // Only omit HTML when a real source DOCX package backs the export;
          // an id without a package must rebuild from the editor.
          html: trackedChanges && sourceDocumentId && hasSourceDocx ? "" : editor.getHTML(),
          sourceDocumentId: trackedChanges && hasSourceDocx ? sourceDocumentId : null,
          trackedChanges,
          suggestions: trackedChanges ? reviewExportSuggestions : []
        });
      const downloadFilename = exportResult.filename || requestedDownloadFilename || `${documentTitle || "nebula-writer"}${trackedChanges ? "-tracked-changes" : ""}.docx`;
      const saved = await saveBlobWithDownloadPrompt(exportResult.blob, downloadFilename);
      if (!saved) {
        setDocumentNote("Export canceled");
        return;
      }
      setDocumentNote(trackedChanges ? trackedExportNote(exportResult.report) : "Exported DOCX");
      setLastExportReport(trackedChanges ? exportResult.report : null);
      setLastExportContext(exportContext);
      setLastExportFilename(trackedChanges ? downloadFilename : null);
      if (trackedChanges) {
        if (sequenceReviewHandoff) {
          setSequenceExportSummary({
            filename: downloadFilename,
            label: sequenceReviewHandoff.label,
            report: exportResult.report,
            routineId: sequenceReviewHandoff.routineId
          });
          const nextProgress = completedSequenceRoutineIds.includes(sequenceReviewHandoff.routineId)
            ? completedSequenceRoutineIds
            : [...completedSequenceRoutineIds, sequenceReviewHandoff.routineId];
          setCompletedSequenceRoutineIds(persistSequenceProgress(nextProgress));
          if (exportResult.session) {
            setSharedSession(exportResult.session);
            setReviewFilter("latest");
          } else {
            void setWriterRoutineRun({
              routineId: sequenceReviewHandoff.routineId,
              label: sequenceReviewHandoff.label,
              completedAt: new Date().toISOString(),
              artifactPath: null,
              instruction: sequenceReviewHandoff.instruction ?? null,
              report: writerRoutineRunReport(exportResult.report, suggestions)
            }, sharedSessionWriteContext())
              .then((result) => {
                setSharedSession(result.session);
                setReviewFilter("latest");
              })
              .catch(() => {
                setDocumentNote("Exported, but the routine run could not be recorded in the shared session (sidecar unreachable)");
              });
          }
        } else if (sequenceExportSummary) {
          setSequenceExportSummary({
            ...sequenceExportSummary,
            filename: downloadFilename,
            report: exportResult.report
          });
        }
        setSequenceReviewHandoff(null);
      }
    } catch (exportError) {
      setError(describeError(trackedChanges ? "Review DOCX export failed" : "DOCX export failed", exportError, "the document could not be written"));
    } finally {
      setBusy(null);
    }
  }

  async function handleDefaultExport() {
    await handleExport(defaultExportUsesReviewCarrier);
  }

  function runExportMenuAction(action: () => void) {
    setExportMenuOpen(false);
    action();
  }

  async function handleToggleShareMenu() {
    if (shareMenuOpen) {
      setShareMenuOpen(false);
      return;
    }
    setShareMenuOpen(true);
    setShareUrlCopied(false);
    setCollabNameDraft(collabSession.user.name);
    try {
      setShareInfo(await getShareInfo());
    } catch {
      setShareInfo(null);
    }
  }

  function handleApplyCollabName() {
    setCollabUserName(collabSession, collabNameDraft);
    setCollabNameDraft(collabSession.user.name);
    setDocumentNote(`Collaboration name set to ${collabSession.user.name}`);
  }

  function handleCopyShareUrl(url: string) {
    void copyTextToClipboard(url).then((copied) => {
      setShareUrlCopied(copied);
    });
  }

  async function handleStartSharedDocument() {
    if (!editor || busy !== null) {
      return;
    }
    setBusy("Starting shared document");
    setError(null);
    try {
      const result = await createWriterSession({
        title: documentTitle,
        html: editor.getHTML(),
        text: plainText()
      });
      if (!result.session) {
        setError("The sidecar did not create a shared document.");
        return;
      }
      // Keep the just-written content as this room's seed; the editor
      // recreates bound to the new document room.
      pendingRoomSeedRef.current = { docId: result.session.sourceDocumentId, html: result.session.documentHtml };
      adoptDocId(result.session.sourceDocumentId);
      setSharedSession(result.session);
      setSourceDocumentId(result.session.sourceDocumentId);
      setSourceDocxImported(false);
      // Local-first: sharing means syncing through the cloud relay so
      // collaborators' own local Writers can join by id.
      if (localMode) {
        setCloudSynced(true);
        void ensureCollabBridge(result.session.sourceDocumentId).catch(() => undefined);
      }
      setDocumentNote(`Sharing started: ${result.session.title}`);
      appendMessage("system", `This draft is now a shared document. Send the link from the Share menu to collaborate on it.`);
    } catch (createError) {
      setError(describeError("Could not start sharing", createError, "the sidecar did not respond"));
    } finally {
      setBusy(null);
    }
  }

  // Local-first: the agent terminal drives the ACTIVE server session, but a
  // fresh local draft is browser-only. Quietly promote it to a session as soon
  // as it has content so the terminal can read and stage against it with no
  // manual "Share" step. Local only (the terminal is a local feature), once per
  // draft, and silent (no sharing banner). The session/room is local; syncing
  // to collaborators stays an explicit choice.
  useEffect(() => {
    if (!markPopover) {
      return;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMarkPopover(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [markPopover]);

  // Clean view is read-only: hidden deletions make caret positions lie.
  useEffect(() => {
    editor?.setEditable(!cleanView);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanView, editor]);

  const autoLocalSessionRef = useRef(false);
  useEffect(() => {
    if (!localMode || docId || !editor || busy !== null || autoLocalSessionRef.current) {
      return;
    }
    if (currentDocumentText.trim().length < 3) {
      return;
    }
    autoLocalSessionRef.current = true;
    void (async () => {
      try {
        const result = await createWriterSession({ title: documentTitle, html: editor.getHTML(), text: plainText() });
        if (result.session) {
          // The room swap recreates the editor mid-typing; the diff audit log
          // cannot follow a chain across two editor instances (it produced
          // scrambled whitespace chips). Suppress tracking through the swap —
          // the seed branch releases the flag once the new editor is seeded
          // and its snapshot baseline is set.
          suppressUserTrackingRef.current = true;
          pendingRoomSeedRef.current = { docId: result.session.sourceDocumentId, html: result.session.documentHtml };
          adoptDocId(result.session.sourceDocumentId);
          setSharedSession(result.session);
          setSourceDocumentId(result.session.sourceDocumentId);
          setSourceDocxImported(false);
        } else {
          autoLocalSessionRef.current = false;
        }
      } catch {
        autoLocalSessionRef.current = false;
      }
    })();
  }, [localMode, docId, editor, busy, currentDocumentText, documentTitle, plainText]);

  function handleMenuKeyDown(close: () => void, containerRef: { current: HTMLDivElement | null }) {
    return (event: KeyboardEvent<HTMLDivElement>) => {
      const menu = event.currentTarget;
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
      const focusItem = (index: number) => {
        if (items.length) {
          items[((index % items.length) + items.length) % items.length]?.focus();
        }
      };
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusItem(currentIndex + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          focusItem(currentIndex <= 0 ? items.length - 1 : currentIndex - 1);
          break;
        case "Home":
          event.preventDefault();
          focusItem(0);
          break;
        case "End":
          event.preventDefault();
          focusItem(items.length - 1);
          break;
        case "Escape": {
          event.preventDefault();
          close();
          const trigger = containerRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
          trigger?.focus();
          break;
        }
        case "Tab":
          close();
          break;
        default:
          break;
      }
    };
  }

  async function refreshAutosavedSessions() {
    setAutosaveSessionsLoading(true);
    try {
      const result = await getWriterAutosavedSessions();
      setAutosavedSessions(result.sessions);
    } catch {
      setAutosavedSessions([]);
    } finally {
      setAutosaveSessionsLoading(false);
    }
  }

  async function handleToggleAutosaveMenu() {
    if (autosaveMenuOpen) {
      setAutosaveMenuOpen(false);
      return;
    }
    setAutosaveMenuOpen(true);
    await refreshAutosavedSessions();
  }

  async function handleLoadAutosavedSession(id: string) {
    if (!editor || busy !== null) {
      return;
    }
    if (!confirmDiscardPendingWork("load an autosaved session")) {
      return;
    }
    setAutosaveMenuOpen(false);
    setError(null);
    setBusy("Loading autosaved session");
    try {
      const result = await loadWriterAutosavedSession(id);
      if (!result.session) {
        setError("Autosaved Writer session did not restore a document.");
        return;
      }
      applySessionDocument(result.session, {
        documentNote: `Loaded autosaved session: ${result.session.name}`,
        systemMessage: `Loaded ${result.session.name} from an autosaved Writer session. AI chat and proposed changes restored for this document.`
      });
      await refreshAutosavedSessions();
    } catch (sessionError) {
      suppressUserTrackingRef.current = false;
      setError(describeError("Could not load the autosaved session", sessionError, "the saved snapshot did not restore"));
    } finally {
      setBusy(null);
    }
  }

  async function handleExportSessionState() {
    setError(null);
    setBusy("Exporting session snapshot");
    try {
      const result = await exportWriterSessionState();
      const saved = await saveBlobWithDownloadPrompt(result.blob, result.filename);
      if (!saved) {
        setDocumentNote("Session snapshot export canceled");
        return;
      }
      setDocumentNote(`Exported session snapshot: ${result.filename}`);
      await refreshAutosavedSessions();
    } catch (exportError) {
      setError(describeError("Session snapshot export failed", exportError, "the snapshot could not be saved"));
    } finally {
      setBusy(null);
    }
  }

  async function handleExportCumulativeReview() {
    if (!canExportCumulativeReview) {
      setError("Load the shared source DOCX session with pending edits before exporting a cumulative review carrier.");
      return;
    }
    setError(null);
    setBusy("Exporting cumulative review DOCX");
    try {
      const result = await exportWriterSessionReview({
        copyToDownloads: true,
        pendingOnly: true,
        suggestions: pendingSuggestions,
        routineRun: {
          ...cumulativeReviewIntent,
          completedAt: new Date().toISOString(),
          instruction: cumulativeReviewInstruction
        }
      });
      const artifact = result.routineRun ? await downloadWriterRoutineArtifact(result.routineRun.id) : null;
      const downloadFilename = artifact?.filename
        ?? result.outputPath.split(/[\\/]/).pop()
        ?? reviewDownloadFilename(documentTitle, cumulativeReviewIntent);
      const saved = await saveBlobWithDownloadPrompt(artifact?.blob ?? new Blob(), downloadFilename);
      if (!saved) {
        setDocumentNote("Cumulative review export canceled");
        return;
      }

      setDocumentNote(trackedExportNote(result.report));
      setLastExportReport(result.report);
      setLastExportContext(cumulativeReviewIntent);
      setLastExportFilename(downloadFilename);
      setSequenceExportSummary({
        filename: downloadFilename,
        label: cumulativeReviewIntent.label,
        report: result.report,
        routineId: cumulativeReviewIntent.routineId
      });
      setSequenceReviewHandoff(null);
      if (result.session) {
        setSharedSession(result.session);
        setReviewFilter("latest");
      }
    } catch (exportError) {
      setError(describeError("Cumulative review export failed", exportError, "the review DOCX could not be generated"));
    } finally {
      setBusy(null);
    }
  }

  async function handleImportSessionState(file: File) {
    if (!editor) {
      return;
    }
    if (!confirmDiscardPendingWork("load a session snapshot")) {
      return;
    }
    setError(null);
    setBusy("Loading session snapshot");
    try {
      const result = await importWriterSessionState(file);
      if (!result.session) {
        setError("Session snapshot did not restore a Writer session.");
        return;
      }
      applySessionDocument(result.session, {
        documentNote: `Loaded session snapshot: ${result.session.name}`,
        systemMessage: `Loaded ${result.session.name} from a Nebula Writer session snapshot. AI chat reset for this document.`
      });
      await refreshAutosavedSessions();
    } catch (importError) {
      suppressUserTrackingRef.current = false;
      setError(describeError(`Session snapshot import failed for ${file.name}`, importError, "the snapshot file could not be read"));
    } finally {
      setBusy(null);
    }
  }

  async function exportRecordedSharedRoutineReview(handoff: SequenceReviewHandoff): Promise<ExportDocxResult & { session?: WriterSessionSummary | null }> {
    const result = await exportWriterSessionReview({
      copyToDownloads: true,
      pendingOnly: true,
      suggestions: pendingSuggestions,
      routineRun: {
        routineId: handoff.routineId,
        label: handoff.label,
        completedAt: new Date().toISOString(),
        instruction: handoff.instruction ?? null
      }
    });
    const artifact = result.routineRun ? await downloadWriterRoutineArtifact(result.routineRun.id) : null;
    return {
      blob: artifact?.blob ?? new Blob(),
      filename: artifact?.filename,
      report: result.report,
      session: result.session
    };
  }

  async function handleLoadSharedSession() {
    if (!editor) {
      pendingSharedSessionLoadRef.current = true;
      setDocumentNote("Preparing the editor before loading the shared Writer session...");
      return;
    }
    if (busy !== null || sharedSessionDocumentLoadingRef.current) {
      return;
    }
    if (!confirmDiscardPendingWork("load the shared Writer session")) {
      return;
    }
    sharedSessionDocumentLoadingRef.current = true;
    setError(null);
    setBusy("Loading shared session");
    try {
      const result = await getWriterSessionDocument(sharedSession?.sourceDocumentId);
      if (!result.session) {
        setSharedSession(null);
        setError("No shared Writer session is active.");
        return;
      }
      applySessionDocument(result.session, {
        documentNote: `Loaded shared Writer session: ${result.session.name}`,
        systemMessage: `Loaded ${result.session.name} from the shared Writer session. AI chat reset for this document.`
      });
    } catch (sessionError) {
      suppressUserTrackingRef.current = false;
      setError(describeError("Could not load the shared Writer session", sessionError, "the sidecar did not return a session"));
    } finally {
      sharedSessionDocumentLoadingRef.current = false;
      setBusy(null);
    }
  }

  // A suggestion accepted remotely (an MCP agent or another client) arrives as
  // a bare status flip — no client has applied the text yet. Apply it to the
  // document here so the accept actually lands (and reaches review export).
  // When the anchor moved or is ambiguous, hold the suggestion pending locally
  // for a human to confirm instead of letting an "accepted" status hide an
  // unapplied edit.
  function adoptSharedSuggestions(sharedSuggestions: AiSuggestion[]): AiSuggestion[] {
    if (!editor) {
      return sharedSuggestions;
    }
    const localStatuses = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion.status]));
    const heldTitles: string[] = [];
    const adopted = sharedSuggestions.map((shared) => {
      const localStatus = localStatuses.get(shared.id) ?? "pending";
      if (shared.status !== "accepted" || localStatus !== "pending") {
        return shared;
      }
      if (applyRemotelyAcceptedSuggestion(shared)) {
        return shared;
      }
      heldTitles.push(shared.title);
      return { ...shared, status: "pending" as const };
    });
    if (heldTitles.length) {
      setDocumentNote(`${heldTitles.length} agent-accepted change${heldTitles.length === 1 ? " needs" : "s need"} your confirmation`);
      appendMessage(
        "system",
        `Could not auto-apply ${heldTitles.length} remotely accepted change${heldTitles.length === 1 ? "" : "s"} (${heldTitles.join(", ")}): the original text moved or matches several places. ${heldTitles.length === 1 ? "It is" : "They are"} back in the pending queue — accept from the card to confirm the location.`
      );
    }
    return adopted;
  }

  // Returns true once the remotely accepted suggestion's text is verified in
  // the document (either applied here, or already applied by another client).
  function applyRemotelyAcceptedSuggestion(suggestion: AiSuggestion): boolean {
    if (!editor) {
      return false;
    }
    const textBeforeApply = editorTextSnapshot(editor).text;
    suppressUserTrackingRef.current = true;
    const result = applySuggestion(editor, suggestion, { confirmRelocated: false });
    lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
    suppressUserTrackingRef.current = false;
    if (!result.ok) {
      // Original text gone but the replacement is present: another client
      // already applied this accept and the edit arrived via collab.
      return result.reason === "missing"
        && Boolean(normalizeText(suggestion.replacement))
        && textBeforeApply.includes(suggestion.replacement);
    }
    const verifiedReplacementRange = verifyAppliedReplacement(editor, suggestion, result.range);
    if (!verifiedReplacementRange) {
      if (editorTextSnapshot(editor).text !== textBeforeApply) {
        suppressUserTrackingRef.current = true;
        editor.commands.undo();
        lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
        suppressUserTrackingRef.current = false;
      }
      return false;
    }
    clearManualMissingTarget(suggestion.id);
    const acceptedTrace = recordAcceptedReviewTrace(suggestion, result.range, verifiedReplacementRange);
    recordEditorTrackedChange({
      id: `${suggestion.id}-ai-change`,
      source: "ai",
      kind: "replace",
      title: suggestion.title,
      original: suggestion.original,
      replacement: suggestion.replacement,
      from: acceptedTrace?.from ?? result.range?.from ?? 0,
      to: acceptedTrace?.to ?? result.range?.to ?? 0,
      author: suggestion.proposedBy ?? suggestion.decidedBy ?? "Agent"
    });
    return true;
  }

  function handleSyncSharedSuggestions() {
    if (!sharedSession || sharedSession.sourceDocumentId !== sourceDocumentId) {
      return;
    }
    setSuggestions(adoptSharedSuggestions(sharedSession.suggestions));
    setReviewFilter("pending");
    setLastExportReport(null);
    setLastExportContext(null);
    setLoadedRoutineIntent(null);
    setEmptyAiResult(null);
    clearLocatedSuggestion();
    setDocumentNote(`Synced ${sharedSession.pendingSuggestions} agent suggestion${sharedSession.pendingSuggestions === 1 ? "" : "s"}`);
    appendMessage("system", `Synced review queue from shared Writer session: ${sharedSession.pendingSuggestions} pending suggestion${sharedSession.pendingSuggestions === 1 ? "" : "s"}.`);
  }

  function copyRoutineArtifactPath(run: WriterRoutineRun) {
    const path = run.downloadCopyPath || run.artifactPath;
    if (!path) {
      return;
    }
    void copyTextToClipboard(path)
      .then((copied) => copied ? setCopiedArtifactRunId(run.id) : setError("Could not copy the review DOCX path."))
      .catch(() => setError("Could not copy the review DOCX path."));
  }

  function copyRoutineReportPath(run: WriterRoutineRun) {
    if (!run.reportPath) {
      return;
    }
    void copyTextToClipboard(run.reportPath)
      .then((copied) => copied ? setCopiedArtifactRunId(run.id) : setError("Could not copy the review report path."))
      .catch(() => setError("Could not copy the review report path."));
  }

  function copyRoutineRunSummary(run: WriterRoutineRun) {
    const clipboardText = formatRoutineRunClipboard(run);
    void copyTextToClipboard(clipboardText)
      .then((copied) => {
        if (!copied) {
          showRoutineSummaryCopyBox(run, clipboardText);
          return;
        }
        setCopiedRoutineSummaryRunId(run.id);
        setRoutineSummaryCopyText(null);
        setDocumentNote(`Copied review export summary for ${run.label}`);
        appendMessage("system", `Copied review export summary for ${run.label}.`);
      })
      .catch(() => showRoutineSummaryCopyBox(run, clipboardText));
  }

  function showRoutineSummaryCopyBox(run: WriterRoutineRun, clipboardText: string) {
    setError(null);
    setCopiedRoutineSummaryRunId(null);
    setRoutineSummaryCopyText({ runId: run.id, text: clipboardText });
    setDocumentNote(`Opened summary copy box for ${run.label}`);
    appendMessage("system", `Clipboard was unavailable, so I opened a copy box for ${run.label}.`);
  }

  function copySuggestionReplacement(suggestion: AiSuggestion) {
    void copyTextToClipboard(suggestion.replacement)
      .then((copied) => {
        if (!copied) {
          setError("Could not copy the proposed text.");
          return;
        }
        setCopiedSuggestionId(suggestion.id);
        setCopiedOverlapGroupSuggestionId(null);
        setOverlapGroupCopyText(null);
      })
      .catch(() => setError("Could not copy the proposed text."));
  }

  function copyWordCommentOverlapGroup(anchorSuggestion: AiSuggestion, overlapGroup: AiSuggestion[]) {
    if (overlapGroup.length <= 1) {
      return;
    }
    const clipboardText = formatWordCommentOverlapGroupClipboardPacket(anchorSuggestion, overlapGroup);
    void copyTextToClipboard(clipboardText)
      .then((copied) => {
        if (!copied) {
          showOverlapGroupCopyBox(anchorSuggestion, overlapGroup, clipboardText);
          return;
        }
        setCopiedOverlapGroupSuggestionId(anchorSuggestion.id);
        setCopiedSuggestionId(null);
        setOverlapGroupCopyText(null);
        const copiedLabel = labelCount(overlapGroup.length, "same-source Word comment") ?? "same-source Word comments";
        setDocumentNote(`Copied ${copiedLabel} for ${anchorSuggestion.title}`);
        appendMessage("system", `Copied ${copiedLabel} from the same source text target as ${anchorSuggestion.title}.`);
      })
      .catch(() => showOverlapGroupCopyBox(anchorSuggestion, overlapGroup, clipboardText));
  }

  function copyWordCommentOverlapTriage() {
    if (!wordCommentOverlapGroupCount) {
      return;
    }
    const clipboardText = formatWordCommentOverlapTriageClipboardPacket(wordCommentPendingSuggestions);
    void copyTextToClipboard(clipboardText)
      .then((copied) => {
        if (!copied) {
          showOverlapTriageCopyBox(clipboardText);
          return;
        }
        setCopiedOverlapGroupSuggestionId("__word-comment-overlap-triage__");
        setCopiedSuggestionId(null);
        setOverlapGroupCopyText(null);
        const copiedLabel = labelCount(wordCommentOverlapGroupCount, "same-source Word comment group") ?? "same-source Word comment groups";
        setDocumentNote(`Copied ${copiedLabel}`);
        appendMessage("system", `Copied the same-source Word-comment triage packet for ${copiedLabel}.`);
      })
      .catch(() => showOverlapTriageCopyBox(clipboardText));
  }

  function showOverlapGroupCopyBox(anchorSuggestion: AiSuggestion, overlapGroup: AiSuggestion[], clipboardText: string) {
    setError(null);
    setCopiedOverlapGroupSuggestionId(null);
    setOverlapGroupCopyText({ suggestionId: anchorSuggestion.id, title: anchorSuggestion.title, text: clipboardText });
    const copiedLabel = labelCount(overlapGroup.length, "same-source Word comment") ?? "same-source Word comments";
    setDocumentNote(`Opened same-source copy box for ${copiedLabel}`);
    appendMessage("system", `Clipboard was unavailable, so I opened a same-source Word-comment copy box for ${anchorSuggestion.title}.`);
  }

  function showOverlapTriageCopyBox(clipboardText: string) {
    setError(null);
    setCopiedOverlapGroupSuggestionId(null);
    setOverlapGroupCopyText({ suggestionId: "__word-comment-overlap-triage__", title: "Same-source Word comments", text: clipboardText });
    const copiedLabel = labelCount(wordCommentOverlapGroupCount, "same-source Word comment group") ?? "same-source Word comment groups";
    setDocumentNote(`Opened same-source triage copy box for ${copiedLabel}`);
    appendMessage("system", "Clipboard was unavailable, so I opened a same-source Word-comment triage copy box.");
  }

  function rejectWordCommentOverlapAlternatives(anchorSuggestion: AiSuggestion, overlapGroup: AiSuggestion[]) {
    const ids = new Set(overlapGroup
      .filter((suggestion) => suggestion.id !== anchorSuggestion.id && suggestion.status === "pending")
      .map((suggestion) => suggestion.id));
    if (!ids.size) {
      return;
    }
    const rejectedStatus: AiSuggestion["status"] = "rejected";
    setLastExportReport(null);
    setLastExportContext(null);
    setSuggestions((current) => current.map((suggestion) => ids.has(suggestion.id) ? { ...suggestion, status: rejectedStatus } : suggestion));
    setSharedSession((current) => {
      if (!current) {
        return current;
      }
      const nextSuggestions = current.suggestions.map((suggestion) => ids.has(suggestion.id) ? { ...suggestion, status: rejectedStatus } : suggestion);
      return {
        ...current,
        suggestions: nextSuggestions,
        pendingSuggestions: countPendingSuggestions(nextSuggestions)
      };
    });
    if (activeSuggestionId && ids.has(activeSuggestionId)) {
      clearLocatedSuggestion(activeSuggestionId);
    }
    const rejectedLabel = labelCount(ids.size, "same-source Word comment") ?? "same-source Word comments";
    setDocumentNote(`Rejected ${rejectedLabel} for ${anchorSuggestion.title}`);
    appendMessage("system", `Kept ${anchorSuggestion.title} pending and rejected ${rejectedLabel} from the same source text target.`);
    void Promise.all([...ids].map((id) => setWriterSuggestionStatus(id, rejectedStatus))).catch(() => {
      setError("Rejected same-source Word comments locally, but the shared session could not be updated.");
    });
  }

  function copyVisibleSuggestions() {
    if (!visibleSuggestions.length) {
      return;
    }
    const clipboardText = formatSuggestionClipboardPacket(visibleSuggestions, reviewFilter);
    void copyTextToClipboard(clipboardText)
      .then((copied) => {
        if (!copied) {
          showVisibleSuggestionsCopyBox(clipboardText);
          return;
        }
        setCopiedVisibleSuggestionSignature(visibleSuggestionCopySignature);
        setVisibleSuggestionCopyText("");
        setOverlapGroupCopyText(null);
        const copiedLabel = labelCount(visibleSuggestions.length, "visible edit");
        setDocumentNote(`Copied ${copiedLabel}`);
        appendMessage("system", `Copied ${copiedLabel} from ${reviewFilterLabel(reviewFilter)}.`);
      })
      .catch(() => showVisibleSuggestionsCopyBox(clipboardText));
  }

  function copyRoutineRunEdits(run: WriterRoutineRun, runSuggestions: AiSuggestion[]) {
    if (!runSuggestions.length) {
      setError("No suggestions from this review export are loaded.");
      return;
    }
    const clipboardText = formatRoutineSuggestionClipboardPacket(run, runSuggestions);
    void copyTextToClipboard(clipboardText)
      .then((copied) => {
        if (!copied) {
          showRoutineEditsCopyBox(run, clipboardText);
          return;
        }
        setRoutineEditsCopyText(null);
        setDocumentNote(`Copied ${labelCount(runSuggestions.length, "edit")} from ${run.label}`);
        appendMessage("system", `Copied ${labelCount(runSuggestions.length, "edit")} from ${run.label}.`);
      })
      .catch(() => showRoutineEditsCopyBox(run, clipboardText));
  }

  function copyRoutineRunWordComments(run: WriterRoutineRun, wordCommentSuggestions: AiSuggestion[]) {
    if (!wordCommentSuggestions.length) {
      setError("No Word-comment suggestions from this review export are loaded.");
      return;
    }
    const clipboardText = formatRoutineWordCommentClipboardPacket(run, wordCommentSuggestions);
    void copyTextToClipboard(clipboardText)
      .then((copied) => {
        if (!copied) {
          showRoutineWordCommentsCopyBox(run, clipboardText);
          return;
        }
        setRoutineWordCommentsCopyText(null);
        setDocumentNote(`Copied ${labelCount(wordCommentSuggestions.length, "Word comment")} from ${run.label}`);
        appendMessage("system", `Copied ${labelCount(wordCommentSuggestions.length, "Word comment")} from ${run.label}.`);
      })
      .catch(() => showRoutineWordCommentsCopyBox(run, clipboardText));
  }

  function showVisibleSuggestionsCopyBox(clipboardText: string) {
    setError(null);
    setCopiedVisibleSuggestionSignature(null);
    setVisibleSuggestionCopyText(clipboardText);
    setOverlapGroupCopyText(null);
    const copiedLabel = labelCount(visibleSuggestions.length, "visible edit");
    setDocumentNote(`Opened copy box for ${copiedLabel}`);
    appendMessage("system", `Clipboard was unavailable, so I opened a copy box for ${copiedLabel} from ${reviewFilterLabel(reviewFilter)}.`);
  }

  function showRoutineEditsCopyBox(run: WriterRoutineRun, clipboardText: string) {
    setError(null);
    setRoutineEditsCopyText({ runId: run.id, text: clipboardText });
    setDocumentNote(`Opened edit copy box for ${run.label}`);
    appendMessage("system", `Clipboard was unavailable, so I opened a full-edit copy box for ${run.label}.`);
  }

  function showRoutineWordCommentsCopyBox(run: WriterRoutineRun, clipboardText: string) {
    setError(null);
    setRoutineWordCommentsCopyText({ runId: run.id, text: clipboardText });
    setDocumentNote(`Opened Word-comment copy box for ${run.label}`);
    appendMessage("system", `Clipboard was unavailable, so I opened a Word-comment copy box for ${run.label}.`);
  }

  async function downloadRoutineArtifact(run: WriterRoutineRun) {
    if (!run.artifactPath) {
      return;
    }
    setError(null);
    try {
      const artifact = await downloadWriterRoutineArtifact(run.id);
      const downloadFilename = artifact.filename || routineRunArtifactName(run.artifactPath);
      const saved = await saveBlobWithDownloadPrompt(artifact.blob, downloadFilename);
      setDocumentNote(saved ? `Downloaded ${downloadFilename}` : "Review DOCX download canceled");
    } catch (artifactError) {
      setError(artifactError instanceof Error ? artifactError.message : "Could not download the review DOCX artifact.");
    }
  }

  async function syncRoutineRunSuggestions(run: WriterRoutineRun) {
    if (!run.suggestionsPath) {
      return;
    }
    setError(null);
    try {
      const result = await syncWriterRoutineSuggestions(run.id);
      if (!result.session) {
        setError("No shared Writer session is active.");
        return;
      }
      setSharedSession(result.session);
      setSuggestions(result.session.suggestions);
      setReviewFilter("pending");
      setLastExportReport(null);
      setLastExportContext(null);
      setLoadedRoutineIntent(null);
      setEmptyAiResult(null);
      clearLocatedSuggestion();
      setDocumentNote(`Synced ${result.syncedSuggestions} suggestion${result.syncedSuggestions === 1 ? "" : "s"} from ${run.label}`);
      appendMessage("system", `Synced ${result.syncedSuggestions} saved suggestion${result.syncedSuggestions === 1 ? "" : "s"} from ${run.label}.`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Could not sync saved routine suggestions.");
    }
  }

  function reviewRoutineRun(run: WriterRoutineRun, index: number) {
    const runPendingSuggestions = routineRunSuggestions(run, suggestions).filter((suggestion) => suggestion.status === "pending");
    if (!runPendingSuggestions.length) {
      setError("No pending suggestions from this review export are loaded.");
      return;
    }
    setReviewFilter(index === 0 ? "latest" : "pending");
    setEmptyAiResult(null);
    setDocumentNote(`Reviewing ${labelCount(runPendingSuggestions.length, "pending suggestion")} from ${run.label}`);
    if (!locateSuggestion(runPendingSuggestions[0], { reportMissing: false, scrollCard: true })) {
      pendingSuggestionCardScrollRef.current = runPendingSuggestions[0].id;
      setActiveSuggestionId(runPendingSuggestions[0].id);
    }
  }

  function refineExportReport(report: ExportReport | null) {
    if (!exportReportNeedsRefinement(report)) {
      return;
    }
    setScope("global");
    setLoadedRoutineIntent(null);
    const documentText = plainText();
    setDraftInstruction(withBodySafeAnchorCandidates(buildExportReportRefinementInstruction(report, suggestions, documentText, docxBodySafeAnchors, docxBodySafeAnchorDetails), documentText, docxBodySafeAnchors, docxBodySafeAnchorDetails));
    setLoadedSequenceRoutineId(null);
    setEmptyAiResult(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function refineRoutineRun(run: WriterRoutineRun) {
    if (!routineRunNeedsRefinement(run)) {
      return;
    }
    setScope("global");
    setLoadedRoutineIntent(null);
    const documentText = plainText();
    setDraftInstruction(withBodySafeAnchorCandidates(buildRoutineRunRefinementInstruction(run, documentText, docxBodySafeAnchors, docxBodySafeAnchorDetails), documentText, docxBodySafeAnchors, docxBodySafeAnchorDetails));
    setLoadedSequenceRoutineId(null);
    setEmptyAiResult(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function refreshSourceMovedAnchors() {
    if (!sourceMovedPendingSuggestions.length) {
      return;
    }
    setScope("global");
    setLoadedRoutineIntent({
      label: "Missing target refresh",
      routineId: "r01-source-moved-refresh"
    });
    setDraftInstruction(buildSourceMovedRefreshInstruction(sourceMovedPendingSuggestions.length));
    setLoadedSequenceRoutineId(null);
    setEmptyAiResult(null);
    setReviewFilter("source-moved");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function dismissSourceMovedAnchors() {
    if (!sourceMovedPendingSuggestions.length) {
      return;
    }
    const ids = new Set(sourceMovedPendingSuggestions.map((suggestion) => suggestion.id));
    const dismissedCount = ids.size;
    const rejectedStatus: AiSuggestion["status"] = "rejected";
    setLastExportReport(null);
    setLastExportContext(null);
    setSuggestions((current) => current.map((suggestion) => ids.has(suggestion.id) ? { ...suggestion, status: rejectedStatus } : suggestion));
    setSharedSession((current) => {
      if (!current) {
        return current;
      }
      const nextSuggestions = current.suggestions.map((suggestion) => ids.has(suggestion.id) ? { ...suggestion, status: rejectedStatus } : suggestion);
      return {
        ...current,
        suggestions: nextSuggestions,
        pendingSuggestions: countPendingSuggestions(nextSuggestions)
      };
    });
    if (activeSuggestionId && ids.has(activeSuggestionId)) {
      clearLocatedSuggestion(activeSuggestionId);
    }
    setReviewFilter("pending");
    setDocumentNote(`Dismissed ${labelCount(dismissedCount, "missing target edit")}`);
    appendMessage("system", `Dismissed ${labelCount(dismissedCount, "stale Missing target suggestion")}.`);
    void Promise.all([...ids].map((id) => setWriterSuggestionStatus(id, rejectedStatus))).catch(() => {
      setError("Dismissed missing target edits locally, but the shared session could not be updated.");
    });
  }

  function dismissSharedAnchorAlternatives() {
    if (!sharedAnchorDismissibleAlternatives.length) {
      return;
    }
    const ids = new Set(sharedAnchorDismissibleAlternatives.map((suggestion) => suggestion.id));
    const dismissedCount = ids.size;
    const rejectedStatus: AiSuggestion["status"] = "rejected";
    setLastExportReport(null);
    setLastExportContext(null);
    setSuggestions((current) => current.map((suggestion) => ids.has(suggestion.id) ? { ...suggestion, status: rejectedStatus } : suggestion));
    setSharedSession((current) => {
      if (!current) {
        return current;
      }
      const nextSuggestions = current.suggestions.map((suggestion) => ids.has(suggestion.id) ? { ...suggestion, status: rejectedStatus } : suggestion);
      return {
        ...current,
        suggestions: nextSuggestions,
        pendingSuggestions: countPendingSuggestions(nextSuggestions)
      };
    });
    if (activeSuggestionId && ids.has(activeSuggestionId)) {
      clearLocatedSuggestion(activeSuggestionId);
    }
    setReviewFilter("pending");
    setDocumentNote(`Dismissed ${labelCount(dismissedCount, "non-winner alternative")}`);
    appendMessage("system", `Dismissed ${labelCount(dismissedCount, "non-winner shared-target alternative")}.`);
    void Promise.all([...ids].map((id) => setWriterSuggestionStatus(id, rejectedStatus))).catch(() => {
      setError("Dismissed shared-target alternatives locally, but the shared session could not be updated.");
    });
  }

  function editRoutineRunPrompt(run: WriterRoutineRun) {
    if (!run.instruction?.trim()) {
      return;
    }
    setScope("global");
    setLoadedRoutineIntent({
      label: run.label,
      routineId: run.routineId
    });
    setDraftInstruction(run.instruction);
    setLoadedSequenceRoutineId(null);
    setEmptyAiResult(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function refineEmptyAiResult() {
    if (!emptyAiResult) {
      return;
    }
    setLoadedRoutineIntent(null);
    setDraftInstruction(buildRefinedInstruction(emptyAiResult));
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function retryEmptyAiResultWithProvider(nextProvider: InteractiveProviderName) {
    setProvider(nextProvider);
    refineEmptyAiResult();
  }

  function useRoutine(routine: WritingRoutine, options: { fromSequence?: boolean } = {}) {
    setScope("global");
    setMaxSuggestionsInput(routine.recommendedMaxSuggestions ? String(routine.recommendedMaxSuggestions) : "");
    setDraftInstruction(routine.id === "r01-body-safe" ? withBodySafeAnchorCandidates(routine.prompt, plainText(), docxBodySafeAnchors, docxBodySafeAnchorDetails) : routine.prompt);
    setLoadedRoutineIntent({
      label: routine.label,
      routineId: routine.id
    });
    setLoadedSequenceRoutineId(options.fromSequence ? routine.id : null);
    setSequenceExportSummary(null);
    if (!options.fromSequence) {
      setSequenceReviewHandoff(null);
    }
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function useThinAimBodySafePrompt() {
    if (!thinBodySafeAimSections.length) {
      return;
    }
    setScope("global");
    setMaxSuggestionsInput("2");
    setDraftInstruction(buildThinAimBodySafeInstruction(thinBodySafeAimSections, plainText(), docxBodySafeAnchorDetails));
    setLoadedRoutineIntent({
      label: "Thin Aim body-safe",
      routineId: "r01-thin-aim-body-safe"
    });
    setLoadedSequenceRoutineId(null);
    setSequenceReviewHandoff(null);
    setSequenceExportSummary(null);
    setEmptyAiResult(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function useMilestonesPayoffBodySafePrompt() {
    if (!uncoveredMilestonesBodySafeAnchors.length) {
      return;
    }
    setScope("global");
    setMaxSuggestionsInput("2");
    setDraftInstruction(buildMilestonesPayoffBodySafeInstruction(uncoveredMilestonesBodySafeAnchors, plainText(), docxBodySafeAnchorDetails));
    setLoadedRoutineIntent({
      label: "Milestones payoff",
      routineId: "r01-milestones-payoff-body-safe"
    });
    setLoadedSequenceRoutineId(null);
    setSequenceReviewHandoff(null);
    setSequenceExportSummary(null);
    setEmptyAiResult(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function useLanguagePolishBodySafePrompt() {
    if (!uncoveredLanguagePolishBodySafeAnchors.length) {
      return;
    }
    setScope("global");
    setMaxSuggestionsInput(String(Math.min(3, uncoveredLanguagePolishBodySafeAnchors.length)));
    setDraftInstruction(buildLanguagePolishBodySafeInstruction(uncoveredLanguagePolishBodySafeAnchors, plainText(), docxBodySafeAnchorDetails));
    setLoadedRoutineIntent({
      label: "Language polish",
      routineId: "r01-language-polish-body-safe"
    });
    setLoadedSequenceRoutineId(null);
    setSequenceReviewHandoff(null);
    setSequenceExportSummary(null);
    setEmptyAiResult(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function useVerificationHandoffPrompt() {
    if (!verificationNotes.length) {
      return;
    }
    setScope("global");
    setMaxSuggestionsInput("");
    setDraftInstruction(buildVerificationHandoffInstruction(verificationNotes));
    setLoadedRoutineIntent({
      label: "Fact-check handoff",
      routineId: "proposal-verification-handoff"
    });
    setLoadedSequenceRoutineId(null);
    setSequenceReviewHandoff(null);
    setSequenceExportSummary(null);
    setEmptyAiResult(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function useSectionBodySafePrompt(section: string, anchors: string[]) {
    const uncoveredAnchors = bodySafeUncoveredAnchors(anchors, pendingSuggestions);
    if (!uncoveredAnchors.length) {
      return;
    }
    setScope("global");
    setMaxSuggestionsInput("2");
    setDraftInstruction(buildSectionBodySafeInstruction(section, uncoveredAnchors, plainText(), docxBodySafeAnchorDetails));
    setLoadedRoutineIntent({
      label: `${section} body-safe`,
      routineId: "r01-section-body-safe"
    });
    setLoadedSequenceRoutineId(null);
    setSequenceReviewHandoff(null);
    setSequenceExportSummary(null);
    setEmptyAiResult(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function useNextRoutineInSequence() {
    useRoutine(nextR01Routine, { fromSequence: true });
  }

  function openSavePromptForm() {
    setSavePromptFormOpen(true);
    window.setTimeout(() => routineNameInputRef.current?.focus(), 0);
  }

  function restartRoutineSequence() {
    setRoutineSequenceIndex(0);
    setLoadedSequenceRoutineId(null);
    setLoadedRoutineIntent(null);
    setSequenceReviewHandoff(null);
    setSequenceExportSummary(null);
    setCompletedSequenceRoutineIds(persistSequenceProgress([]));
  }

  function persistSequenceProgress(routineIds: string[]): string[] {
    const saved = saveSequenceProgress(sourceDocumentId, routineIds);
    void setWriterRoutineProgress(saved, sharedSessionWriteContext()).catch(() => {
      setDocumentNote("Routine progress saved locally, but the shared session could not be updated (sidecar unreachable)");
    });
    return saved;
  }

  function advanceRoutineSequenceAfter(routine: WritingRoutine) {
    const sequenceIndex = r01RoutineSequence.findIndex((candidate) => candidate.id === routine.id);
    if (sequenceIndex >= 0) {
      setRoutineSequenceIndex((sequenceIndex + 1) % r01RoutineSequence.length);
      setLoadedSequenceRoutineId(null);
    }
  }

  function saveCurrentRoutine() {
    const prompt = instruction.trim();
    if (!prompt) {
      return;
    }
    const label = truncate((routineName.trim() || defaultRoutineName(prompt)).replace(/\s+/g, " "), 42);
    const routine: WritingRoutine = {
      id: `routine-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label,
      prompt
    };
    setUserRoutines((current) => [...current.filter((item) => item.label !== label), routine]);
    setRoutineName("");
    setSavePromptFormOpen(false);
    setDocumentNote(`Saved skill: ${label}`);
  }

  function deleteRoutine(id: string) {
    const routine = userRoutines.find((candidate) => candidate.id === id);
    if (routine && typeof window !== "undefined" && typeof window.confirm === "function") {
      // jsdom's unimplemented confirm returns undefined; only explicit Cancel stops.
      if (window.confirm(`Delete saved skill "${routine.label}"?`) === false) {
        return;
      }
    }
    setUserRoutines((current) => current.filter((routine) => routine.id !== id));
  }

  function setDraftInstruction(value: string) {
    setInstruction(value);
    if (value.trim()) {
      setEmptyAiResult(null);
      if (!aiRequestBlocked) {
        setError(null);
      }
    }
  }

  function handleInstructionChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setDraftInstruction(event.target.value);
  }

  async function handleAttachFiles(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) {
      return;
    }
    // Uploads go to whichever sidecar will run the CLI; without one there is
    // no machine to hold the file.
    if (cloudMode && !localAiActiveRef.current) {
      setError("Attachments run through your local Writer. Start it (see 'Set up AI') and try again.");
      setSetupGuideOpen(true);
      return;
    }
    const room = AI_ATTACHMENT_LIMIT - pendingAttachments.length;
    if (room <= 0) {
      setError(`AI requests support at most ${AI_ATTACHMENT_LIMIT} attachments; remove one first.`);
      return;
    }
    setAttachmentBusy(true);
    setError(null);
    try {
      for (const file of list.slice(0, room)) {
        const attachment = await uploadAiAttachment(file, localAiActiveRef.current ? "local" : "sidecar");
        setPendingAttachments((current) => [...current, attachment]);
      }
      if (list.length > room) {
        setError(`Attached the first ${room} file${room === 1 ? "" : "s"}; AI requests support at most ${AI_ATTACHMENT_LIMIT} attachments.`);
      }
    } catch (uploadError) {
      setError(describeError("Attaching the file failed", uploadError, "the Writer sidecar did not accept the upload"));
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function handleSend() {
    const trimmedInstruction = instruction.trim();
    if (!editor || !trimmedInstruction || busy !== null || aiRequestInFlightRef.current) {
      return;
    }
    const maxSuggestions = parseMaxSuggestionsInput(maxSuggestionsInput);
    if (maxSuggestionsInput.trim() && maxSuggestions === null) {
      setError(maxSuggestionsErrorMessage);
      return;
    }
    if (cliUnavailable) {
      setError(selectedProviderStatus?.available === false
        ? `${providerLabel(provider)} CLI was not found on PATH.`
        : "Local CLI execution is locked for this sidecar. Restart without WRITER_ALLOW_CLI=0, or set WRITER_ALLOW_CLI=1.");
      return;
    }
    const activeScope = scope === "selection" && selection ? "selection" : "global";
    const currentDocumentText = plainText();
    const controller = new AbortController();
    const requestId = aiRequestSeqRef.current + 1;
    aiRequestSeqRef.current = requestId;
    aiAbortControllerRef.current = controller;
    aiRequestInFlightRef.current = true;
    setBusy("Asking AI");
    setError(null);
    setEmptyAiResult(null);
    setInstruction("");
    // Attachments are STICKY context: they stay attached across turns (and
    // across a failed request) until the user removes them, so a file never
    // needs re-attaching and is included with every message in the thread.
    const requestAttachments = pendingAttachments;
    appendMessage("user", `${activeScope === "selection" ? "Selection" : "Document"}: ${trimmedInstruction}${requestAttachments.length ? `\n📎 ${requestAttachments.map((attachment) => attachment.name).join(", ")}` : ""}`);
    if (activeScope === "global" && currentDocumentText.length > AI_CONTEXT_CHAR_LIMIT) {
      appendMessage("system", "Document exceeds one AI request budget; using complete-document coverage passes.");
    }
    try {
      const aiRequest: AiRequest = {
        provider,
        instruction: trimmedInstruction,
        mode: activeScope,
        documentHtml: "",
        documentText: currentDocumentText,
        maxSuggestions,
        selection: activeScope === "selection" ? selection : null,
        requestedBy: collabSession.user.name,
        docId: docId ?? undefined,
        attachments: requestAttachments.length ? requestAttachments : undefined,
        toolAccess,
        agentSessionId: agentSessionsRef.current[`${provider}:${docId ?? "scratch"}`] ?? null
      };
      // Personal runner: their own CLI account, with staging left to the
      // cloud session (recordWriterSuggestions) instead of the local one.
      const response = localAiActiveRef.current
        ? await requestLocalAiSuggestion({ ...aiRequest, stageSuggestions: false }, { signal: controller.signal })
        : await requestAiSuggestion(aiRequest, { signal: controller.signal });
      if (response.agentSessionId) {
        agentSessionsRef.current[`${provider}:${docId ?? "scratch"}`] = response.agentSessionId;
      }
      receiveAiResponse(response, {
        instruction: trimmedInstruction,
        mode: activeScope,
        provider,
        routineIntent: loadedRoutineIntent,
        sequenceRoutineId: loadedSequenceRoutineId
      });
    } catch (aiError) {
      if (isAbortError(aiError)) {
        return;
      }
      // Attachments are sticky, so a failed request keeps them automatically —
      // just retry. Say so, so the error doesn't read as "your file is gone".
      setError(describeError(
        `AI request to ${providerLabel(provider)} failed`,
        aiError,
        requestAttachments.length
          ? `the provider did not return a response. Your ${requestAttachments.length === 1 ? "attachment is" : "attachments are"} still attached — just send again.`
          : "the provider did not return a response"
      ));
    } finally {
      if (aiRequestSeqRef.current === requestId) {
        aiRequestInFlightRef.current = false;
        aiAbortControllerRef.current = null;
        setBusy(null);
      }
    }
  }

  function handleInterruptAi() {
    const controller = aiAbortControllerRef.current;
    if (!controller || controller.signal.aborted) {
      return;
    }
    controller.abort();
    aiAbortControllerRef.current = null;
    aiRequestInFlightRef.current = false;
    setBusy(null);
    appendMessage("system", "Stopped the in-flight AI request. You can revise the prompt and send a new one.");
  }

  async function handleProviderSmokeTest() {
    setBusy("Testing AI provider");
    setError(null);
    setProviderCheck(null);
    try {
      const result = await runProviderSmokeTest(provider);
      setProviderCheck(result);
      appendMessage(
        "system",
        `${providerLabel(provider)} smoke test ${result.ok ? "passed" : "needs attention"}: ${result.message}`
      );
      if (!result.ok) {
        setError(result.message);
      }
    } catch (smokeError) {
      setError(smokeError instanceof Error ? smokeError.message : "Provider smoke test failed");
    } finally {
      setBusy(null);
    }
  }

  // Terminal-driven Writer: open a real claude/codex REPL that drives THIS
  // document, reached through hop's secure web terminal (Cloudflare tunnel +
  // 2FA — no local port exposed to the browser). The terminal runs on the
  // user's OWN machine, so on a cloud page this asks the local sidecar.
  async function handleOpenAgentTerminal() {
    // Local mode: the Writer server owns the PTY and serves this page, so the
    // terminal embeds inline, same-origin — no hop, no tunnel. Just toggle it.
    if (localMode) {
      const opening = !terminalOpen;
      setTerminalOpen(opening);
      if (opening) {
        // Deliberate open: hand the keyboard to the terminal. (The terminal
        // never takes focus on its own — socket connects are not user intent.)
        window.setTimeout(() => {
          document.querySelector<HTMLElement>(".terminal-dock .xterm-helper-textarea")?.focus();
        }, 120);
      }
      return;
    }
    // Remote (hop) mode: reach the terminal through hop's secured web UI.
    setAgentTerminalBusy(true);
    setError(null);
    try {
      const status = await ensureAgentTerminal(provider === "codex" ? "codex" : "claude", cloudMode ? "local" : "sidecar");
      if (!status.available || !status.url) {
        setError(status.detail || "The agent terminal is unavailable — open your local Writer (http://localhost:8787), or set up hop for remote access.");
        return;
      }
      window.open(status.url, "_blank", "noopener");
      appendMessage(
        "system",
        `Opened the ${providerLabel(provider)} agent terminal${status.tunnel ? " (secured by hop — Cloudflare tunnel + 2FA)" : ""}. Edits it stages land in this review queue. ${status.detail}`
      );
    } catch (terminalError) {
      setError(terminalError instanceof Error ? terminalError.message : "Could not open the agent terminal.");
    } finally {
      setAgentTerminalBusy(false);
    }
  }

  function receiveAiResponse(
    response: AiResponse,
    request: { instruction: string; mode: "global" | "selection"; provider: InteractiveProviderName; routineIntent: RoutineIntent | null; sequenceRoutineId: string | null }
  ) {
    appendMessage("assistant", response.message, providerLabel(request.provider));
    if (response.suggestions.length) {
      setReviewFilter("pending");
      setLastExportReport(null);
      setLastExportContext(null);
      setEmptyAiResult(null);
      const attributedSuggestions = response.suggestions.map((suggestion) => ({
        ...suggestion,
        proposedBy: suggestion.proposedBy ?? collabSession.user.name
      }));
      setSuggestions((current) => [...attributedSuggestions, ...current]);
      // Mirror the proposals into the shared session so collaborators and
      // agents see them live (best-effort: 400s harmlessly with no session).
      void recordWriterSuggestions(attributedSuggestions, sharedSessionWriteContext()).catch(() => undefined);
      const sequenceRoutine = request.sequenceRoutineId
        ? r01RoutineSequence.find((routine) => routine.id === request.sequenceRoutineId)
        : null;
      const wordCommentHandoffIntent = isWordCommentHandoffRoutineId(request.routineIntent?.routineId)
        ? request.routineIntent
        : null;
      if (sequenceRoutine) {
        setSequenceExportSummary(null);
        setSequenceReviewHandoff({
          instruction: request.instruction,
          label: sequenceRoutine.label,
          routineId: sequenceRoutine.id,
          suggestionCount: response.suggestions.length
        });
        advanceRoutineSequenceAfter(sequenceRoutine);
      } else if (wordCommentHandoffIntent) {
        setSequenceExportSummary(null);
        setSequenceReviewHandoff({
          instruction: request.instruction,
          label: wordCommentHandoffIntent.label,
          routineId: wordCommentHandoffIntent.routineId,
          suggestionCount: response.suggestions.length
        });
      }
      locateSuggestion(response.suggestions[0], { reportMissing: false, scrollCard: true });
      return;
    }
    setEmptyAiResult({
      instruction: request.instruction,
      message: response.message,
      mode: request.mode,
      provider: request.provider
    });
  }

  function clearManualMissingTarget(suggestionId: string) {
    setManualMissingTargetSuggestionIds((current) => current.filter((id) => id !== suggestionId));
  }

  function reportMissingSuggestionTarget(suggestion: AiSuggestion) {
    setManualMissingTargetSuggestionIds((current) => current.includes(suggestion.id) ? current : [suggestion.id, ...current].slice(0, 50));
    setReviewFilter("source-moved");
    setError("I could not find that original text in the current editor. I opened Missing target so you can refresh or dismiss stale suggestions before applying more changes.");
    setDocumentNote(`Missing target: ${suggestion.title}`);
  }

  // Inline (mark-carried) suggestions resolve as document transactions per
  // docs/suggesting-mode.md: accept an insertion = drop the mark, reject =
  // delete the text; accept a deletion = delete the struck text, reject =
  // drop the mark. Suppress the diff audit log around the transaction so a
  // resolution doesn't show up as the resolver's own "User" edit.
  // Phase 2 default: NEW AI proposals land inline as agent-authored marks
  // instead of waiting in the queue. Scope (this slice): local mode, unshared
  // docs — shared docs keep the queue flow until cross-server claiming is
  // settled. Multi-tab safety: a tab first CLAIMS the suggestion by flipping
  // its status with expectedStatus:"pending" (the server 409s the loser), and
  // only the winner writes marks, so two tabs never double-materialize.
  // Pending suggestions present at page load stay in the queue (no surprise
  // migration); only arrivals after mount move inline. Missing targets also
  // stay in the queue, where the existing missing-target flow handles them.
  const inlineAiAttemptedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!editor || !localMode) {
      return;
    }
    if (inlineAiAttemptedRef.current === null) {
      inlineAiAttemptedRef.current = new Set(pendingSuggestions.map((suggestion) => suggestion.id));
      return;
    }
    const attempted = inlineAiAttemptedRef.current;
    for (const suggestion of pendingSuggestions) {
      if (attempted.has(suggestion.id)) {
        continue;
      }
      // Shared docs: only the STAGING server's clients claim (the suggestion
      // carries its origin sidecar's instance id) — a remote Writer's clients
      // see it via the CRDT map and let the origin materialize, so two
      // servers never double-mark the shared doc. Same-server races are
      // settled by the expectedStatus claim as before.
      if (cloudSynced && (!suggestion.origin || suggestion.origin !== healthForAi?.instanceId)) {
        continue;
      }
      attempted.add(suggestion.id);
      void claimAndMaterializeInline(suggestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSuggestions, editor, localMode, cloudSynced, healthForAi?.instanceId]);

  async function claimAndMaterializeInline(suggestion: AiSuggestion) {
    if (!editor) {
      return;
    }
    if (!inlineMaterializeRange(suggestion)) {
      return;
    }
    try {
      await setWriterSuggestionStatus(suggestion.id, "accepted", {
        ...sharedSessionWriteContext(),
        expectedStatus: "pending",
        decidedBy: collabSession.user.name,
        decisionNote: "Moved inline as a suggestion mark"
      });
    } catch {
      // Lost the claim to another tab (409), or the suggestion is
      // browser-only/offline — leave the card in the queue.
      return;
    }
    // Re-find after the network round trip: the doc may have moved.
    const range = editor && inlineMaterializeRange(suggestion);
    if (!editor || !range) {
      void setWriterSuggestionStatus(suggestion.id, "pending", sharedSessionWriteContext()).catch(() => undefined);
      return;
    }
    suppressUserTrackingRef.current = true;
    const changeId = applyReplacementAsSuggestionMarks(editor, range, suggestion.replacement, {
      author: `ai-${suggestion.proposedBy ?? providerLabel(provider)}`,
      authorName: suggestion.proposedBy ?? providerLabel(provider),
      color: "#7b1fa2",
      role: "ai"
    });
    lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
    suppressUserTrackingRef.current = false;
    if (!changeId) {
      void setWriterSuggestionStatus(suggestion.id, "pending", sharedSessionWriteContext()).catch(() => undefined);
      return;
    }
    const decidedAt = new Date().toISOString();
    setSuggestions((current) => current.map((candidate) => candidate.id === suggestion.id
      ? { ...candidate, status: "accepted", decidedBy: collabSession.user.name, decidedAt, decisionNote: "Moved inline as a suggestion mark" }
      : candidate));
    setDocumentNote(`New AI proposal marked inline: ${suggestion.title}`);
  }

  // Phase 2 (AI proposals as marks): materialize a pending AI proposal in the
  // document as agent-authored suggestion marks — strike over the matched
  // original plus an insertion of the replacement under one changeId, the same
  // shape a human replacement produces. The session card resolves as accepted
  // ("moved inline"); the marks become the reviewable source of truth for
  // everyone, including collaborators on other Writers.
  // For MARK materialization prefer the exact original-text range: the
  // anchor-expanded range (findSuggestionRange) exists for context-carrying
  // replacements, but as a strike it covers neighboring prose and reads as if
  // the agent proposed rewriting text it never touched.
  function inlineMaterializeRange(suggestion: AiSuggestion): { from: number; to: number } | null {
    if (!editor) {
      return null;
    }
    return findTextRange(editor, suggestion.original) ?? findSuggestionRange(editor, suggestion);
  }

  function markSuggestionInline(suggestion: AiSuggestion) {
    if (!editor) {
      return;
    }
    const range = inlineMaterializeRange(suggestion);
    if (!range) {
      reportMissingSuggestionTarget(suggestion);
      return;
    }
    suppressUserTrackingRef.current = true;
    const changeId = applyReplacementAsSuggestionMarks(editor, range, suggestion.replacement, {
      author: `ai-${suggestion.proposedBy ?? providerLabel(provider)}`,
      authorName: suggestion.proposedBy ?? providerLabel(provider),
      color: "#7b1fa2",
      role: "ai"
    });
    lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
    suppressUserTrackingRef.current = false;
    if (!changeId) {
      setError(`Could not mark "${suggestion.title}" inline.`);
      return;
    }
    updateSuggestionStatus(suggestion.id, "accepted");
    clearLocatedSuggestion();
    centerEditorRange(editor, range);
    setDocumentNote(`Marked inline: ${suggestion.title} — accept or reject it in the document.`);
    setError(null);
  }

  // Clicking an inline card scrolls the document to the marked cluster and
  // flashes the review highlight on it — same affordance as session cards.
  function jumpToInlineSuggestion(suggestion: AiSuggestion) {
    if (!editor || !suggestion.range || suggestion.range.from >= suggestion.range.to) {
      return;
    }
    const docSize = editor.state.doc.content.size;
    const range = {
      from: Math.max(0, Math.min(suggestion.range.from, docSize)),
      to: Math.max(0, Math.min(suggestion.range.to, docSize))
    };
    if (range.from >= range.to) {
      return;
    }
    setReviewHighlight(editor, range);
    centerEditorRange(editor, range);
  }

  function resolveInlineSuggestion(suggestion: AiSuggestion, decision: "accept" | "reject") {
    if (!editor) {
      return;
    }
    // Target the card's changeId set: a replacement card may cover a deletion
    // strike and an insertion with different changeIds, but another author's
    // overlapping marks must never be swept along (range targeting did — a
    // two-agent duel on one sentence lost part of the surviving suggestion).
    const target = suggestion.markChangeIds?.length
      ? { changeIds: suggestion.markChangeIds }
      : suggestion.range && suggestion.range.from < suggestion.range.to
        ? { from: suggestion.range.from, to: suggestion.range.to }
        : { changeId: suggestion.id.replace(/-mark-export$/, "") };
    suppressUserTrackingRef.current = true;
    const resolved = resolveSuggestionMarks(editor, target, decision);
    lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
    suppressUserTrackingRef.current = false;
    if (!resolved) {
      setError("This inline suggestion is no longer in the document (already resolved elsewhere).");
      return;
    }
    setDocumentNote(`${decision === "accept" ? "Accepted" : "Rejected"} inline suggestion${suggestion.proposedBy ? ` by ${suggestion.proposedBy}` : ""}`);
    setError(null);
  }

  function acceptSuggestion(suggestion: AiSuggestion) {
    if (!editor) {
      return;
    }
    const confirmRelocated = relocatedAcceptConfirmRef.current === suggestion.id;
    const textBeforeApply = editorTextSnapshot(editor).text;
    suppressUserTrackingRef.current = true;
    const result = applySuggestion(editor, suggestion, { confirmRelocated });
    lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
    suppressUserTrackingRef.current = false;
    if (!result.ok) {
      if (result.reason === "needs-confirmation" && result.range) {
        relocatedAcceptConfirmRef.current = suggestion.id;
        setReviewHighlight(editor, result.range);
        centerEditorRange(editor, result.range);
        markSuggestionCardLocatedNow(suggestion.id);
        setError(
          result.matchKind === "ambiguous"
            ? "This text appears in more than one place, so I highlighted the closest match. Check the highlighted location, then click Accept again to replace it there."
            : "The original text has moved since this suggestion was created. Check the highlighted location, then click Accept again to replace it there."
        );
        setDocumentNote(`Confirm location: ${suggestion.title}`);
        return;
      }
      relocatedAcceptConfirmRef.current = null;
      reportMissingSuggestionTarget(suggestion);
      return;
    }
    relocatedAcceptConfirmRef.current = null;
    const sourceRange = result.range;
    const verifiedReplacementRange = verifyAppliedReplacement(editor, suggestion, sourceRange);
    if (!verifiedReplacementRange) {
      if (editorTextSnapshot(editor).text !== textBeforeApply) {
        suppressUserTrackingRef.current = true;
        editor.commands.undo();
        lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
        suppressUserTrackingRef.current = false;
      }
      setError(`Could not apply "${suggestion.title}": the replacement did not land where expected. The document was left unchanged and the suggestion is still pending.`);
      appendMessage("system", `Apply failed: ${suggestion.title}. The suggestion is still pending.`);
      return;
    }
    clearManualMissingTarget(suggestion.id);
    const acceptedTrace = recordAcceptedReviewTrace(suggestion, sourceRange, verifiedReplacementRange);
    recordEditorTrackedChange({
      id: `${suggestion.id}-ai-change`,
      source: "ai",
      kind: "replace",
      title: suggestion.title,
      original: suggestion.original,
      replacement: suggestion.replacement,
      from: acceptedTrace?.from ?? sourceRange?.from ?? 0,
      to: acceptedTrace?.to ?? sourceRange?.to ?? 0,
      author: suggestion.proposedBy ?? collabSession.user.name
    });
    updateSuggestionStatus(suggestion.id, "accepted");
    if (autoAdvanceReview) {
      advanceAfterResolution(suggestion.id);
    } else {
      clearLocatedSuggestion();
      centerEditorRange(editor, verifiedReplacementRange.from < verifiedReplacementRange.to
        ? verifiedReplacementRange
        : { from: verifiedReplacementRange.from, to: verifiedReplacementRange.from + 1 });
    }
    setDocumentNote("Edited with AI suggestion");
    setError(null);
    appendMessage("system", `Accepted: ${suggestion.title}.`);
  }

  function verifyAppliedReplacement(
    editorInstance: Editor,
    suggestion: AiSuggestion,
    sourceRange: { from: number; to: number }
  ): { from: number; to: number } | null {
    const docSize = editorInstance.state.doc.content.size;
    if (!normalizeText(suggestion.replacement)) {
      // Deletion suggestion: confirm the original text is gone from the source location.
      const windowFrom = Math.max(0, Math.min(sourceRange.from, docSize));
      const windowTo = Math.min(docSize, sourceRange.from + suggestion.original.length + 80);
      try {
        const remaining = windowTo > windowFrom ? editorInstance.state.doc.textBetween(windowFrom, windowTo, "\n") : "";
        return normalizeText(remaining).includes(normalizeText(suggestion.original))
          ? null
          : { from: windowFrom, to: windowFrom };
      } catch {
        return null;
      }
    }
    const searchWindow = {
      from: Math.max(0, sourceRange.from - 2),
      to: Math.min(docSize, sourceRange.from + Math.max(suggestion.replacement.length + 80, 160))
    };
    return findTextRange(editorInstance, suggestion.replacement, searchWindow);
  }

  function recordAcceptedReviewTrace(
    suggestion: AiSuggestion,
    sourceRange: { from: number; to: number } | null,
    replacementRangeHint?: { from: number; to: number } | null
  ): ReviewTrace | null {
    if (!editor || !sourceRange) {
      return null;
    }
    const hinted = replacementRangeHint && replacementRangeHint.from < replacementRangeHint.to ? replacementRangeHint : null;
    const searchWindow = {
      from: sourceRange.from,
      to: Math.min(editor.state.doc.content.size, sourceRange.from + Math.max(suggestion.replacement.length + 80, 160))
    };
    const replacementRange = hinted
      ?? findTextRange(editor, suggestion.replacement, searchWindow)
      ?? {
        from: sourceRange.from,
        to: Math.min(editor.state.doc.content.size, sourceRange.from + Math.max(1, suggestion.replacement.length))
      };
    const trace: ReviewTrace = {
      id: `${suggestion.id}-accepted`,
      status: "accepted",
      title: `Accepted: ${suggestion.title}`,
      ...replacementRange
    };
    acceptedReviewTracesRef.current = [
      trace,
      ...acceptedReviewTracesRef.current.filter((existing) => existing.id !== trace.id)
    ].slice(0, 24);
    addReviewTrace(editor, trace);
    return trace;
  }

  function jumpToSuggestion(suggestion: AiSuggestion) {
    locateSuggestion(suggestion, { reportMissing: true, scrollCard: false });
  }

  function locateSuggestion(suggestion: AiSuggestion, options: { reportMissing: boolean; scrollCard?: boolean }): boolean {
    if (!editor) {
      return false;
    }
    markSuggestionCardLocatedNow(suggestion.id);
    const range = selectSuggestionTarget(editor, suggestion);
    if (!range) {
      if (options.reportMissing) {
        reportMissingSuggestionTarget(suggestion);
      }
      return false;
    }
    // Locating a suggestion selects its target so the author can see it, but
    // that is a review action, not an authorial selection — it must not
    // silently scope the next chat message to this passage. Pre-detach it;
    // the author can re-attach with one click if they do want that scope.
    setDetachedSelectionKey(`${range.from}:${range.to}:${editor.state.doc.textBetween(range.from, range.to, "\n").length}`);
    clearManualMissingTarget(suggestion.id);
    pendingSuggestionEditorCenterRef.current = suggestion.id;
    setReviewHighlight(editor, range);
    centerSuggestionTarget(editor, suggestion, range);
    setError(null);
    pendingSuggestionCardScrollRef.current = options.scrollCard && !scrollSuggestionCardIntoView(suggestion.id) ? suggestion.id : null;
    activateSuggestionNow(suggestion.id);
    return true;
  }

  function activateSuggestionNow(id: string) {
    if (activeSuggestionId === id) {
      return;
    }
    if (activeSuggestionUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(activeSuggestionUpdateFrameRef.current);
      activeSuggestionUpdateFrameRef.current = null;
    }
    setActiveSuggestionId(id);
  }

  function scrollSuggestionCardIntoView(id: string): boolean {
    const card = suggestionCardRefs.current.get(id);
    if (!card || typeof card.scrollIntoView !== "function") {
      return false;
    }
    scrollSuggestionCardElementIntoView(card);
    return true;
  }

  function scrollSuggestionCardElementIntoView(card: HTMLElement) {
    card.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
  }

  function markSuggestionCardLocatedNow(id: string) {
    const previousId = instantLocatedSuggestionIdRef.current;
    if (previousId && previousId !== id) {
      const previousCard = suggestionCardRefs.current.get(previousId);
      previousCard?.classList.remove("located");
      previousCard?.removeAttribute("aria-current");
    }
    const card = suggestionCardRefs.current.get(id);
    if (card) {
      card.classList.add("located");
      card.setAttribute("aria-current", "true");
      instantLocatedSuggestionIdRef.current = id;
    }
  }

  function clearInstantLocatedSuggestion(id?: string) {
    const currentId = instantLocatedSuggestionIdRef.current;
    if (!currentId || (id && currentId !== id)) {
      return;
    }
    const card = suggestionCardRefs.current.get(currentId);
    card?.classList.remove("located");
    card?.removeAttribute("aria-current");
    instantLocatedSuggestionIdRef.current = null;
  }

  function rejectSuggestion(suggestion: AiSuggestion) {
    if (relocatedAcceptConfirmRef.current === suggestion.id) {
      relocatedAcceptConfirmRef.current = null;
    }
    updateSuggestionStatus(suggestion.id, "rejected");
    if (autoAdvanceReview) {
      advanceAfterResolution(suggestion.id);
    } else {
      clearLocatedSuggestion();
    }
    setError(null);
    appendMessage("system", `Rejected: ${suggestion.title}. Use Restore on the card to bring it back.`);
  }

  function restoreRejectedSuggestion(suggestion: AiSuggestion) {
    updateSuggestionStatus(suggestion.id, "pending");
    setError(null);
    appendMessage("system", `Restored to pending: ${suggestion.title}.`);
  }

  function revertAcceptedSuggestionText(suggestion: AiSuggestion): boolean {
    if (!editor) {
      return false;
    }
    const traceId = `${suggestion.id}-accepted`;
    const trace = acceptedReviewTracesRef.current.find((candidate) => candidate.id === traceId) ?? null;
    const docSize = editor.state.doc.content.size;
    let range: { from: number; to: number } | null = null;
    if (normalizeText(suggestion.replacement)) {
      if (trace && trace.from < trace.to && trace.to <= docSize) {
        try {
          const current = editor.state.doc.textBetween(trace.from, trace.to, "\n");
          if (normalizeText(current) === normalizeText(suggestion.replacement)) {
            range = { from: trace.from, to: trace.to };
          }
        } catch {
          // Trace positions can go stale after later edits; fall through to text search.
        }
      }
      range = range ?? findTextRange(editor, suggestion.replacement, undefined, trace?.from);
    } else if (trace && trace.from <= docSize) {
      range = { from: trace.from, to: trace.from };
    }
    if (!range) {
      return false;
    }
    suppressUserTrackingRef.current = true;
    editor.chain().focus().insertContentAt(range, replacementToContent(suggestion.original)).run();
    lastEditorTextSnapshotRef.current = editorTextSnapshot(editor).text;
    suppressUserTrackingRef.current = false;
    acceptedReviewTracesRef.current = acceptedReviewTracesRef.current.filter((candidate) => candidate.id !== traceId);
    setEditorTrackedChanges((current) => current.filter((change) => change.id !== `${suggestion.id}-ai-change`));
    return true;
  }

  function undoAcceptedSuggestion(suggestion: AiSuggestion) {
    if (!revertAcceptedSuggestionText(suggestion)) {
      setError(`Could not undo "${suggestion.title}": the replaced text has changed since it was accepted. Edit the document manually if you need the original wording back.`);
      return;
    }
    updateSuggestionStatus(suggestion.id, "pending");
    setDocumentNote(`Restored original: ${suggestion.title}`);
    setError(null);
    appendMessage("system", `Undid accept: ${suggestion.title}. The original text is back and the suggestion is pending again.`);
  }

  function toggleAutoAdvanceReview() {
    setAutoAdvanceReview((current) => {
      const next = !current;
      try {
        window.localStorage.setItem("nebula-writer-auto-advance-review", next ? "1" : "0");
      } catch {
        // Persisting the preference is best-effort.
      }
      return next;
    });
  }

  function advanceAfterResolution(resolvedId: string) {
    const remaining = reviewNavigationSuggestions.filter((suggestion) => suggestion.id !== resolvedId);
    if (!remaining.length) {
      clearLocatedSuggestion();
      return;
    }
    const resolvedIndex = reviewNavigationSuggestions.findIndex((suggestion) => suggestion.id === resolvedId);
    const nextIndex = resolvedIndex >= 0 && resolvedIndex < remaining.length ? resolvedIndex : 0;
    if (!locateSuggestion(remaining[nextIndex], { reportMissing: false, scrollCard: true })) {
      clearLocatedSuggestion();
    }
  }

  // Keyboard review: j/k step through pending suggestions, a/r decide the
  // active one. Disabled while typing anywhere.
  useEffect(() => {
    function onReviewShortcut(event: globalThis.KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=\"true\"]")) {
        return;
      }
      if (!reviewNavigationSuggestions.length) {
        return;
      }
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        navigatePendingSuggestion(event.key === "j" ? 1 : -1);
        return;
      }
      if ((event.key === "a" || event.key === "r") && busy === null) {
        // Only act on a suggestion the user has actually navigated to/located —
        // never decide suggestion #1 sight-unseen.
        const active = activePendingIndex >= 0 ? reviewNavigationSuggestions[activePendingIndex] : null;
        if (active) {
          event.preventDefault();
          if (event.key === "a") {
            // Same path as the card's Accept button: applies the edit, records
            // the tracked change, and verifies the replacement landed.
            acceptSuggestion(active);
          } else {
            rejectSuggestion(active);
          }
        }
      }
    }
    window.addEventListener("keydown", onReviewShortcut);
    return () => window.removeEventListener("keydown", onReviewShortcut);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, activePendingIndex, reviewNavigationSuggestions]);

  function navigatePendingSuggestion(direction: -1 | 1) {
    if (!reviewNavigationSuggestions.length) {
      return;
    }
    const nextIndex = activePendingIndex >= 0
      ? (activePendingIndex + direction + reviewNavigationSuggestions.length) % reviewNavigationSuggestions.length
      : direction > 0
        ? 0
        : reviewNavigationSuggestions.length - 1;
    locateSuggestion(reviewNavigationSuggestions[nextIndex], { reportMissing: true, scrollCard: true });
  }

  function navigateDocumentReviewSuggestion(direction: -1 | 1) {
    if (!documentReviewNavigationSuggestions.length) {
      return;
    }
    const nextIndex = activeDocumentReviewIndex >= 0
      ? (activeDocumentReviewIndex + direction + documentReviewNavigationSuggestions.length) % documentReviewNavigationSuggestions.length
      : direction > 0
        ? 0
        : documentReviewNavigationSuggestions.length - 1;
    locateSuggestion(documentReviewNavigationSuggestions[nextIndex], { reportMissing: true, scrollCard: true });
  }

  function navigateSourceRevision(direction: -1 | 1) {
    if (!sourceRevisionNavigationEntries.length) {
      return;
    }
    const nextEntryIndex = activeSourceRevisionEntryIndex >= 0
      ? (activeSourceRevisionEntryIndex + direction + sourceRevisionNavigationEntries.length) % sourceRevisionNavigationEntries.length
      : direction > 0
        ? 0
        : sourceRevisionNavigationEntries.length - 1;
    focusSourceRevision(sourceRevisionNavigationEntries[nextEntryIndex].index);
  }

  function focusSourceRevision(index: number): boolean {
    const change = sourceTrackedChanges[index];
    if (!change) {
      return false;
    }
    setShowSourceRevisionsInDocument(true);
    setActiveSourceRevisionIndex(index);
    const revisionLabel = `${sourceTrackedChangeKindLabel(change.kind)} ${index + 1}/${sourceTrackedChanges.length}`;
    if (!editor || !sourceRevisionCanFocusAcceptedText(change)) {
      if (editor) {
        clearReviewHighlight(editor);
      }
      setDocumentNote(`${revisionLabel}: preview only`);
      return false;
    }
    const range = findTextRange(editor, change.text);
    if (!range) {
      clearReviewHighlight(editor);
      setDocumentNote(`${revisionLabel}: not visible in accepted text`);
      return false;
    }
    editor.chain().focus().setTextSelection(range).run();
    setReviewHighlight(editor, range);
    centerEditorRange(editor, range);
    setDocumentNote(`${revisionLabel}: focused in text`);
    setError(null);
    return true;
  }

  function handleReviewSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (reviewSearchQuery) {
        event.preventDefault();
        setReviewSearchQuery("");
      }
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    if (!reviewNavigationSuggestions.length) {
      return;
    }
    event.preventDefault();
    const targetIndex = activePendingIndex >= 0 ? activePendingIndex : 0;
    locateSuggestion(reviewNavigationSuggestions[targetIndex], { reportMissing: true, scrollCard: true });
  }

  function handleSourceRevisionSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (sourceRevisionSearchQuery) {
        event.preventDefault();
        setSourceRevisionSearchQuery("");
      }
      return;
    }
    if (event.key !== "Enter" || !sourceRevisionNavigationEntries.length) {
      return;
    }
    event.preventDefault();
    const targetEntryIndex = activeSourceRevisionEntryIndex >= 0 ? activeSourceRevisionEntryIndex : 0;
    focusSourceRevision(sourceRevisionNavigationEntries[targetEntryIndex].index);
  }

  function handleEditorTraceDomClick(event: globalThis.MouseEvent): boolean {
    if (!editor || !pendingSuggestionsRef.current.length) {
      return false;
    }
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return false;
    }
    const target = event.target;
    if (!(target instanceof Node) || !editor.view.dom.contains(target)) {
      return false;
    }
    const clickedTraceSuggestion = suggestionForReviewTraceTarget(target, pendingSuggestionsRef.current);
    if (!clickedTraceSuggestion) {
      return false;
    }
    const selectionContainer = editor.view.dom.closest<HTMLElement>(".editor-content-shell") ?? editor.view.dom;
    const pointerDown = reviewNavigationPointerDownRef.current;
    const isSimpleTraceClick = Boolean(
      pointerDown
      && pointerDown.container.contains(target)
      && Math.abs(event.clientX - pointerDown.x) <= 4
      && Math.abs(event.clientY - pointerDown.y) <= 4
    );
    if (!isSimpleTraceClick && hasTextSelectionInside(selectionContainer)) {
      return false;
    }
    event.preventDefault();
    setReviewFilter("pending");
    locateSuggestion(clickedTraceSuggestion, { reportMissing: false, scrollCard: true });
    return true;
  }

  function handleEditorContentClick(event: MouseEvent<HTMLDivElement>) {
    if (!editor || !pendingSuggestions.length) {
      return;
    }
    if (shouldIgnoreReviewNavigationClick(event, reviewNavigationPointerDownRef)) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node) || !editor.view.dom.contains(target)) {
      return;
    }
    const clickedTraceSuggestion = suggestionForReviewTraceTarget(target, pendingSuggestions);
    if (clickedTraceSuggestion) {
      setReviewFilter("pending");
      locateSuggestion(clickedTraceSuggestion, { reportMissing: false, scrollCard: true });
      return;
    }
    const position = editor.view.posAtCoords({
      left: event.clientX,
      top: event.clientY
    });
    if (!position) {
      return;
    }
    const activeSuggestion = activeSuggestionId
      ? pendingSuggestions.find((suggestion) => suggestion.id === activeSuggestionId)
      : null;
    const activeSuggestionRange = activeSuggestion ? findSuggestionRange(editor, activeSuggestion) : null;
    const clickedSuggestion = activeSuggestion && activeSuggestionRange && position.pos >= activeSuggestionRange.from && position.pos <= activeSuggestionRange.to
      ? activeSuggestion
      : suggestionForClickedBlockText(editorTextBlockAtPosition(editor, position.pos), pendingSuggestions);
    if (!clickedSuggestion) {
      return;
    }
    setReviewFilter("pending");
    locateSuggestion(clickedSuggestion, { reportMissing: false, scrollCard: true });
  }

  function clearLocatedSuggestion(id?: string) {
    if (id && activeSuggestionId !== id && instantLocatedSuggestionIdRef.current !== id) {
      return;
    }
    if (activeSuggestionUpdateFrameRef.current !== null) {
      window.cancelAnimationFrame(activeSuggestionUpdateFrameRef.current);
      activeSuggestionUpdateFrameRef.current = null;
    }
    clearInstantLocatedSuggestion(id);
    pendingSuggestionCardScrollRef.current = null;
    setActiveSuggestionId(null);
    if (editor) {
      clearReviewHighlight(editor);
    }
  }

  function addSuggestionDecisionNote(suggestion: AiSuggestion) {
    if (typeof window === "undefined" || typeof window.prompt !== "function") {
      return;
    }
    const note = window.prompt(
      "Note on this decision (collaborators and the agent's next round will see it):",
      suggestion.decisionNote ?? ""
    );
    if (note === null) {
      return;
    }
    const trimmed = note.trim().slice(0, 280);
    setSuggestions((current) => current.map((candidate) => candidate.id === suggestion.id
      ? { ...candidate, decisionNote: trimmed || null }
      : candidate));
    void setWriterSuggestionStatus(suggestion.id, suggestion.status, {
      ...sharedSessionWriteContext(),
      expectedStatus: suggestion.status,
      decidedBy: suggestion.decidedBy ?? collabSession.user.name,
      decisionNote: trimmed
    }).catch(() => undefined);
  }

  function updateSuggestionStatus(id: string, status: AiSuggestion["status"]) {
    const priorStatus = suggestions.find((suggestion) => suggestion.id === id)?.status;
    const decidedBy = status === "pending" ? null : collabSession.user.name;
    const decidedAt = status === "pending" ? null : new Date().toISOString();
    setLastExportReport(null);
    setLastExportContext(null);
    setManualMissingTargetSuggestionIds((current) => current.filter((suggestionId) => suggestionId !== id));
    setSuggestions((current) => current.map((suggestion) => suggestion.id === id ? { ...suggestion, status, decidedBy, decidedAt } : suggestion));
    setSharedSession((current) => {
      if (!current) {
        return current;
      }
      const suggestions = current.suggestions.map((suggestion) => suggestion.id === id ? { ...suggestion, status, decidedBy, decidedAt } : suggestion);
      return {
        ...current,
        suggestions,
        pendingSuggestions: countPendingSuggestions(suggestions)
      };
    });
    void syncSuggestionStatusToSharedSession(id, status, priorStatus);
  }

  function sharedSessionWriteContext(): { docId?: string; expectedSessionId?: string } {
    const base = docId ? { docId } : {};
    return sharedSession && sharedSession.sourceDocumentId === sourceDocumentId
      ? { ...base, expectedSessionId: sharedSession.id }
      : base;
  }

  async function syncSuggestionStatusToSharedSession(id: string, status: AiSuggestion["status"], expectedStatus?: AiSuggestion["status"]) {
    try {
      await setWriterSuggestionStatus(id, status, {
        ...sharedSessionWriteContext(),
        expectedStatus,
        decidedBy: collabSession.user.name
      });
      if (failedStatusSyncsRef.current.delete(id)) {
        setSuggestionSyncFailureCount(failedStatusSyncsRef.current.size);
      }
    } catch (error) {
      if (error instanceof SidecarHttpError && error.status === 404) {
        // This suggestion only exists in this browser (not in the shared
        // session) — there is nothing to sync and nothing to retry.
        if (failedStatusSyncsRef.current.delete(id)) {
          setSuggestionSyncFailureCount(failedStatusSyncsRef.current.size);
        }
        return;
      }
      if (error instanceof SidecarHttpError && error.status === 409) {
        handleSuggestionStatusConflict(id, status, error);
        return;
      }
      failedStatusSyncsRef.current.set(id, status);
      setSuggestionSyncFailureCount(failedStatusSyncsRef.current.size);
    }
  }

  function handleSuggestionStatusConflict(id: string, attemptedStatus: AiSuggestion["status"], error: SidecarHttpError) {
    const conflict = (error.body as { conflict?: SuggestionStatusConflict } | null)?.conflict ?? null;
    const suggestion = suggestions.find((candidate) => candidate.id === id) ?? null;
    if (!conflict) {
      setError(error.message);
      return;
    }
    // Someone else decided this suggestion first. Adopt their decision instead
    // of clobbering it — and if our optimistic accept already edited the shared
    // document, roll that edit back so text and decision stay consistent.
    const rolledBack = attemptedStatus === "accepted" && conflict.status !== "accepted" && suggestion
      ? revertAcceptedSuggestionText(suggestion)
      : false;
    setSuggestions((current) => current.map((candidate) => candidate.id === id
      ? { ...candidate, status: conflict.status, decidedBy: conflict.decidedBy, decidedAt: conflict.decidedAt }
      : candidate));
    const who = conflict.decidedBy || "Another collaborator";
    const title = suggestion ? `"${suggestion.title}"` : "this suggestion";
    const attemptedNoun = attemptedStatus === "accepted" ? "acceptance" : attemptedStatus === "rejected" ? "rejection" : "restore";
    setError(`${who} marked ${title} ${conflict.status} at the same time as you${rolledBack ? "; your applied edit was rolled back to stay in sync" : ""}. Find it in the All filter if you want to change the decision.`);
    appendMessage("system", `Conflict: ${who} already marked ${title} ${conflict.status}, so your ${attemptedNoun} did not apply.`);
  }

  async function retryFailedSuggestionSyncs() {
    if (suggestionSyncRetrying || !failedStatusSyncsRef.current.size) {
      return;
    }
    setSuggestionSyncRetrying(true);
    try {
      const entries = [...failedStatusSyncsRef.current.entries()];
      for (const [id, status] of entries) {
        await syncSuggestionStatusToSharedSession(id, status);
      }
      if (!failedStatusSyncsRef.current.size) {
        setDocumentNote("Shared session is back in sync");
      }
    } finally {
      setSuggestionSyncRetrying(false);
    }
  }

  function appendMessage(role: ChatMessage["role"], content: string, author?: string | null) {
    setMessages((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role,
        content,
        // Attribute human messages so collaborators can tell whose they are;
        // assistant messages carry the provider's name.
        author: author !== undefined ? author : role === "user" ? collabSession.user.name : null,
        createdAt: new Date().toISOString()
      }
    ]);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && busy === "Asking AI") {
      event.preventDefault();
      handleInterruptAi();
      return;
    }

    const isSendShortcut = event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey);
    if (!isSendShortcut || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (canSendInstruction) {
      void handleSend();
    }
  }

  const selectedProviderStatus = healthForAi?.providerStatus?.find((status) => status.name === provider);
  const cliUnavailable = healthForAi !== null && (!healthForAi.cliEnabled || selectedProviderStatus?.available === false);
  // On the cloud origin with no runner, the worker reports every provider as
  // unavailable — but the truthful state is "no AI runner connected", not
  // "CLI not found".
  const cloudAiOffline = aiSetupReason === "cloud-offline";
  const providerState = cloudAiOffline
    ? "AI offline — no local Writer connected"
    : selectedProviderStatus?.available === false
      ? `${providerLabel(provider)} CLI not found`
      : healthForAi?.cliEnabled
        ? `${providerLabel(provider)} CLI ready${localAiActive ? " — your local Writer" : ""}`
        : `${providerLabel(provider)} CLI locked by config`;
  const providerDetail = selectedProviderStatus
    ? formatProviderDetail(selectedProviderStatus, healthForAi?.cliTimeout?.detail)
    : "";
  const aiRequestBlocked = cliUnavailable || aiSetupReason === "sidecar-down";
  const isAskingAi = busy === "Asking AI";
  const maxSuggestions = parseMaxSuggestionsInput(maxSuggestionsInput);
  const maxSuggestionsInvalid = maxSuggestionsInput.trim() !== "" && maxSuggestions === null;
  const aiInstructionPlaceholder = aiRequestBlocked
    ? cloudMode
      ? "AI is offline in this tab — click 'Set up AI' above the scope toggle."
      : aiSetupReason === "sidecar-down"
        ? "The Writer sidecar isn't running — click 'Set up AI' above the scope toggle."
        : selectedProviderStatus?.available === false
          ? `${providerLabel(provider)} CLI was not found on PATH — click 'Set up AI' above the scope toggle.`
          : "Local AI is locked for this sidecar. Restart without WRITER_ALLOW_CLI=0."
    : scope === "selection"
      ? "Ask for a change to the selected text..."
      : "Ask for a document-level revision...";
  const canSendInstruction = Boolean(instruction.trim()) && busy === null && !aiRequestBlocked && !maxSuggestionsInvalid;
  // The from-scratch "stand up a local Writer" sequence, shared by the cloud
  // guide and the hosted-but-unreachable guide — neither can assume the repo
  // is already on the viewer's machine.
  const localWriterSetupSteps = (
    <ol className="setup-steps">
      <li>
        <span>Clone the Writer (ask for access to the private repo if needed):</span>
        <SetupCommand command="git clone https://github.com/jzthree/nebula-writer.git" onCopied={setDocumentNote} />
      </li>
      <li>
        <span>Install its dependencies:</span>
        <SetupCommand command="cd nebula-writer && npm ci" onCopied={setDocumentNote} />
      </li>
      <li>
        <span>Make sure the <code>codex</code> or <code>claude</code> CLI is installed and logged in (your own account is used).</span>
      </li>
      <li>
        <span>Start the Writer sidecar, allowing this site to use it:</span>
        <SetupCommand command={`WRITER_ALLOWED_ORIGINS=${window.location.origin} npm run sidecar`} onCopied={setDocumentNote} />
      </li>
    </ol>
  );
  const emptyAiTimedOut = Boolean(emptyAiResult && isProviderTimeoutMessage(emptyAiResult.message));
  const emptyAiRecoveryMessage = emptyAiResult ? emptyAiResultMessage(emptyAiResult) : "";
  const timeoutAlternateProvider = emptyAiTimedOut && emptyAiResult
    ? availableAlternateProvider(emptyAiResult.provider, healthForAi)
    : null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <PenLine size={20} aria-hidden="true" />
          </div>
          <div>
            <p className="eyebrow">DOCX AI writing desk</p>
            <input
              className="title-input"
              value={documentTitle}
              onChange={(event) => setDocumentTitle(event.target.value)}
              aria-label="Document title"
            />
          </div>
        </div>

        <div className="toolbar" aria-label="Document tools">
          <div className="edit-mode-toggle" role="radiogroup" aria-label="Edit mode" title="Editing applies your changes directly. Suggesting marks them as tracked suggestions for review.">
            <button
              type="button"
              role="radio"
              aria-checked={editMode === "editing"}
              className={editMode === "editing" ? "active" : ""}
              onClick={() => setEditMode("editing")}
            >
              <PenLine size={14} aria-hidden="true" /> Editing
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={editMode === "suggesting"}
              className={editMode === "suggesting" ? "active" : ""}
              onClick={() => setEditMode("suggesting")}
            >
              <FilePenLine size={14} aria-hidden="true" /> Suggesting
            </button>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              // Fresh draft: boot the no-doc path, which mints a new document.
              // The current document stays in room persistence and Recents.
              window.location.href = window.location.pathname;
            }}
            title="New document"
            aria-label="New document"
          >
            <FilePlus2 size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => fileInputRef.current?.click()}
            title={cloudMode ? "Import DOCX (converted by your local Writer)" : "Import DOCX"}
          >
            <Upload size={18} aria-hidden="true" />
          </button>
          {collaborators.length ? (
            <span className="presence-avatars" aria-label={`Editing with ${collaborators.map((peer) => peer.name).join(", ")}`}>
              {collaborators.slice(0, 4).map((peer) => (
                <i key={peer.name + peer.color} style={{ background: peer.color }} title={peer.name}>
                  {peer.name.trim().slice(0, 1).toUpperCase() || "?"}
                </i>
              ))}
              {collaborators.length > 4 ? <em>+{collaborators.length - 4}</em> : null}
            </span>
          ) : null}
          <div className="share-control" ref={shareMenuRef}>
            <button
              type="button"
              className={`icon-button share-button ${collaborators.length ? "has-peers" : ""}`}
              onClick={() => void handleToggleShareMenu()}
              title={collaborators.length
                ? `Editing live with ${collaborators.map((peer) => peer.name).join(", ")}`
                : "Share this document for live co-editing"}
              aria-label="Share for live co-editing"
              aria-haspopup="dialog"
              aria-expanded={shareMenuOpen}
            >
              <Users size={18} aria-hidden="true" />
              {collaborators.length ? (
                <span className="share-peer-count">{collaborators.length + 1}</span>
              ) : ownTabCount > 1 ? (
                <span className="share-peer-count own-tabs" title={`You are connected in  tabs`}>{ownTabCount}</span>
              ) : null}
            </button>
            {shareMenuOpen ? (
              <div className="share-menu export-options-menu" role="dialog" aria-label="Live collaboration">
                <div className="share-menu-section">
                  <strong>Live collaboration</strong>
                  {collaborators.length ? (
                    <ul className="share-peer-list">
                      {collaborators.map((peer, index) => (
                        <li key={`${peer.name}-${index}`}>
                          <span className="share-peer-dot" style={{ background: peer.color }} aria-hidden="true" />
                          {peer.name}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <small>No one else is connected yet.</small>
                  )}
                  {ownTabCount > 1 ? (
                    <small>You are connected in {ownTabCount} tabs on this machine (each shows its own cursor; they all count as you).</small>
                  ) : null}
                </div>
                <div className="share-menu-section">
                  <label className="share-name-label">
                    Your name on shared cursors
                    <span className="share-name-row">
                      <input
                        type="text"
                        value={collabNameDraft}
                        onChange={(event) => setCollabNameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleApplyCollabName();
                          }
                        }}
                        aria-label="Collaboration display name"
                        autoFocus={/^Writer \d+$/.test(collabSession.user.name)}
                      />
                      <button type="button" onClick={handleApplyCollabName}>Set</button>
                    </span>
                  </label>
                  {/^Writer \d+$/.test(collabSession.user.name) ? (
                    <small>You're using an auto-generated name — set a real one so collaborators recognize your cursor and decisions.</small>
                  ) : null}
                </div>
                <div className="share-menu-section">
                  {!docId ? (
                    <>
                      <small>This is a private draft — it has no share link yet. Start sharing to give it one:</small>
                      <button
                        type="button"
                        className="share-start-button"
                        onClick={() => void handleStartSharedDocument()}
                        disabled={busy !== null}
                      >
                        <Users size={14} aria-hidden="true" /> Start sharing this draft
                      </button>
                    </>
                  ) : localMode && cloudSynced ? (
                    <>
                      <small>Synced with collaborators through the cloud relay. Send this link — it opens in each collaborator's own local Writer:</small>
                      <span className="share-url-row">
                        <code>{collaboratorShareUrl(docId)}</code>
                        <button type="button" onClick={() => handleCopyShareUrl(collaboratorShareUrl(docId))}>
                          <Copy size={13} aria-hidden="true" /> {shareUrlCopied ? "Copied" : "Copy"}
                        </button>
                      </span>
                      <small className="share-warning">Anyone with this document id can join it through the relay. Their edits use their own AI, never yours.</small>
                    </>
                  ) : localMode ? (
                    <>
                      <small>This document is local to this machine. Sync it through the cloud relay so collaborators' own local Writers can join:</small>
                      <button
                        type="button"
                        className="share-start-button"
                        onClick={() => {
                          setCloudSynced(true);
                          if (docId) {
                            void ensureCollabBridge(docId).catch(() => undefined);
                          }
                        }}
                        disabled={busy !== null}
                      >
                        <Users size={14} aria-hidden="true" /> Sync with collaborators
                      </button>
                    </>
                  ) : shareInfo?.sharable && shareInfo.shareUrls.length ? (
                    <>
                      <small>Send a collaborator this document link (same network or VPN):</small>
                      {shareInfo.shareUrls.map((url) => {
                        const documentUrl = documentShareUrl(url, docId);
                        return (
                          <span className="share-url-row" key={url}>
                            <code>{documentUrl}</code>
                            <button type="button" onClick={() => handleCopyShareUrl(documentUrl)}>
                              <Copy size={13} aria-hidden="true" /> {shareUrlCopied ? "Copied" : "Copy"}
                            </button>
                          </span>
                        );
                      })}
                      <small className="share-warning">Anyone with this link on your network can edit this document.</small>
                    </>
                  ) : (
                    <>
                      <small>This document's link (works in any tab or window on this machine):</small>
                      <span className="share-url-row">
                        <code>{documentShareUrl(`${window.location.origin}/`, docId)}</code>
                        <button type="button" onClick={() => handleCopyShareUrl(documentShareUrl(`${window.location.origin}/`, docId))}>
                          <Copy size={13} aria-hidden="true" /> {shareUrlCopied ? "Copied" : "Copy"}
                        </button>
                      </span>
                      <small>
                        To invite someone on another machine, restart with <code>npm run dev:share</code> — this menu will then show a network link with an access token.
                      </small>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>
          {cloudMode ? null : (<>
          <div className="export-control" ref={exportMenuRef}>
            <button
              type="button"
              className="export-primary-button"
              onClick={() => void handleDefaultExport()}
              disabled={!editor || busy !== null}
              title={defaultExportTitle}
              aria-label="Export"
            >
              <Download size={17} aria-hidden="true" />
              <span>Export</span>
            </button>
            <button
              type="button"
              className="export-menu-button"
              onClick={() => setExportMenuOpen((open) => !open)}
              disabled={busy !== null}
              title="Export options"
              aria-label="Export options"
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
            >
              <ChevronDown size={15} aria-hidden="true" />
            </button>
            {exportMenuOpen ? (
              <div
                className="export-options-menu"
                role="menu"
                aria-label="Export options"
                onKeyDown={handleMenuKeyDown(() => setExportMenuOpen(false), exportMenuRef)}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runExportMenuAction(() => void handleExportCumulativeReview())}
                  disabled={!canExportCumulativeReview}
                  title={cumulativeReviewExportTitle}
                  aria-label="Export cumulative review DOCX"
                >
                  <FilePenLine size={15} aria-hidden="true" />
                  <span>
                    <strong>Cumulative review</strong>
                    <small>{pendingSuggestions.length ? `All ${pendingSuggestions.length} pending (ignores filter)` : "All pending edits"}</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runExportMenuAction(() => void handleExport(true))}
                  disabled={!editor || (!sourceDocumentId && !hasReviewExportCandidates)}
                  title={sourceDocumentId ? "Uses the imported DOCX as the carrier" : "Creates a review DOCX from the editor text"}
                  aria-label="Export review DOCX"
                >
                  <FilePenLine size={15} aria-hidden="true" />
                  <span>
                    <strong>Review DOCX</strong>
                    <small>{sourceDocumentId ? "Preserves original" : "Tracked changes"}</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runExportMenuAction(() => void handleExport(false))}
                  disabled={!editor}
                  title="Rebuilds a DOCX from browser HTML and may lose Word-only formatting"
                  aria-label="Export rebuilt DOCX"
                >
                  <Download size={15} aria-hidden="true" />
                  <span>
                    <strong>Rebuilt DOCX</strong>
                    <small>Plain layout</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => runExportMenuAction(() => void handleExportSessionState())}
                  disabled={!sharedSession || sharedSession.sourceDocumentId !== sourceDocumentId}
                  title="Export a small JSON snapshot for restoring this Writer session"
                  aria-label="Export session snapshot"
                >
                  <FileText size={15} aria-hidden="true" />
                  <span>
                    <strong>Session JSON</strong>
                    <small>Suggestions, chat &amp; routine history</small>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => sessionInputRef.current?.click()}
            disabled={busy !== null}
            title="Load a Writer session JSON file"
            aria-label="Load session JSON file"
          >
            <RefreshCw size={18} aria-hidden="true" />
          </button>
          <div className="session-control" ref={autosaveMenuRef}>
            <button
              type="button"
              className="icon-button"
              onClick={() => void handleToggleAutosaveMenu()}
              disabled={busy !== null}
              title="Choose from autosaved Writer sessions"
              aria-label="Recent autosaved sessions"
              aria-haspopup="menu"
              aria-expanded={autosaveMenuOpen}
            >
              {autosaveSessionsLoading ? <Loader2 size={18} aria-hidden="true" /> : <History size={18} aria-hidden="true" />}
            </button>
            {autosaveMenuOpen ? (
              <div
                className="session-options-menu export-options-menu"
                role="menu"
                aria-label="Recent autosaved sessions"
                onKeyDown={handleMenuKeyDown(() => setAutosaveMenuOpen(false), autosaveMenuRef)}
              >
                {autosavedSessions.length ? autosavedSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    role="menuitem"
                    onClick={() => void handleLoadAutosavedSession(session.id)}
                    disabled={busy !== null || !session.sourceDocumentAvailable}
                    title={session.sourceDocumentAvailable
                      ? `Restore ${session.title || session.name} from ${formatAutosavedSessionTimestamp(session.exportedAt)}`
                      : "The source DOCX for this autosave is no longer available at its saved path"}
                    aria-label={`Load autosaved session: ${session.title || session.name}`}
                  >
                    <FileText size={15} aria-hidden="true" />
                    <span>
                      <strong>{truncate(session.title || session.name, 44)}</strong>
                      <small>{formatAutosavedSessionTimestamp(session.exportedAt)} · {labelCount(session.pendingSuggestions, "pending suggestion") ?? "0 pending suggestions"} · {labelCount(session.chatMessageCount, "chat message") ?? "0 chat messages"}</small>
                    </span>
                  </button>
                )) : (
                  <button type="button" role="menuitem" disabled>
                    <FileText size={15} aria-hidden="true" />
                    <span>
                      <strong>No autosaved sessions</strong>
                      <small>Open or revise a DOCX to create one</small>
                    </span>
                  </button>
                )}
              </div>
            ) : null}
          </div>
          </>)}
          {cloudMode ? (
            <button
              type="button"
              className="export-primary-button"
              onClick={() => void handleExport(false)}
              disabled={!editor || busy !== null}
              title="Download as DOCX (rebuilt from the editor by your local Writer; review exports with tracked changes run on the local Writer directly)"
              aria-label="Export"
            >
              <Download size={17} aria-hidden="true" />
              <span>Export</span>
            </button>
          ) : null}
          <div className="provider-select" title={AI_TOOL_ACCESS_LEVELS.find((level) => level.id === toolAccess)?.detail ?? ""}>
            <Wrench size={17} aria-hidden="true" />
            <select value={toolAccess} onChange={(event) => setToolAccess(event.target.value as AiToolAccess)} aria-label="Tools the AI may use">
              {AI_TOOL_ACCESS_LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}
            </select>
          </div>
          <div className="provider-select" title={`${providerState}${providerDetail ? ` — ${providerDetail}` : ""}`}>
            <Bot size={17} aria-hidden="true" />
            <select value={provider} onChange={(event) => setProvider(event.target.value as InteractiveProviderName)} aria-label="AI provider">
              {([["codex", "Codex CLI"], ["claude", "Claude Code"]] as const).map(([name, label]) => {
                const status = healthForAi?.providerStatus?.find((candidate) => candidate.name === name);
                // Granular per-provider readiness: each option says whether THAT
                // CLI is ready or missing, independent of the other, so "Codex
                // ready, Claude missing" (or vice versa) reads at a glance.
                const known = Boolean(status);
                const ready = status?.available === true && (healthForAi?.cliEnabled ?? false);
                const suffix = !known ? "" : ready ? " ✓ ready" : " — not found";
                return (
                  <option key={name} value={name} disabled={known && !ready && provider !== name}>
                    {label}{suffix}
                  </option>
                );
              })}
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </div>
          {cloudMode ? null : (
            <button
              type="button"
              className="icon-button"
              onClick={() => void handleProviderSmokeTest()}
              disabled={busy !== null}
              title={`Smoke test ${providerLabel(provider)} CLI`}
              aria-label={`Smoke test ${providerLabel(provider)} CLI`}
            >
              {busy === "Testing AI provider" ? <Loader2 size={18} aria-hidden="true" /> : <Activity size={18} aria-hidden="true" />}
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) {
                void handleImport(file);
              }
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={sessionInputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) {
                void handleImportSessionState(file);
              }
              event.currentTarget.value = "";
            }}
          />
        </div>
      </header>

      {!docId && recentDocs.length ? (
        <div className="recent-docs-bar">
          <span>Recent documents:</span>
          {recentDocs.map((doc) => (
            <button
              key={doc.id}
              type="button"
              onClick={() => adoptDocId(doc.id)}
              title={`Rejoin ${doc.name}`}
            >
              <FileText size={13} aria-hidden="true" /> {truncate(doc.name, 30)}
            </button>
          ))}
        </div>
      ) : null}

      {importFidelityNotices.length ? (
        <aside className="import-fidelity-banner" role="note" aria-label="Import conversion notes">
          <div className="import-fidelity-header">
            <AlertTriangle size={15} aria-hidden="true" />
            <strong>Import notes ({importFidelityNotices.length})</strong>
            <button
              type="button"
              onClick={() => setImportFidelityNotices([])}
              aria-label="Dismiss import conversion notes"
            >
              Dismiss
            </button>
          </div>
          <ul>
            {importFidelityNotices.map((notice, index) => (
              <li key={index} className={notice.level === "warning" ? "notice-warning" : "notice-info"}>{notice.text}</li>
            ))}
          </ul>
        </aside>
      ) : null}


      <div className="workspace">
        <section
          className={`editor-pane ${showSourceRevisionsInDocument && sourceTrackedChanges.length ? "with-source-revisions" : ""}${cleanView ? " clean-view" : ""}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = [...event.dataTransfer.files].find((candidate) => candidate.name.endsWith(".docx"));
            if (file) {
              void handleImport(file);
            }
          }}
        >
          <div className="format-bar" aria-label="Formatting">
            {/* preventDefault on mousedown keeps focus in the editor: without it
                the button's mousedown blurs the doc and the first keystroke
                typed right after clicking a heading/format button is dropped
                ("My Novel" → "y Novel"). */}
            <button type="button" className="tool-button" onMouseDown={preventEditorBlur} onClick={() => editor?.chain().focus().toggleBold().run()} aria-pressed={editor?.isActive("bold") ?? false}>B</button>
            <button type="button" className="tool-button italic" onMouseDown={preventEditorBlur} onClick={() => editor?.chain().focus().toggleItalic().run()} aria-pressed={editor?.isActive("italic") ?? false}>I</button>
            <button type="button" className="text-button" onMouseDown={preventEditorBlur} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>H1</button>
            <button type="button" className="text-button" onMouseDown={preventEditorBlur} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
            <button type="button" className="icon-button small" onMouseDown={preventEditorBlur} onClick={() => editor?.chain().focus().toggleBulletList().run()} title="Bullet list">
              <List size={16} aria-hidden="true" />
            </button>
            <button type="button" className="icon-button small" onMouseDown={preventEditorBlur} onClick={() => editor?.chain().focus().undo().run()} title="Undo">
              <Undo2 size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`track-toggle clean-view-toggle ${cleanView ? "active" : ""}`}
              onClick={() => setCleanView((current) => !current)}
              aria-pressed={cleanView}
              title={cleanView
                ? "Showing the document as if every suggestion were accepted (read-only). Click to show markup again."
                : "Preview the document with all suggestions applied — insertions plain, deletions hidden (read-only)"}
            >
              {cleanView ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />} {cleanView ? "Marked" : "Clean"}
            </button>
          </div>
          <div className={`tracked-change-strip ${editorTrackedChanges.length || suggestionMarkCount ? "" : "empty"}`} aria-label="Browser tracked changes">
            <div className="tracked-change-strip-heading">
              <span><FilePenLine size={14} aria-hidden="true" /> Changes</span>
              <span className="tracked-legend user">User</span>
              <span className="tracked-legend ai">AI</span>
              <strong>{editorTrackedChanges.length + suggestionMarkCount}</strong>
            </div>
            {latestTrackedChanges.length ? (
              <div className="tracked-change-list">
                {latestTrackedChanges.map((change) => (
                  <span
                    key={change.id}
                    className={`tracked-change-chip ${change.source} ${change.kind}`}
                    title={`${editorTrackedChangeSourceLabel(change.source)} ${change.kind}: ${editorTrackedChangeSnippet(change)}`}
                  >
                    <em>{editorTrackedChangeSourceLabel(change.source)}</em>
                    {editorTrackedChangeKindLabel(change.kind)}
                    <small>{truncate(editorTrackedChangeSnippet(change), 58)}</small>
                  </span>
                ))}
              </div>
            ) : suggestionMarkCount ? (
              // Suggesting-mode edits are tracked as inline marks, not diff-log
              // chips — say so instead of claiming there are no marked edits.
              <span className="tracked-change-empty">
                {suggestionMarkCount === 1 ? "1 inline suggestion" : `${suggestionMarkCount} inline suggestions`} marked in the document
              </span>
            ) : (
              <span className="tracked-change-empty">No marked edits yet</span>
            )}
            {editorTrackedChanges.length ? (
              <button
                type="button"
                className="tracked-clear-button"
                onClick={clearEditorTrackedChanges}
                title="Clear browser edit markers without changing document text"
                aria-label="Clear browser tracked-change markers"
              >
                <X size={13} aria-hidden="true" /> Clear
              </button>
            ) : null}
          </div>
          <div
            className="editor-content-shell"
            onMouseDown={recordReviewNavigationPointerDown(reviewNavigationPointerDownRef)}
            onClick={handleEditorContentClick}
          >
            {suggestions.length || sourceTrackedChanges.length ? (
              <div className="document-review-control-stack">
                <div className="document-review-navigator" aria-label="Document review navigator">
                  <div className="document-review-nav-controls">
                    {suggestions.length || reviewSearchQuery ? (
                      <>
                        <span className="document-review-nav-label">
                          <PanelRight size={14} aria-hidden="true" /> Proposed changes
                        </span>
                        <div className="review-nav" aria-label="Document proposed change navigation">
                          <button
                            type="button"
                            className="icon-button small"
                            onClick={() => navigateDocumentReviewSuggestion(-1)}
                            disabled={busy !== null || documentReviewNavigationSuggestions.length <= 1}
                            title="Previous proposed change"
                            aria-label="Previous proposed change"
                          >
                            <ChevronUp size={15} aria-hidden="true" />
                          </button>
                          <span
                            className="review-position"
                            aria-label={`Active proposed change ${documentReviewNavigationIndex} of ${documentReviewNavigationSuggestions.length}`}
                          >
                            {documentReviewNavigationSuggestions.length
                              ? `Change ${documentReviewNavigationIndex} / ${documentReviewNavigationSuggestions.length}`
                              : "0 reviewable"}
                          </span>
                          <button
                            type="button"
                            className="icon-button small"
                            onClick={() => navigateDocumentReviewSuggestion(1)}
                            disabled={busy !== null || documentReviewNavigationSuggestions.length <= 1}
                            title="Next proposed change"
                            aria-label="Next proposed change"
                          >
                            <ChevronDown size={15} aria-hidden="true" />
                          </button>
                        </div>
                        {documentReviewSkippedMissingTargetCount > 0 && reviewFilter !== "source-moved" ? (
                          <button
                            type="button"
                            className="document-review-nav-hint"
                            onClick={() => setReviewFilter("source-moved")}
                            title={`Skipping ${labelCount(documentReviewSkippedMissingTargetCount, "missing-target edit")} in document navigation. Open Missing target to refresh or dismiss them.`}
                            aria-label={`Open Missing target for ${labelCount(documentReviewSkippedMissingTargetCount, "skipped edit")}`}
                          >
                            {documentReviewSkippedMissingTargetCount} skipped
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    {sourceTrackedChanges.length ? (
                      <button
                        type="button"
                        className={`document-source-revision-toggle ${showSourceRevisionsInDocument ? "active" : ""}`}
                        onClick={() => setShowSourceRevisionsInDocument((showing) => !showing)}
                        aria-pressed={showSourceRevisionsInDocument}
                        title="Show source Word revisions in the document pane"
                        aria-label={showSourceRevisionsInDocument ? "Hide source revisions in document pane" : "Show source revisions in document pane"}
                      >
                        <FilePenLine size={14} aria-hidden="true" /> Source revisions
                        <span>{sourceTrackedChanges.length}</span>
                      </button>
                    ) : null}
                  </div>
                </div>
                {showSourceRevisionsInDocument && sourceTrackedChanges.length ? (
                  <div className="document-source-revision-panel" role="region" aria-label="Source revisions in document pane">
                    <div className="document-source-revision-heading">
                      <span>
                        <strong>Source revisions from Word</strong>
                        <small>Shown as accepted in the editor; original Word revision markup is preserved for review export.</small>
                      </span>
                      <div className="review-nav" aria-label="Source revision navigation">
                        <button
                          type="button"
                          className="icon-button small"
                          onClick={() => navigateSourceRevision(-1)}
                          disabled={busy !== null || sourceRevisionNavigationEntries.length <= 1}
                          title="Previous source revision"
                          aria-label="Previous source revision"
                        >
                          <ChevronUp size={15} aria-hidden="true" />
                        </button>
                        <span
                          className="review-position"
                          aria-label={`Active source revision ${sourceRevisionNavigationIndex} of ${sourceRevisionNavigationEntries.length}`}
                        >
                          Revision {sourceRevisionNavigationIndex} / {sourceRevisionNavigationEntries.length}
                        </span>
                        <button
                          type="button"
                          className="icon-button small"
                          onClick={() => navigateSourceRevision(1)}
                          disabled={busy !== null || sourceRevisionNavigationEntries.length <= 1}
                          title="Next source revision"
                          aria-label="Next source revision"
                        >
                          <ChevronDown size={15} aria-hidden="true" />
                        </button>
                      </div>
                      <button
                        type="button"
                        className="icon-button small"
                        onClick={() => setShowSourceRevisionsInDocument(false)}
                        title="Hide source revisions"
                        aria-label="Hide source revisions"
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                    <div className="document-source-revision-search-row">
                      <label className="document-review-search document-source-revision-search">
                        <Search size={14} aria-hidden="true" />
                        <input
                          type="search"
                          value={sourceRevisionSearchQuery}
                          onChange={(event) => setSourceRevisionSearchQuery(event.target.value)}
                          onKeyDown={handleSourceRevisionSearchKeyDown}
                          placeholder="Search source revisions"
                          aria-label="Search source revisions"
                        />
                        {sourceRevisionSearchQuery ? (
                          <button
                            type="button"
                            className="icon-button small"
                            onClick={() => setSourceRevisionSearchQuery("")}
                            title="Clear source revision search"
                            aria-label="Clear source revision search"
                          >
                            <X size={13} aria-hidden="true" />
                          </button>
                        ) : null}
                      </label>
                      <span
                        className={`document-review-search-count ${sourceRevisionSearchActive ? "active" : ""}`}
                        title={sourceRevisionSearchActive ? `${sourceRevisionNavigationEntries.length} of ${sourceTrackedChanges.length} source revisions match` : "Source revision queue"}
                      >
                        {sourceRevisionSearchMatchLabel}
                      </span>
                    </div>
                    <div className="source-revision-list document-source-revision-list">
                      {sourceRevisionNavigationEntries.length ? sourceRevisionNavigationEntries.map(({ change, index }) => {
                        const meta = formatSourceTrackedChangeMeta(change);
                        const visibleInAcceptedText = sourceRevisionCanFocusAcceptedText(change);
                        const active = activeSourceRevisionIndex === index && activeSourceRevision === change;
                        return (
                          <button
                            type="button"
                            className={`source-revision-item document-source-revision-item ${change.kind} ${active ? "active" : ""}`}
                            key={`${change.kind}-${index}-${change.text.slice(0, 24)}`}
                            onClick={() => focusSourceRevision(index)}
                            aria-current={active ? "true" : undefined}
                            aria-label={`Focus source revision ${index + 1}: ${sourceTrackedChangeKindLabel(change.kind)}`}
                            title={visibleInAcceptedText ? "Focus this source revision in accepted document text" : "Preview only: this source revision text is not visible in accepted document text"}
                          >
                            <span>
                              <strong>{sourceTrackedChangeKindLabel(change.kind)}</strong>
                              {meta ? <small>{meta}</small> : null}
                            </span>
                            <p title={change.text}>{truncate(change.text, 220)}</p>
                            <em>{visibleInAcceptedText ? "Find in text" : "Preview only"}</em>
                          </button>
                        );
                      }) : (
                        <p className="document-source-revision-empty">No source revisions match.</p>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            <EditorContent editor={editor} />
          </div>
          {markPopover ? (
            <div
              className="mark-popover"
              role="dialog"
              aria-label={`Resolve inline suggestion: ${markPopover.suggestion.title}`}
              style={{ left: Math.min(markPopover.x, window.innerWidth - 280), top: markPopover.y + 14 }}
              onClick={(event) => event.stopPropagation()}
            >
              <strong>{markPopover.suggestion.title}</strong>
              <div className="mark-popover-actions">
                <button
                  type="button"
                  onClick={() => {
                    resolveInlineSuggestion(markPopover.suggestion, "accept");
                    setMarkPopover(null);
                  }}
                >
                  <Check size={14} aria-hidden="true" /> Accept
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resolveInlineSuggestion(markPopover.suggestion, "reject");
                    setMarkPopover(null);
                  }}
                >
                  <X size={14} aria-hidden="true" /> Reject
                </button>
                <button type="button" className="mark-popover-close" onClick={() => setMarkPopover(null)} aria-label="Close">
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : null}
          {localMode ? (
            <div className={`terminal-dock ${terminalDockOpen ? "open" : "folded"}`}>
              <div
                className="terminal-dock-bar"
                role="button"
                tabIndex={0}
                onClick={toggleTerminalDock}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleTerminalDock();
                  }
                }}
                aria-expanded={terminalDockOpen}
                title={terminalDockOpen ? "Fold the agent terminal" : "Open the agent terminal"}
              >
                <span><SquareTerminal size={14} aria-hidden="true" /> {providerLabel(provider)} terminal</span>
                <span className="terminal-dock-hint">
                  {terminalDockOpen ? "ask it to revise; edits appear in Proposed changes" : "folded"}
                  <button
                    type="button"
                    className="terminal-dock-restart"
                    title={`Restart the ${providerLabel(provider)} terminal session — kills the current CLI and launches a fresh one (use after an update or a failed launch)`}
                    aria-label={`Restart the ${providerLabel(provider)} terminal session`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!window.confirm(`Restart the ${providerLabel(provider)} terminal? The current CLI session ends and a fresh one launches.`)) {
                        return;
                      }
                      void fetch("/api/agent-terminal/restart", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ provider: provider === "codex" ? "codex" : "claude" })
                      }).then(() => {
                        setDocumentNote(`Restarting the ${providerLabel(provider)} terminal…`);
                        if (!terminalDockOpen) {
                          toggleTerminalDock();
                        }
                      }).catch(() => setError("Could not restart the terminal — is the local Writer running?"));
                    }}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                  </button>
                  {terminalDockOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
                </span>
              </div>
              <div className="terminal-dock-body">
                <AgentTerminal provider={provider === "codex" ? "codex" : "claude"} />
              </div>
            </div>
          ) : null}
        </section>

        <aside
          className={`ai-pane${localMode ? " local" : ""}${collapsedAiPanel ? ` collapse-${collapsedAiPanel}` : ""}`}
          style={{ "--ai-split": aiPaneSplit } as CSSProperties}
        >
          {localMode ? null : (<>
          <div
            className={`chat-card${localMode ? " terminal-primary" : ""}`}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
              }
            }}
            onDrop={(event) => {
              if (event.dataTransfer.files.length) {
                event.preventDefault();
                void handleAttachFiles(event.dataTransfer.files);
              }
            }}
          >
            <div
              className="panel-heading"
              onClick={collapsedAiPanel === "chat" ? () => toggleAiPanelCollapse("chat") : undefined}
            >
              <div>
                <p className="eyebrow">{localMode ? "Agent terminal" : "AI chat"}</p>
                {/* Reflect the scope the next message will actually use — a
                    detached selection is whole-document, whatever is
                    highlighted in the editor. */}
                <h2>{localMode ? providerLabel(provider) : (selection && selectionAttached ? "Selection-aware" : "Whole document")}</h2>
              </div>
              <div className="chat-heading-actions">
                <button
                  type="button"
                  className="panel-collapse-button"
                  onClick={(event) => { event.stopPropagation(); startNewConversation(); }}
                  disabled={busy !== null}
                  title="Start a new conversation: the AI forgets earlier turns; pending suggestions and attachments stay"
                  aria-label="Start a new conversation"
                >
                  <MessageSquarePlus size={15} aria-hidden="true" />
                </button>
                {!localMode ? (
                <button
                  type="button"
                  className={`agent-terminal-button${terminalOpen && localMode ? " active" : ""}`}
                  onClick={(event) => { event.stopPropagation(); void handleOpenAgentTerminal(); }}
                  disabled={agentTerminalBusy}
                  title={localMode
                    ? `Toggle a real ${providerLabel(provider)} terminal that drives this document. Edits it stages appear in this review queue.`
                    : `Open a real ${providerLabel(provider)} terminal that drives this document (secured by hop). Edits it stages appear in this review queue.`}
                  aria-label="Open agent terminal"
                  aria-pressed={terminalOpen && localMode}
                >
                  {agentTerminalBusy ? <Loader2 size={14} aria-hidden="true" /> : <SquareTerminal size={14} aria-hidden="true" />}
                  <span>Terminal</span>
                </button>
                ) : null}
                <button
                  type="button"
                  className="panel-collapse-button"
                  onClick={(event) => { event.stopPropagation(); toggleAiPanelCollapse("chat"); }}
                  title={collapsedAiPanel === "chat" ? "Expand the AI chat" : "Collapse the AI chat to give Proposed changes the full height"}
                  aria-label={collapsedAiPanel === "chat" ? "Expand AI chat" : "Collapse AI chat"}
                  aria-expanded={collapsedAiPanel !== "chat"}
                >
                  {collapsedAiPanel === "chat" ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
                </button>
              </div>
            </div>

            {localMode ? (
              <div className="agent-terminal-inline">
                <div className="agent-terminal-bar">
                  <span>{providerLabel(provider)} — ask it to revise; edits appear in Proposed changes</span>
                </div>
                <AgentTerminal provider={provider === "codex" ? "codex" : "claude"} />
              </div>
            ) : null}

            {aiRequestBlocked ? (
              <div className="local-ai-hint compact">
                <span>
                  {cloudMode
                    ? inSafari
                      ? "Safari can't connect AI — use Chrome, Edge, or Firefox."
                      : "AI is offline in this tab."
                    : aiSetupReason === "sidecar-down"
                      ? "The Writer sidecar isn't running."
                      : aiSetupReason === "cli-locked"
                        ? "AI is locked for this sidecar."
                        : `The ${providerLabel(provider)} CLI isn't installed on this machine.`}
                </span>
                <button type="button" onClick={() => setSetupGuideOpen(true)}>
                  {cloudMode && inSafari ? "How to switch" : "Set up AI"}
                </button>
              </div>
            ) : null}

            <div className="chat-controls-row">
              <div className="selection-context" aria-live="polite">
                {selection && selectionAttached ? (
                  <span
                    className="selection-chip"
                    title={`Your next message references the selected text:\n"${truncate(selection.text, 280)}"\nRemove the reference to ask about the whole document.`}
                  >
                    <LocateFixed size={13} aria-hidden="true" />
                    <em>{truncate(selection.text.replace(/\s+/g, " "), 46)}</em>
                    <button
                      type="button"
                      onClick={() => setDetachedSelectionKey(currentSelectionKey)}
                      aria-label="Remove selection reference"
                      title="Ask about the whole document instead"
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </span>
                ) : selection ? (
                  <button
                    type="button"
                    className="selection-attach"
                    onClick={() => setDetachedSelectionKey(null)}
                    title="Reference the selected text in your next message"
                  >
                    <LocateFixed size={13} aria-hidden="true" /> Reference selection
                  </button>
                ) : (
                  <span className="selection-none" title="Select text in the document to reference it. Without a selection, messages consider the whole document.">
                    <FileText size={13} aria-hidden="true" /> Whole document
                  </span>
                )}
              </div>
              <button
                type="button"
                className={`prompt-library-bar `}
                onClick={() => setPromptLibraryOpen((open) => !open)}
                aria-expanded={promptLibraryOpen}
                aria-controls="prompt-library-panel"
                title="Browse starter and saved skills"
              >
                <span className="prompt-library-bar-label">
                  <FilePenLine size={14} aria-hidden="true" /> Skills
                </span>
                {promptLibraryOpen ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
              </button>
            </div>

            {loadedRoutineIntent ? (
              <div className="routine-active-preset standalone" role="status" aria-label="Loaded skill">
                <span>Loaded skill</span>
                <strong>{loadedRoutineIntent.label}</strong>
                <button
                  type="button"
                  onClick={() => {
                    setLoadedRoutineIntent(null);
                    setDraftInstruction("");
                    setInstruction("");
                  }}
                  aria-label="Clear loaded preset"
                  title="Discard this preset and its drafted prompt"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            <div className="chat-flex">
            {promptLibraryOpen ? (
            <div className="routine-panel" id="prompt-library-panel">
              <div className="routine-heading">
                <span><FilePenLine size={14} aria-hidden="true" /> Skills</span>
                <div className="routine-heading-actions">
                  <button
                    type="button"
                    onClick={openSavePromptForm}
                    aria-expanded={savePromptFormOpen}
                    aria-controls="save-prompt-form"
                    disabled={!instruction.trim() || busy !== null}
                    title={instruction.trim() ? "Save the prompt currently in the chat box as a reusable skill" : "Write a prompt in the chat box first, then save it as a skill"}
                    aria-label="Save current skill"
                  >
                    <Plus size={14} aria-hidden="true" />
                    <span>Save current skill</span>
                  </button>
                </div>
              </div>

              {savePromptFormOpen ? (
                <div className="routine-save-row" id="save-prompt-form">
                  <input
                    ref={routineNameInputRef}
                    value={routineName}
                    onChange={(event) => setRoutineName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        saveCurrentRoutine();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setSavePromptFormOpen(false);
                      }
                    }}
                    placeholder="Name this skill (optional)"
                    aria-label="Skill name"
                  />
                  <button
                    type="button"
                    onClick={saveCurrentRoutine}
                    disabled={!instruction.trim() || busy !== null}
                    aria-label="Save skill"
                    title="Save"
                  >
                    <Check size={14} aria-hidden="true" /> Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setSavePromptFormOpen(false)}
                    aria-label="Cancel saving skill"
                    title="Cancel"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ) : null}

              {userRoutines.length ? (
                <div className="routine-library user" aria-label="Saved skills">
                  <div className="routine-library-heading">
                    <span>Saved skills</span>
                    <span>{userRoutines.length}</span>
                  </div>
                  <div className="routine-list">
                    {userRoutines.map((routine) => (
                      <span key={routine.id} className="routine-chip">
                        <button
                          type="button"
                          onClick={() => useRoutine(routine)}
                          disabled={busy !== null}
                          title={routine.prompt}
                          aria-label={`Use saved skill: ${routine.label}`}
                        >
                          <Sparkles size={14} aria-hidden="true" /> {routine.label}
                        </button>
                        <button
                          type="button"
                          className="routine-chip-delete"
                          onClick={() => deleteRoutine(routine.id)}
                          disabled={busy !== null}
                          title={`Delete saved skill: ${routine.label}`}
                          aria-label={`Delete saved skill: ${routine.label}`}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className={`routine-library starter ${starterPromptsOpen ? "open" : "collapsed"}`} aria-label="Starter skill presets">
                <button
                  type="button"
                  className="routine-library-toggle"
                  onClick={() => setStarterPromptsOpen((open) => !open)}
                  aria-expanded={starterPromptsOpen}
                  aria-controls="starter-prompt-presets"
                  aria-label={starterPromptsOpen ? "Hide starter skills" : "Show starter skills"}
                >
                  <span><FileText size={14} aria-hidden="true" /> Starter skills</span>
                  <span>
                    <em>{generalRoutinePresets.length}</em>
                    {starterPromptsOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                  </span>
                </button>
                {starterPromptsOpen ? (
                  <div id="starter-skill-presets" className="routine-list">
                    {generalRoutinePresets.map((routine) => (
                      <button
                        key={routine.id}
                        type="button"
                        onClick={() => useRoutine(routine)}
                        disabled={busy !== null}
                        title={routine.title ?? routine.prompt}
                        aria-label={routine.ariaLabel ?? `Use preset: ${routine.label}`}
                      >
                        {routine.builtIn ? <FileText size={14} aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />} {routine.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {showR01RoutinePath ? (
                <div
                  className={`routine-path ${r01RoutinePanelOpen ? "open" : ""}`}
                >
                  <button
                    type="button"
                    className="routine-path-toggle"
                    onClick={() => setR01RoutinePanelOpen((open) => !open)}
                    aria-expanded={r01RoutinePanelOpen}
                    aria-controls="r01-routine-path"
                    aria-label={r01RoutinePanelOpen ? "Hide optional grant workflow" : "Show optional grant workflow"}
                  >
                    <span><FilePenLine size={14} aria-hidden="true" /> Grant workflow <em>Optional</em></span>
                    {r01RoutinePanelOpen ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                  </button>
                  {r01RoutinePanelOpen ? (
                    <div id="r01-routine-path" className="routine-path-body">
                      <div className="routine-path-summary">
                        <span>Grant workflow</span>
                        <em>{completedSequenceRoutineCount ? `${completedSequenceRoutineCount} exported` : "No exports yet"}</em>
                      </div>
                      <div className="routine-sequence" aria-label="R01 routine sequence">
                        <div className="routine-sequence-current">
                          <span className="routine-sequence-label">Next grant pass</span>
                          <span className="sequence-position">{nextR01Routine.label}</span>
                        </div>
                        <button
                          type="button"
                          onClick={useNextRoutineInSequence}
                          disabled={busy !== null}
                          aria-label={`Load grant preset: ${nextR01Routine.label}`}
                          title={nextR01Routine.title ?? nextR01Routine.prompt}
                        >
                          <FilePenLine size={14} aria-hidden="true" /> Load {nextR01Routine.label}
                        </button>
                        <button
                          type="button"
                          onClick={restartRoutineSequence}
                          disabled={busy !== null}
                          aria-label="Reset grant path progress"
                          title="Reset grant path progress"
                        >
                          <RefreshCw size={13} aria-hidden="true" />
                        </button>
                        {loadedSequenceRoutine ? (
                          <span className="sequence-loaded">
                            Loaded: {loadedSequenceRoutine.label}. Advances after suggestions.
                          </span>
                        ) : null}
                        <div className="sequence-progress" aria-label="R01 routine progress">
                          {r01RoutineSequence.map((routine) => {
                            const completed = completedSequenceRoutineIds.includes(routine.id);
                            const active = loadedSequenceRoutineId === routine.id || nextR01Routine.id === routine.id;
                            return (
                              <span
                                key={routine.id}
                                className={`sequence-step ${completed ? "done" : active ? "active" : ""}`}
                                title={completed ? `${routine.label} exported` : active ? `${routine.label} is next` : `${routine.label} pending`}
                              >
                                {completed ? <Check size={12} aria-hidden="true" /> : null}
                                {routine.label}
                              </span>
                            );
                          })}
                        </div>
                        {sequenceReviewHandoff ? (
                          <div className="sequence-handoff" role="status" aria-label="Routine export handoff">
                            <span>
                              <FilePenLine size={14} aria-hidden="true" />
                              {sequenceReviewHandoff.label} returned {sequenceReviewHandoff.suggestionCount} reviewable edit{sequenceReviewHandoff.suggestionCount === 1 ? "" : "s"}.
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleExport(true)}
                              disabled={!editor || busy !== null || pendingSuggestions.length === 0}
                              aria-label={`Export ${sequenceReviewHandoff.label} review DOCX`}
                              title="Create a Word review DOCX with tracked changes and Word comments"
                            >
                              <FilePenLine size={14} aria-hidden="true" /> Export review DOCX
                            </button>
                          </div>
                        ) : null}
                        {sequenceExportSummary ? (
                          <div className="sequence-export" role="status" aria-label="Routine export summary">
                            <span>
                              <FilePenLine size={14} aria-hidden="true" />
                              {sequenceExportSummaryLabel(sequenceExportSummary)}
                            </span>
                            {sequenceExportSummary.report && (sequenceExportSummary.report.commentedSuggestions || sequenceExportSummary.report.unmatchedSuggestions) ? (
                              <small>{trackedExportPanelDetail(sequenceExportSummary.report, reportDisplayOptionsForRoutineId(sequenceExportSummary.routineId))}</small>
                            ) : null}
                            {sequenceExportSummary.filename ? (
                              <small className="review-export-filename">File: {sequenceExportSummary.filename}</small>
                            ) : null}
                            {exportReportNeedsRefinement(sequenceExportSummary.report, reportDisplayOptionsForRoutineId(sequenceExportSummary.routineId)) ? (
                              <button
                                type="button"
                                onClick={() => refineExportReport(sequenceExportSummary.report)}
                                disabled={busy !== null}
                                aria-label="Refine Word comment or unresolved suggestions"
                                title="Load a prompt that asks AI to make safer body tracked-change candidates"
                              >
                                <Sparkles size={14} aria-hidden="true" /> Refine for tracked changes
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={useNextRoutineInSequence}
                              disabled={busy !== null}
                              aria-label={`Continue grant path with ${nextR01Routine.label}`}
                              title={`Load ${nextR01Routine.label} routine`}
                            >
                              <FilePenLine size={14} aria-hidden="true" /> Continue: {nextR01Routine.label}
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <div className="routine-library compact" aria-label="R01 writing presets">
                        <div className="routine-library-heading">
                          <span>Grant presets</span>
                          <span>{r01BuiltInRoutines.length}</span>
                        </div>
                        <div className="routine-list">
                          {r01BuiltInRoutines.map((routine) => (
                            <button
                              key={routine.id}
                              type="button"
                              onClick={() => useRoutine(routine)}
                              disabled={busy !== null}
                              title={routine.title ?? routine.prompt}
                              aria-label={routine.ariaLabel ?? `Use preset: ${routine.label}`}
                            >
                              <FilePenLine size={14} aria-hidden="true" /> {routine.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

            </div>
            ) : null}

            {!promptLibraryOpen && selection ? (
              <div className="selection-preview">
                <Highlighter size={15} aria-hidden="true" />
                <span>{truncate(normalizeText(selection.text), 150)}</span>
              </div>
            ) : null}

            {!promptLibraryOpen ? (
            <div ref={messageListRef} className="message-list" aria-label="Chat history" aria-live="polite" aria-busy={busy === "Asking AI"}>
              {messages.map((message) => {
                const fromPeer = message.role === "user" && Boolean(message.author) && message.author !== collabSession.user.name;
                return (
                  <article key={message.id} className={`message ${message.role}${fromPeer ? " peer" : ""}`}>
                    {message.author && message.author !== collabSession.user.name ? (
                      <span className="message-author">
                        {(() => {
                          const peer = collaborators.find((candidate) => candidate.name === message.author);
                          return peer ? <i className="message-author-dot" style={{ background: peer.color }} aria-hidden="true" /> : null;
                        })()}
                        {message.author}
                      </span>
                    ) : null}
                    {message.content}
                  </article>
                );
              })}
              {busy === "Asking AI" ? (
                <article className="message assistant thinking" role="status" aria-label={`${providerLabel(provider)} is drafting suggestions`}>
                  <Loader2 size={14} aria-hidden="true" />
                  <span>
                    {remoteAiProgress && remoteAiProgress.requestedBy && remoteAiProgress.requestedBy !== collabSession.user.name
                      ? `Queued — waiting for ${remoteAiProgress.requestedBy}'s ${remoteAiProgress.provider === "claude" ? "Claude Code" : "Codex"} request to finish first`
                      : remoteAiProgress?.stage
                        ? `${providerLabel(provider)} — ${remoteAiProgress.stage}`
                        : `${providerLabel(provider)} is drafting suggestions`}
                  </span>
                </article>
              ) : null}
              {busy !== "Asking AI" && remoteAiProgress ? (
                <article className="message assistant thinking" role="status" aria-label="A collaborator's AI request is running">
                  <Loader2 size={14} aria-hidden="true" />
                  <span>
                    {remoteAiProgress.provider === "claude" ? "Claude Code" : remoteAiProgress.provider === "codex" ? "Codex" : remoteAiProgress.provider} is drafting suggestions
                    {remoteAiProgress.requestedBy ? ` for ${remoteAiProgress.requestedBy}` : ""} — {remoteAiProgress.stage}
                    {remoteAiQueue.length ? ` (+${remoteAiQueue.length} queued)` : ""}
                  </span>
                </article>
              ) : null}
            </div>
            ) : null}
            </div>

            {maxSuggestionsInput.trim() ? (
              <div className="cap-chip-row">
                <span className="cap-chip" title="This cap was set by a saved skill or retry flow; remove it to let the AI return as many edits as it finds useful.">
                  Capped at {maxSuggestionsInput} edit{maxSuggestionsInput.trim() === "1" ? "" : "s"} per request
                  <button
                    type="button"
                    onClick={() => setMaxSuggestionsInput("")}
                    aria-label="Remove suggestion cap"
                    title="Remove suggestion cap"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </span>
              </div>
            ) : null}

            {pendingAttachments.length || attachmentBusy ? (
              <div className="attachment-row" aria-label="Reference files in this chat's context">
                {pendingAttachments.length ? (
                  <span className="attachment-context-label" title="These files stay attached to every message in this chat until you remove them — no need to re-attach.">
                    In context:
                  </span>
                ) : null}
                {pendingAttachments.map((attachment, index) => (
                  <span
                    key={`${attachment.path}-${index}`}
                    className="attachment-chip"
                    title={`${attachment.path}\nStays in context for every message until removed.${attachment.truncated ? "\nText truncated for the prompt; Codex can read the full file at this path." : ""}${attachment.text ? "" : "\nNo text could be extracted — Codex can read the file at this path, but Claude Code cannot."}`}
                  >
                    <Paperclip size={12} aria-hidden="true" />
                    {attachment.name}
                    {attachment.truncated ? <em>truncated</em> : null}
                    {!attachment.text ? <em>no text</em> : null}
                    <button
                      type="button"
                      onClick={() => setPendingAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      aria-label={`Remove attachment ${attachment.name} from context`}
                      title="Remove from context"
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {attachmentBusy ? (
                  <span className="attachment-chip pending">
                    <Loader2 size={12} aria-hidden="true" /> attaching...
                  </span>
                ) : null}
              </div>
            ) : null}

            <form
              className={`composer ${instruction.trim() ? "has-input" : ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                void handleSend();
              }}
            >
              <button
                type="button"
                className="attach-button"
                onClick={() => attachmentInputRef.current?.click()}
                disabled={attachmentBusy || (cloudMode && !localAiActive)}
                aria-label="Attach a reference file"
                title={cloudMode && !localAiActive
                  ? "Attachments run through your local Writer — see 'Set up AI'"
                  : "Attach a reference file for the next request (or drag & drop into the chat)"}
              >
                <Paperclip size={16} aria-hidden="true" />
              </button>
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = event.target.files;
                  if (files?.length) {
                    void handleAttachFiles(files);
                  }
                  event.target.value = "";
                }}
                aria-hidden="true"
                tabIndex={-1}
              />
              <textarea
                ref={composerRef}
                value={instruction}
                onChange={handleInstructionChange}
                onKeyDown={handleComposerKeyDown}
                placeholder={aiInstructionPlaceholder}
                aria-label="AI instruction"
                aria-keyshortcuts="Shift+Enter Control+Enter Meta+Enter"
              />
              <button
                type={isAskingAi ? "button" : "submit"}
                className={`send-button ${isAskingAi ? "is-interrupting" : ""}`}
                disabled={isAskingAi ? false : !canSendInstruction}
                aria-label={isAskingAi ? "Stop AI request" : "Send revision request"}
                aria-keyshortcuts={isAskingAi ? "Escape" : "Shift+Enter Control+Enter Meta+Enter"}
                title={isAskingAi ? "Stop AI request" : "Send"}
                onClick={(event) => {
                  if (isAskingAi) {
                    event.preventDefault();
                    handleInterruptAi();
                  }
                }}
              >
                {isAskingAi ? <Square size={16} aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
              </button>
            </form>
          </div>

          <div
            className="ai-pane-divider"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize chat and review panels"
            title="Drag to resize; double-click to reset"
            onPointerDown={startAiPaneResize}
            onDoubleClick={() => setAiPaneSplit(0.48)}
          />
          </>)}

          <div className="suggestions-panel">
            <div
              className="panel-heading compact"
              onClick={collapsedAiPanel === "review" ? () => toggleAiPanelCollapse("review") : undefined}
            >
              <div>
                <p className="eyebrow">Review queue</p>
                <h2>Proposed changes</h2>
                {suggestions.length ? (
                  <p className="review-progress" aria-label="Review progress">
                    {suggestions.length - pendingSuggestions.length} of {suggestions.length} reviewed
                  </p>
                ) : null}
              </div>
              <div className="panel-tools">
                <button
                  type="button"
                  className={`icon-button small auto-advance-toggle ${autoAdvanceReview ? "active" : ""}`}
                  onClick={toggleAutoAdvanceReview}
                  aria-pressed={autoAdvanceReview}
                  aria-label="Toggle auto-advance after accept or reject"
                  title={autoAdvanceReview
                    ? "Auto-advance is on: after you accept or reject, the next pending suggestion is highlighted. Click to stay on the edited text instead."
                    : "Auto-advance is off: after you accept, the view stays on the edited text so you can verify it. Click to jump to the next pending suggestion automatically."}
                >
                  <SkipForward size={15} aria-hidden="true" />
                </button>
                {reviewNavigationSuggestions.length > 1 ? (
                  <div className="review-nav" aria-label="Pending suggestion navigation">
                    <button
                      type="button"
                      className="icon-button small"
                      onClick={() => navigatePendingSuggestion(-1)}
                      disabled={busy !== null}
                      title="Previous pending suggestion"
                      aria-label="Previous pending suggestion"
                    >
                      <ChevronUp size={15} aria-hidden="true" />
                    </button>
                    <span
                      className="review-position"
                      aria-label={`Active pending suggestion ${reviewNavigationIndex} of ${reviewNavigationSuggestions.length}`}
                      title="Keyboard: j / k to step, a to accept, r to reject (while not typing)"
                    >
                      Suggestion {reviewNavigationIndex} of {reviewNavigationSuggestions.length}
                    </span>
                    <button
                      type="button"
                      className="icon-button small"
                      onClick={() => navigatePendingSuggestion(1)}
                      disabled={busy !== null}
                      title="Next pending suggestion"
                      aria-label="Next pending suggestion"
                    >
                      <ChevronDown size={15} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
                <Sparkles size={20} aria-hidden="true" />
                <button
                  type="button"
                  className="panel-collapse-button"
                  onClick={(event) => { event.stopPropagation(); toggleAiPanelCollapse("review"); }}
                  title={collapsedAiPanel === "review" ? "Expand Proposed changes" : "Collapse Proposed changes to give the AI chat the full height"}
                  aria-label={collapsedAiPanel === "review" ? "Expand proposed changes" : "Collapse proposed changes"}
                  aria-expanded={collapsedAiPanel !== "review"}
                >
                  {collapsedAiPanel === "review" ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                </button>
              </div>
            </div>

            {suggestions.length || reviewSearchQuery ? (
              <div className="review-panel-search-row">
                <label className="document-review-search review-panel-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    type="search"
                    value={reviewSearchQuery}
                    onChange={(event) => setReviewSearchQuery(event.target.value)}
                    onKeyDown={handleReviewSearchKeyDown}
                    placeholder="Search changes"
                    aria-label="Search proposed changes"
                  />
                  {reviewSearchQuery ? (
                    <button
                      type="button"
                      className="icon-button small"
                      onClick={() => setReviewSearchQuery("")}
                      title="Clear proposed change search"
                      aria-label="Clear proposed change search"
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </label>
                <span
                  className={`document-review-search-count ${reviewSearchActive ? "active" : ""}`}
                  title={reviewSearchActive ? `${visibleSuggestions.length} of ${reviewSearchBaseCount} visible ${reviewFilterLabel(reviewFilter).toLowerCase()} changes match` : `${reviewFilterLabel(reviewFilter)} queue`}
                >
                  {reviewSearchMatchLabel}
                </span>
                {reviewPeople.length > 1 ? (
                  <select
                    className="review-person-filter"
                    value={reviewPersonFilter ?? ""}
                    onChange={(event) => setReviewPersonFilter(event.target.value || null)}
                    aria-label="Filter suggestions by person"
                    title="Show only suggestions proposed or decided by one person or agent"
                  >
                    <option value="">Everyone</option>
                    {reviewPeople.map((person) => (
                      <option key={person} value={person}>{person}</option>
                    ))}
                  </select>
                ) : null}
              </div>
            ) : null}

            <div className="review-filter" role="tablist" aria-label="Review queue filter">
              <button
                type="button"
                role="tab"
                aria-selected={reviewFilter === "pending"}
                aria-label="Pending"
                className={reviewFilter === "pending" ? "active" : ""}
                onClick={() => setReviewFilter("pending")}
                title="Suggestions you have not accepted or rejected yet"
              >
                <span className="review-filter-label">Pending</span>
                <span className="review-filter-count" aria-hidden="true">{pendingSuggestions.length}</span>
              </button>
              {showPriorityFilter ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "priority"}
                  aria-label="Priority"
                  className={reviewFilter === "priority" ? "active" : ""}
                  onClick={() => setReviewFilter("priority")}
                  title="Show the highest-priority pending edits from latest exports, Word comments, conflicts, and missing targets"
                >
                  <span className="review-filter-label">Priority</span>
                  <span className="review-filter-count" aria-hidden="true">{priorityPendingSuggestions.length}</span>
                </button>
              ) : null}
              {showCleanPacketFilter ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "clean"}
                  aria-label="Clean packet"
                  className={reviewFilter === "clean" ? "active" : ""}
                  onClick={() => setReviewFilter("clean")}
                  title="Show pending suggestions whose original text is visible and not shared with competing edits"
                >
                  <span className="review-filter-label">Clean</span>
                  <span className="review-filter-count" aria-hidden="true">{cleanPacketPendingSuggestions.length}</span>
                </button>
              ) : null}
              {showConflictFilter ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "conflicts"}
                  aria-label="Conflicts"
                  className={reviewFilter === "conflicts" ? "active" : ""}
                  onClick={() => setReviewFilter("conflicts")}
                  title={`Show ${labelCount(conflictPendingSuggestions.length, "conflicting edit") ?? "conflicting edits"} across ${labelCount(pendingConflictAnchorGroupCount, "shared target") ?? "shared targets"}`}
                >
                  <span className="review-filter-label">Conflicts</span>
                  <span className="review-filter-count" aria-hidden="true">{pendingConflictAnchorGroupCount}</span>
                </button>
              ) : null}
              {showSourceMovedFilter ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "source-moved"}
                  aria-label="Missing target"
                  className={reviewFilter === "source-moved" ? "active" : ""}
                  onClick={() => setReviewFilter("source-moved")}
                  title="Show pending suggestions whose original text is no longer visible in the editor. Inside, use Refresh to re-request them against the current text, or Dismiss to drop the stale ones."
                >
                  <span className="review-filter-label">Missing</span>
                  <span className="review-filter-count" aria-hidden="true">{sourceMovedPendingSuggestions.length}</span>
                </button>
              ) : null}
              {showSourceRevisionFilter ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "source-revisions"}
                  aria-label="Source revisions"
                  className={reviewFilter === "source-revisions" ? "active" : ""}
                  onClick={() => setReviewFilter("source-revisions")}
                  title="Show tracked changes that were already present in the source Word document"
                >
                  <span className="review-filter-label">Source</span>
                  <span className="review-filter-count" aria-hidden="true">{sourceTrackedChanges.length}</span>
                </button>
              ) : null}
              {showLatestRunFilter ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "latest"}
                  aria-label="Latest export"
                  className={reviewFilter === "latest" ? "active" : ""}
                  onClick={() => setReviewFilter("latest")}
                  title={latestRoutineRun ? `Show pending suggestions from ${latestRoutineRun.label}` : undefined}
                >
                  <span className="review-filter-label">Latest</span>
                  <span className="review-filter-count" aria-hidden="true">{latestRunPendingSuggestions.length}</span>
                </button>
              ) : null}
              {showDuplicateTargetFilter ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "duplicates"}
                  aria-label="Same-source Word comments"
                  className={reviewFilter === "duplicates" ? "active" : ""}
                  onClick={() => setReviewFilter("duplicates")}
                  title={`Show ${labelCount(wordCommentOverlapGroupCount, "same-source Word comment group") ?? "same-source Word comment groups"} as one lead card per shared source text`}
                >
                  <span className="review-filter-label">Same source</span>
                  <span className="review-filter-count" aria-hidden="true">{wordCommentOverlapGroupCount}</span>
                </button>
              ) : null}
              {showWordCommentFilter ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "word-comments"}
	                  aria-label="Word comments"
	                  className={reviewFilter === "word-comments" ? "active" : ""}
	                  onClick={() => setReviewFilter("word-comments")}
	                  title={wordCommentFilterTitle}
	                >
                  <span className="review-filter-label">Word</span>
                  <span className="review-filter-count" aria-hidden="true">{wordCommentPendingSuggestions.length}</span>
                </button>
              ) : null}
              {showFactCheckFilter ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewFilter === "fact-checks"}
                  aria-label="PI/fact checks"
                  className={reviewFilter === "fact-checks" ? "active" : ""}
                  onClick={() => setReviewFilter("fact-checks")}
                  title="Show pending citation, unit, protocol, placeholder, and PI verification handoffs"
                >
                  <span className="review-filter-label">Checks</span>
                  <span className="review-filter-count" aria-hidden="true">{factCheckPendingSuggestions.length}</span>
                </button>
              ) : null}
              <button
                type="button"
                role="tab"
                aria-selected={reviewFilter === "all"}
                aria-label="All"
                className={reviewFilter === "all" ? "active" : ""}
                onClick={() => setReviewFilter("all")}
                title="Everything from this session, including suggestions you already accepted or rejected (use Undo accept / Restore there to change your mind)"
              >
                <span className="review-filter-label">All</span>
                <span className="review-filter-count" aria-hidden="true">{suggestions.length}</span>
              </button>
            </div>

            {showReviewBacklogStatus && reviewBacklogStatus ? (
              <div className="review-backlog-note" role="status" aria-label="Review backlog status">
                <div className="review-backlog-note-topline">
                  <strong>{reviewBacklogStatus.headline}</strong>
                  <button
                    type="button"
                    className="icon-button subtle review-backlog-close"
                    onClick={() => {
                      setDismissedBacklogSummarySignature(reviewBacklogSummarySignature);
                    }}
                    aria-label="Dismiss review backlog status"
                    title="Dismiss"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <span>{reviewBacklogStatus.detail}</span>
              </div>
            ) : null}

            {reviewFilter === "source-moved" && sourceMovedPendingSuggestions.length ? (
              <div className="export-report-actions source-moved-actions">
                <button
                  type="button"
                  className="export-report-action"
                  onClick={refreshSourceMovedAnchors}
                  disabled={busy !== null}
                  aria-label={`Refresh ${sourceMovedActionLabel}`}
                >
                  <Sparkles size={14} aria-hidden="true" /> Refresh {sourceMovedActionLabel}
                </button>
                <button
                  type="button"
                  className="export-report-action"
                  onClick={dismissSourceMovedAnchors}
                  disabled={busy !== null}
                  aria-label={`Dismiss ${sourceMovedActionLabel}`}
                >
                  <X size={14} aria-hidden="true" /> Dismiss {sourceMovedActionLabel}
                </button>
              </div>
            ) : null}

            {reviewFilter === "source-revisions" && sourceTrackedChanges.length ? (
              <div className="review-backlog-note source-revision-review-note" role="status" aria-label="Source revision review status">
                <strong>Source revisions from Word</strong>
                <span>Original tracked changes are shown as accepted in the editor; the main text pane carries their review controls.</span>
                <div className="export-report-actions source-revision-review-actions">
                  <button
                    type="button"
                    className="export-report-action"
                    onClick={() => setShowSourceRevisionsInDocument(true)}
                    disabled={showSourceRevisionsInDocument}
                    aria-label={showSourceRevisionsInDocument ? "Source revisions shown in document text" : "Show source revisions in document text"}
                  >
                    <LocateFixed size={13} aria-hidden="true" /> {showSourceRevisionsInDocument ? "Shown in text" : "Show in text"}
                  </button>
                  <button
                    type="button"
                    className={`export-report-action ${highlightSourceRevisionsInline ? "active" : ""}`}
                    onClick={() => setHighlightSourceRevisionsInline((on) => !on)}
                    aria-pressed={highlightSourceRevisionsInline}
                    title="Highlight source revisions inline in the document text (insertions in place, deletions as markers). Toggle off to hide."
                    aria-label={highlightSourceRevisionsInline ? "Hide inline source revision highlights" : "Highlight source revisions inline"}
                  >
                    <Sparkles size={13} aria-hidden="true" /> {highlightSourceRevisionsInline ? "Highlighting" : "Highlight inline"}
                  </button>
                </div>
              </div>
            ) : null}

            {reviewFilter === "conflicts" && conflictPendingSuggestions.length ? (
              <p className="conflict-decision-note">
                {labelCount(pendingConflictAnchorGroupCount, "shared target") ?? "Shared targets"} with {labelCount(conflictPendingSuggestions.length, "conflicting edit") ?? "conflicting edits"}. Select one winner per shared target before the next broad export.{topConflictAnchor ? ` Largest shared target: "${topConflictAnchor.preview}" (${labelCount(topConflictAnchor.count, "edit") ?? "edits"}).` : ""}
              </p>
            ) : null}

            {reviewFilter === "conflicts" && sharedAnchorDismissibleAlternatives.length ? (
              <div className="export-report-actions shared-anchor-actions">
                <button
                  type="button"
                  className="export-report-action"
                  onClick={dismissSharedAnchorAlternatives}
                  disabled={busy !== null}
                  aria-label={`Dismiss ${sharedAnchorAlternativeActionLabel}`}
                >
                  <X size={14} aria-hidden="true" /> Dismiss {sharedAnchorAlternativeActionLabel}
                </button>
              </div>
            ) : null}

            {reviewFilter === "duplicates" && wordCommentOverlapSuggestions.length ? (
              <div className="conflict-decision-note duplicate-target-note">
                <span>
                  {labelCount(wordCommentOverlapGroupCount, "same-source Word comment group") ?? "Same-source Word comment groups"} representing {labelCount(wordCommentOverlapSuggestions.length, "Word comment alternative") ?? "Word comment alternatives"}. These comments target the same original source text, usually from iterative passes; select one winner before manual insertion in Word.
                </span>
                <div className="export-report-actions duplicate-target-actions">
                  <button
                    type="button"
                    className="export-report-action"
                    onClick={copyWordCommentOverlapTriage}
                    aria-label="Copy same-source Word comment groups"
                    title="Copy a compact triage packet for all remaining Word comments that share source text"
                  >
                    <Copy size={13} aria-hidden="true" /> Copy groups
                  </button>
                  <button
                    type="button"
                    className="export-report-action"
                    onClick={() => setReviewFilter("word-comments")}
                    aria-label="Show all Word comments"
                    title="Open the full Word-comments queue"
                  >
                    <MessageSquareText size={13} aria-hidden="true" /> All Word comments
                  </button>
                </div>
              </div>
            ) : null}

            {reviewFilter === "word-comments" && wordCommentReviewStatus ? (
              <div className="review-backlog-note word-comment-review-note" role="status" aria-label="Word comment review status">
                <strong>{wordCommentReviewStatus.headline}</strong>
                <span>{wordCommentReviewStatus.detail}</span>
                {wordCommentOverlapOnly ? (
                  <small>
                    Showing {labelCount(wordCommentOverlapGroupCount, "same-source Word comment group") ?? "same-source Word comment groups"} as lead cards, representing {labelCount(wordCommentOverlapSuggestions.length, "Word comment alternative") ?? "Word comment alternatives"}.
                  </small>
                ) : null}
                {wordCommentOverlapSuggestions.length ? (
                  <div className="export-report-actions word-comment-review-actions">
                    <button
                      type="button"
                      className="export-report-action word-comment-overlap-action"
                      onClick={() => setWordCommentOverlapOnly((current) => !current)}
                      aria-pressed={wordCommentOverlapOnly}
                      aria-label={wordCommentOverlapOnly ? "Show all Word comments" : "Show same-source Word comments only"}
                      title={wordCommentOverlapOnly ? "Return to all Word comments" : "Limit the Word comments queue to comments that use the same source text"}
                    >
                      <LocateFixed size={13} aria-hidden="true" /> {wordCommentOverlapOnly ? `All Word comments (${wordCommentPendingSuggestions.length})` : `Same source (${wordCommentOverlapGroupCount})`}
                    </button>
                    <button
                      type="button"
                      className="export-report-action word-comment-overlap-action"
                      onClick={copyWordCommentOverlapTriage}
                      aria-label="Copy same-source Word comment groups"
                      title="Copy a compact triage packet for the remaining Word comments that share source text"
                    >
                      <Copy size={13} aria-hidden="true" /> Copy groups
                    </button>
                    {copiedOverlapGroupSuggestionId === "__word-comment-overlap-triage__" ? (
                      <small>Same-source Word comment groups copied</small>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {reviewFilter === "fact-checks" && factCheckPendingSuggestions.length ? (
              <div className="review-backlog-note fact-check-review-note" role="status" aria-label="PI/fact check review status">
                <strong>{labelCount(factCheckPendingSuggestions.length, "PI/fact check") ?? "PI/fact checks"}</strong>
                <span>Resolve citation, unit, and placeholder handoffs in Word before accepting nearby prose rewrites.</span>
              </div>
            ) : null}

            {visibleSuggestions.length ? (
              <div className="export-report-actions review-copy-actions">
                <button
                  type="button"
                  className="export-report-action quiet-copy-action"
                  onClick={copyVisibleSuggestions}
                  aria-label="Copy visible edits"
                  title="Copy visible edits"
                >
                  <Copy size={13} aria-hidden="true" /> Copy
                </button>
                {copiedVisibleSuggestionSignature === visibleSuggestionCopySignature ? (
                  <small>Visible edits copied</small>
                ) : null}
              </div>
            ) : null}

            {visibleSuggestionCopyText ? (
              <div className="visible-copy-box" role="region" aria-label="Visible edits copy box">
                <div className="visible-copy-box-heading">
                  <strong>Visible edits copy box</strong>
                  <button
                    type="button"
                    className="icon-button subtle"
                    onClick={() => setVisibleSuggestionCopyText("")}
                    aria-label="Close visible edits copy box"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <textarea
                  ref={visibleCopyTextAreaRef}
                  readOnly
                  value={visibleSuggestionCopyText}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Visible edits packet"
                />
              </div>
            ) : null}

            {overlapGroupCopyText ? (
              <div className="visible-copy-box" role="region" aria-label="Comment alternative group copy box">
                <div className="visible-copy-box-heading">
                  <strong>Comment alternative group copy box</strong>
                  <button
                    type="button"
                    className="icon-button subtle"
                    onClick={() => setOverlapGroupCopyText(null)}
                    aria-label="Close same-source Word comment copy box"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <small>{overlapGroupCopyText.title}</small>
                <textarea
                  ref={overlapGroupCopyTextAreaRef}
                  readOnly
                  value={overlapGroupCopyText.text}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="Comment alternative group packet"
                />
              </div>
            ) : null}

            {reviewActivity.length ? (
              <div className={`review-activity ${reviewActivityOpen ? "open" : ""}`}>
                <button
                  type="button"
                  className="review-activity-toggle"
                  onClick={() => setReviewActivityOpen((open) => !open)}
                  aria-expanded={reviewActivityOpen}
                  aria-controls="review-activity-list"
                  title="Recent accept/reject decisions on this document, by everyone"
                >
                  <span><History size={13} aria-hidden="true" /> Activity</span>
                  <span>
                    <em>{reviewActivity.length}</em>
                    {reviewActivityOpen ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                  </span>
                </button>
                {reviewActivityOpen ? (
                  <ul id="review-activity-list" className="review-activity-list">
                    {reviewActivity.map((entry) => (
                      <li key={entry.id}>
                        {/* The decision keeps its full proposed change on hand: the
                            author often edits after accepting and wants to look back. */}
                        <details className="review-activity-entry">
                          <summary>
                            <span>{entry.text}</span>
                            {entry.time ? <small>{entry.time}</small> : null}
                          </summary>
                          <DecidedChange suggestion={entry.suggestion} />
                        </details>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <div className="suggestion-stack">
              {suggestionMarkExportSuggestions.length ? (
                <div className="inline-suggestion-group" role="group" aria-label="Inline suggestions marked in the document">
                  <div className="inline-suggestion-heading">
                    <span><FilePenLine size={13} aria-hidden="true" /> Inline suggestions</span>
                    <em>{suggestionMarkExportSuggestions.length}</em>
                  </div>
                  {suggestionMarkExportSuggestions.map((markSuggestion) => (
                    <article
                      key={markSuggestion.id}
                      className="suggestion pending inline-mark"
                      role="button"
                      tabIndex={0}
                      aria-label={`Jump to inline suggestion: ${markSuggestion.title}`}
                      onClick={() => jumpToInlineSuggestion(markSuggestion)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          jumpToInlineSuggestion(markSuggestion);
                        }
                      }}
                    >
                      <header>
                        {/* Compact meta line: "deletion · OpenAI Codex". The full
                            "Suggested deletion by …" sentence stays in title/aria
                            (and export), but 200+ cards need density on screen. */}
                        <strong title={markSuggestion.title}>
                          {markSuggestion.title.replace(/^Suggested /, "").replace(/ by /, " · ")}
                        </strong>
                      </header>
                      <p className="inline-suggestion-diff">
                        {markSuggestion.original ? <del>{truncate(markSuggestion.original, 110)}</del> : null}
                        {markSuggestion.original && markSuggestion.replacement ? " " : null}
                        {markSuggestion.replacement ? <ins>{truncate(markSuggestion.replacement, 110)}</ins> : null}
                      </p>
                      <div className="suggestion-actions">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            resolveInlineSuggestion(markSuggestion, "accept");
                          }}
                        >
                          <Check size={16} aria-hidden="true" /> Accept
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            resolveInlineSuggestion(markSuggestion, "reject");
                          }}
                        >
                          <X size={16} aria-hidden="true" /> Reject
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
              {reviewFilter === "source-revisions" && sourceTrackedChanges.length ? (
                <div className="empty-state source-revision-handoff" role="status" aria-label="Source revisions use document pane">
                  {labelCount(sourceTrackedChanges.length, "source revision") ?? "Source revisions"} ready in the document pane.
                </div>
              ) : visibleSuggestions.length === 0 ? (
                emptyAiResult && suggestions.length === 0 ? (
                  <div className="empty-state recovery-state" role="status" aria-label="No reviewable AI suggestions">
                    <strong>{emptyAiResultTitle(emptyAiResult)}</strong>
                    <span>{truncate(emptyAiRecoveryMessage, 220)}</span>
                    <small className="empty-state-order-hint">
                      Usually worth trying in this order: refine the prompt first{timeoutAlternateProvider ? ", then the other provider" : ""}; run the smoke test if nothing works (it checks the CLI setup itself).
                    </small>
                    <div className="empty-state-actions">
                      <button type="button" onClick={refineEmptyAiResult}>{emptyAiResultRetryLabel(emptyAiResult)}</button>
                      {timeoutAlternateProvider ? (
                        <button
                          type="button"
                          onClick={() => retryEmptyAiResultWithProvider(timeoutAlternateProvider)}
                        >
                          Try {providerLabel(timeoutAlternateProvider)}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => void handleProviderSmokeTest()} disabled={busy !== null}>Smoke test</button>
                    </div>
                  </div>
                ) : (
                  <div className="empty-state">
                    {suggestions.length === 0
                      ? "Suggested edits will appear here as reviewable cards."
                      : reviewSearchActive
                        ? "No changes match this search."
                      : reviewFilter === "latest"
                        ? "No pending edits from latest export."
                        : reviewFilter === "clean"
                          ? "No clean packet suggestions are ready."
                        : reviewFilter === "conflicts"
                          ? "No pending suggestions compete for the same exact original text."
                        : reviewFilter === "source-moved"
                          ? "No pending suggestions have missing original text."
                        : reviewFilter === "source-revisions"
                          ? "No source tracked-change previews are available."
                        : reviewFilter === "word-comments"
                          ? "No pending Word comment handoff edits from the latest export."
                        : "No pending edits."}
                  </div>
                )
	              ) : visibleSuggestions.map((suggestion) => {
	                const exportDisposition = exportDispositionForSuggestion(latestExportDispositionReport, suggestion);
	                const sharedRunDisposition = sharedRunDispositionForSuggestion(sharedRunSuggestionDispositions, suggestion);
	                const lengthWarning = suggestionLengthWarning(suggestion);
	                const conflictWarning = suggestionAnchorConflictWarning(suggestion, pendingSuggestionAnchorCounts, pendingSuggestionAnchorPositions);
	                const wordCommentOverlapGroupSize = wordCommentOverlapGroupSizeBySuggestionId.get(suggestion.id) ?? 0;
	                const wordCommentOverlapGroup = wordCommentOverlapGroupBySuggestionId.get(suggestion.id) ?? [];
	                const wordCommentOverlapGroupTitleSummary = wordCommentOverlapGroupTitleSummaryBySuggestionId.get(suggestion.id) ?? "";
	                const anchorVisibilityWarning = manualMissingTargetSuggestionIdSet.has(suggestion.id)
	                  ? manualMissingTargetWarning()
	                  : sharedRunDisposition && sharedRunDispositionHasReviewCoverage(sharedRunDisposition)
	                    ? null
	                    : suggestionAnchorVisibilityWarning(suggestion, normalizedCurrentDocumentText);
	                return (
                <article
                  ref={(element) => {
                    if (element) {
                      suggestionCardRefs.current.set(suggestion.id, element);
                    } else {
                      suggestionCardRefs.current.delete(suggestion.id);
                    }
                  }}
                  key={suggestion.id}
                  className={`suggestion ${suggestion.status} ${activeSuggestionId === suggestion.id ? "located" : ""}`}
                  role={suggestion.status === "pending" ? "button" : undefined}
                  tabIndex={suggestion.status === "pending" ? 0 : undefined}
                  aria-label={suggestion.status === "pending" ? `Jump to proposed change: ${suggestion.title}` : undefined}
                  aria-current={activeSuggestionId === suggestion.id ? "true" : undefined}
                  onMouseDown={recordReviewNavigationPointerDown(reviewNavigationPointerDownRef)}
                  onClick={(event) => {
                    if (suggestion.status === "pending" && !shouldIgnoreReviewNavigationClick(event, reviewNavigationPointerDownRef)) {
                      jumpToSuggestion(suggestion);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (suggestion.status !== "pending") {
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      jumpToSuggestion(suggestion);
                    }
                  }}
                >
                  <div className="suggestion-topline">
                    <h3>{suggestion.title}</h3>
                    <div className="suggestion-badges">
                      {sharedRunDisposition ? (
                        <span
                          className={`shared-run-disposition ${sharedRunDisposition.kind}`}
                          title={sharedRunDisposition.title}
                        >
                          {sharedRunDisposition.label}
                        </span>
                      ) : null}
                      {exportDisposition ? (
                        <span
                          className={`export-disposition ${exportDisposition.kind}`}
                          title={exportDisposition.title}
                        >
                          {exportDisposition.label}
                        </span>
                      ) : null}
                      {lengthWarning ? (
                        <span className="suggestion-warning" title={lengthWarning.title}>
                          {lengthWarning.label}
                        </span>
                      ) : null}
                      {conflictWarning ? (
                        <span className="suggestion-warning anchor-conflict" title={conflictWarning.title}>
                          {conflictWarning.label}
                        </span>
                      ) : null}
                      {anchorVisibilityWarning ? (
                        <span className="suggestion-warning source-moved" title={anchorVisibilityWarning.title}>
                          {anchorVisibilityWarning.label}
                        </span>
                      ) : null}
                      {wordCommentOverlapGroupSize > 1 ? (
                        <span
                          className="suggestion-warning word-comment-overlap"
                          title={`${labelCount(wordCommentOverlapGroupSize, "same-source Word comment")} target this original text; choose one winner before manual insertion.${wordCommentOverlapGroupTitleSummary ? ` Competing titles: ${wordCommentOverlapGroupTitleSummary}.` : ""}`}
                        >
                          Same source {wordCommentOverlapGroupSize}
                        </span>
                      ) : null}
                      {suggestion.commentOnly && exportDisposition?.kind !== "commented" ? (
                        <span
                          className="suggestion-warning comment-only"
                          title="Prepared as a Word comment to preserve equations, citation fields, or protected DOCX structure; it will not be applied as a body tracked change automatically."
                        >
                          Word comment
                        </span>
                      ) : null}
                      <span
                        className={`confidence-badge confidence-${confidenceBucket(suggestion.confidence)}`}
                        title={`The provider rated this edit ${Math.round(Math.max(0, Math.min(1, suggestion.confidence)) * 100)}% safe — its own estimate, not a guarantee. Always check the highlighted text before accepting.`}
                      >
                        {confidenceBucketLabel(suggestion.confidence)}
                      </span>
                    </div>
                  </div>
                  {(() => {
                    const segments = wordDiffSegments(suggestion.original, suggestion.replacement);
                    if (!segments) {
                      return (
                        <div className="diff-block">
                          <p className="original">{suggestion.original}</p>
                          <p className="replacement">{suggestion.replacement}</p>
                        </div>
                      );
                    }
                    return (
                      <div className="diff-block">
                        <p className="diff-inline">
                          {segments.map((segment, index) => segment.type === "same"
                            ? <span key={index}>{segment.text}</span>
                            : segment.type === "del"
                              ? <del key={index}>{segment.text}</del>
                              : <ins key={index}>{segment.text}</ins>)}
                        </p>
                        <details className="diff-raw">
                          <summary>Original and replacement</summary>
                          <p className="original">{suggestion.original}</p>
                          <p className="replacement">{suggestion.replacement}</p>
                        </details>
                      </div>
                    );
                  })()}
                  <p className="rationale">{reviewQueueDisplayText(suggestion.rationale)}</p>
                  {suggestion.proposedBy && suggestion.proposedBy !== collabSession.user.name ? (
                    <p className="suggestion-decision">Proposed by {suggestion.proposedBy}</p>
                  ) : null}
                  {suggestion.status !== "pending" && (suggestion.decidedBy || suggestion.decidedAt) ? (
                    <p className="suggestion-decision">
                      {suggestion.status === "accepted"
                        ? "Accepted"
                        : suggestion.decidedBy && suggestion.decidedBy === suggestion.proposedBy
                          ? "Withdrawn"
                          : "Rejected"}
                      {suggestion.decidedBy ? ` by ${suggestion.decidedBy}` : ""}
                      {suggestion.decidedAt ? ` · ${formatDecisionTime(suggestion.decidedAt)}` : ""}
                      {suggestion.decidedBy === collabSession.user.name ? (
                        <button
                          type="button"
                          className="decision-note-button"
                          onClick={() => addSuggestionDecisionNote(suggestion)}
                          title="Add a short note explaining this decision (visible to collaborators and to the agent's next round)"
                          aria-label={`Add decision note for: ${suggestion.title}`}
                        >
                          {suggestion.decisionNote ? "Edit note" : "+ Note"}
                        </button>
                      ) : null}
                    </p>
                  ) : null}
                  {suggestion.decisionNote ? (
                    <p className="suggestion-decision-note" title="Decision note — agents read this as feedback for their next proposal round.">
                      “{suggestion.decisionNote}”
                    </p>
                  ) : null}
                  <div className="suggestion-actions">
	                    <button
	                      type="button"
	                      onClick={(event) => {
	                        event.stopPropagation();
	                        copySuggestionReplacement(suggestion);
	                      }}
	                    >
	                      <Copy size={16} aria-hidden="true" /> Copy proposed
	                    </button>
	                    {wordCommentOverlapGroup.length > 1 ? (
	                      <button
	                        type="button"
	                        title="Copy every Word comment that targets this same source text"
	                        onClick={(event) => {
	                          event.stopPropagation();
	                          copyWordCommentOverlapGroup(suggestion, wordCommentOverlapGroup);
	                        }}
	                      >
	                        <Copy size={16} aria-hidden="true" /> Copy group
	                      </button>
	                    ) : null}
	                    {wordCommentOverlapGroup.length > 1 ? (
	                      <button
	                        type="button"
	                        title="Reject the other pending Word comments that target this same source text"
	                        onClick={(event) => {
	                          event.stopPropagation();
	                          rejectWordCommentOverlapAlternatives(suggestion, wordCommentOverlapGroup);
	                        }}
	                        disabled={suggestion.status !== "pending"}
	                      >
	                        <X size={16} aria-hidden="true" /> Reject others
	                      </button>
	                    ) : null}
	                    {suggestion.status === "pending" ? (
	                      <>
	                        <button
	                          type="button"
	                          onClick={(event) => {
	                            event.stopPropagation();
	                            acceptSuggestion(suggestion);
	                          }}
	                        >
	                          <Check size={16} aria-hidden="true" /> Accept
	                        </button>
	                        <button
	                          type="button"
	                          onClick={(event) => {
	                            event.stopPropagation();
	                            rejectSuggestion(suggestion);
	                          }}
	                        >
	                          <X size={16} aria-hidden="true" /> Reject
	                        </button>
	                        <button
	                          type="button"
	                          title="Put this proposal into the document as an inline suggestion (strikethrough + insertion) that anyone can accept or reject"
	                          onClick={(event) => {
	                            event.stopPropagation();
	                            markSuggestionInline(suggestion);
	                          }}
	                        >
	                          <FilePenLine size={16} aria-hidden="true" /> Mark inline
	                        </button>
	                      </>
	                    ) : suggestion.status === "accepted" ? (
	                      <button
	                        type="button"
	                        title="Put the original text back and return this suggestion to the pending queue"
	                        onClick={(event) => {
	                          event.stopPropagation();
	                          undoAcceptedSuggestion(suggestion);
	                        }}
	                      >
	                        <Undo2 size={16} aria-hidden="true" /> Undo accept
	                      </button>
	                    ) : (
	                      <button
	                        type="button"
	                        title="Return this rejected suggestion to the pending queue"
	                        onClick={(event) => {
	                          event.stopPropagation();
	                          restoreRejectedSuggestion(suggestion);
	                        }}
	                      >
	                        <Undo2 size={16} aria-hidden="true" /> Restore
	                      </button>
	                    )}
	                    {copiedSuggestionId === suggestion.id ? (
	                      <small>Proposed text copied</small>
	                    ) : null}
	                    {copiedOverlapGroupSuggestionId === suggestion.id ? (
	                      <small>Comment alternative group copied</small>
	                    ) : null}
	                  </div>
                </article>
                );
              })}
            </div>
          </div>
        </aside>
      </div>

      <section className="status-bar" aria-label="Document status">
        {sharedSessionIsDifferentDocument && sharedSession ? (
          <button
            type="button"
            data-testid="load-shared-session"
            className="session-sync-pill"
            onClick={() => void handleLoadSharedSession()}
            disabled={busy !== null}
            aria-label={`Load shared Writer session: ${sharedSession.name}`}
            title={`Load ${sharedSession.name} from the agent/shared Writer session`}
          >
            <RefreshCw size={15} aria-hidden="true" /> Load shared session: {truncate(sharedSession.name, 34)}
          </button>
        ) : null}
        {!sharedSessionIsDifferentDocument && sharedSuggestionChanges > 0 && sharedSession ? (
          <button
            type="button"
            className="session-sync-pill"
            onClick={handleSyncSharedSuggestions}
            disabled={busy !== null}
            aria-label={`Sync ${sharedSuggestionChanges} agent suggestion${sharedSuggestionChanges === 1 ? "" : "s"}`}
            title="Sync review queue from the shared Writer session"
          >
            <RefreshCw size={15} aria-hidden="true" /> Sync {sharedSuggestionChanges} agent suggestion{sharedSuggestionChanges === 1 ? "" : "s"}
          </button>
        ) : null}
        {docxBodySafeAnchorDetails.length && thinBodySafeAimSections.length ? (
          <button
            type="button"
            className="status-action-pill"
            onClick={useThinAimBodySafePrompt}
            disabled={busy !== null}
            aria-label={`Load clean-source prompt for thin Aim coverage: ${thinBodySafeAimSections.join(", ")}`}
            title={`${formatBodySafeAnchorStatusTitle(docxBodySafeAnchorDetails)} Click to load a narrow tracked-change-safe prompt for sections that have few clean source-text samples.`}
          >
            <LocateFixed size={15} aria-hidden="true" /> {formatBodySafeAnchorStatus(docxBodySafeAnchorDetails)}
          </button>
        ) : null}
        {milestonesBodySafeAnchors.length ? (
          <button
            type="button"
            className="status-action-pill"
            onClick={useMilestonesPayoffBodySafePrompt}
            disabled={busy !== null || !uncoveredMilestonesBodySafeAnchors.length}
            aria-label="Load clean-source milestones payoff prompt"
            title={uncoveredMilestonesBodySafeAnchors.length
              ? `Load a narrow tracked-change-safe prompt using ${labelCount(uncoveredMilestonesBodySafeAnchors.length, "Expected Milestones and Impact clean source-text sample")}.`
              : "All Expected Milestones and Impact clean source-text samples already have pending suggestions."}
          >
            <Sparkles size={15} aria-hidden="true" /> Milestones payoff: {uncoveredMilestonesBodySafeAnchors.length ? labelCount(uncoveredMilestonesBodySafeAnchors.length, "sample") : "all covered"}
          </button>
        ) : null}
        {languagePolishBodySafeAnchors.length ? (
          <button
            type="button"
            className="status-action-pill"
            onClick={useLanguagePolishBodySafePrompt}
            disabled={busy !== null || !uncoveredLanguagePolishBodySafeAnchors.length}
            aria-label="Load clean-source language polish prompt"
            title={uncoveredLanguagePolishBodySafeAnchors.length
              ? formatLanguagePolishStatusTitle(uncoveredLanguagePolishBodySafeAnchors)
              : "All language-polish clean source-text samples already have pending suggestions."}
          >
            <Sparkles size={15} aria-hidden="true" /> Language polish: {uncoveredLanguagePolishBodySafeAnchors.length ? labelCount(uncoveredLanguagePolishBodySafeAnchors.length, "sample") : "all covered"}
          </button>
        ) : null}
        {verificationNotes.length ? (
          <button
            type="button"
            className="status-action-pill"
            onClick={useVerificationHandoffPrompt}
            disabled={busy !== null}
            aria-label={`Load VERIFY fact-check handoff prompt for ${labelCount(verificationNotes.length, "note")}`}
            title={`The document contains [VERIFY ...] markers — facts someone on the proposal team must confirm before submission. Click to load a prompt that turns each marker into a Word-comment handoff for review. Notes: ${truncate(verificationNotes.join("; "), 180)}`}
          >
            <Search size={15} aria-hidden="true" /> Fact checks: {labelCount(verificationNotes.length, "note")}
          </button>
        ) : null}
        {providerCheck ? (
          <span className={providerCheck.ok ? "success-pill" : "warning-pill"} title={providerCheck.message}>
            <Activity size={15} aria-hidden="true" /> {providerLabel(providerCheck.provider)} smoke {providerCheck.ok ? "passed" : "needs setup"}
          </span>
        ) : null}
        {pendingSuggestions.length ? (
          <span><PanelRight size={15} aria-hidden="true" /> {pendingSuggestions.length} pending suggestion{pendingSuggestions.length === 1 ? "" : "s"}</span>
        ) : null}
        {browserTrackedReviewExportCount > 0 ? (
          <span title="Review export queue includes pending AI suggestions plus browser-tracked accepted/user edits.">
            <FilePenLine size={15} aria-hidden="true" /> {reviewExportCandidateCount} review export item{reviewExportCandidateCount === 1 ? "" : "s"}
          </span>
        ) : null}
        {syncOutage ? (
          <span className="warning-pill" title="The document service has stopped answering (server outage or an exhausted hosting quota). Text edits keep applying in this tab and merge when service returns; chat and review syncing are paused. Retrying automatically.">
            <Loader2 size={15} aria-hidden="true" /> Document service unreachable — edits safe, retrying
          </span>
        ) : null}
        {collabConnection && collabConnection !== "connected" ? (
          <span className="warning-pill" title="The live-sync connection dropped. Your edits keep applying locally and will merge automatically when the connection returns.">
            <Loader2 size={15} aria-hidden="true" /> {collabConnection === "connecting" ? "Connecting live sync" : `Reconnecting — edits will sync`}
          </span>
        ) : null}
        {busy ? <span className="busy-pill"><Loader2 size={15} aria-hidden="true" /> {busy}{busy === "Asking AI" && aiProgressNote ? ` — ${aiProgressNote}` : ""}</span> : null}
        {!busy && remoteAiProgress ? (
          <span className="busy-pill" title="An AI request started by a collaborator or agent is running on the shared session.">
            <Loader2 size={15} aria-hidden="true" /> {providerLabel(remoteAiProgress.provider as InteractiveProviderName)} working — {remoteAiProgress.stage}
          </span>
        ) : null}
        {aiRequestBlocked ? (
          <span className="warning-pill">
            {cloudAiOffline
              ? "AI offline — no local Writer connected"
              : aiSetupReason === "sidecar-down"
                ? "Writer sidecar not running"
                : selectedProviderStatus?.available === false
                  ? "CLI not found on PATH"
                  : "CLI locked by WRITER_ALLOW_CLI=0"}
          </span>
        ) : null}
        {acceptedSuggestionCount > 0 ? (
          <span className="success-pill" title="Accepted AI suggestions from the shared session; review DOCX export writes them as Word tracked changes. Your own edits are tracked as inline suggestions when you write in Suggesting mode.">
            <FilePenLine size={15} aria-hidden="true" /> {acceptedSuggestionCount} accepted AI edit{acceptedSuggestionCount === 1 ? "" : "s"}
          </span>
        ) : null}
        {suggestionSyncFailureCount > 0 ? (
          <button
            type="button"
            className="warning-pill sync-retry-pill"
            onClick={() => void retryFailedSuggestionSyncs()}
            disabled={suggestionSyncRetrying}
            title="These accept/reject decisions are saved in this tab but could not reach the sidecar, so agents and other tabs will not see them until the sync succeeds."
          >
            <RefreshCw size={15} aria-hidden="true" /> {suggestionSyncFailureCount} suggestion decision{suggestionSyncFailureCount === 1 ? "" : "s"} not synced — {suggestionSyncRetrying ? "retrying..." : "retry"}
          </button>
        ) : null}
        {error ? <span className="error-pill">{error}</span> : null}
      </section>

      {documentNote ? (
        <div className="note-toast" role="status" aria-live="polite">
          <FileText size={14} aria-hidden="true" />
          <span title={documentNoteDetail || undefined}>{documentNote}</span>
        </div>
      ) : null}

      {setupGuideOpen ? (
        <div className="setup-overlay" role="presentation" onClick={dismissSetupGuide}>
          <div
            className="setup-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Set up AI for this Writer"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="setup-dialog-heading">
              <strong>Set up AI for this Writer</strong>
              <button type="button" onClick={dismissSetupGuide} aria-label="Close setup guide">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            {cloudMode ? (
              <>
                {inSafari ? (
                  <div className="setup-safari-notice">
                    <strong>You're in Safari — AI can't connect in this browser.</strong>
                    <span>
                      Safari blocks web pages from reaching the Writer on your own machine. Editing, chat,
                      and review still work here, but for AI open this document in Chrome, Edge, or Firefox:
                    </span>
                    <SetupCommand command={linkForOtherBrowser} onCopied={setDocumentNote} />
                  </div>
                ) : null}
                <p>
                  Documents, chat, and review already sync in this browser. AI suggestions run on a real
                  machine — yours. One-time setup, on any computer with the Codex or Claude CLI:
                </p>
                {localWriterSetupSteps}
                <p>
                  Come back to this tab — it detects your sidecar within ~20 seconds (or instantly when
                  you refocus the tab) and the provider pill flips to "CLI ready — your local Writer".
                  Your edits, chat, and AI all run on <strong>your own</strong> Claude/Codex — nobody
                  else's account is ever used.
                </p>
                <small>
                  Use Chrome, Edge, or Firefox — not Safari (it blocks pages from reaching your local
                  Writer). The first time, Chrome may ask to <strong>allow access to your local
                  network</strong> so this page can reach your sidecar on 127.0.0.1 — click Allow.
                  Reopen this guide any time via "Set up AI" in the chat panel.
                </small>
              </>
            ) : aiSetupReason === "sidecar-down" && isLocalHost ? (
              <>
                <p>
                  The Writer's local sidecar isn't reachable, and AI, sessions, and DOCX all run
                  through it. The web app you're looking at is already running — just start the
                  sidecar alongside it, from the repo:
                </p>
                <ol className="setup-steps">
                  <li>
                    <span>Start the sidecar:</span>
                    <SetupCommand command="npm run sidecar" onCopied={setDocumentNote} />
                  </li>
                </ol>
                <p>
                  This page re-checks every ~20 seconds (or instantly when you refocus the tab) and
                  lights up on its own once the sidecar answers.
                </p>
                <small>
                  Starting completely fresh (no web app running either)? <code>npm run dev:all</code>{" "}
                  launches the sidecar and the web app together.
                </small>
              </>
            ) : aiSetupReason === "sidecar-down" ? (
              <>
                <p>
                  This Writer is hosted, and AI, sessions, and DOCX run through a Writer on a real
                  machine — yours — which this page can't reach right now. Stand one up from scratch:
                </p>
                {localWriterSetupSteps}
                <p>
                  Come back to this tab — it re-checks every ~20 seconds (or instantly when you
                  refocus the tab) and connects on its own once your sidecar answers.
                </p>
                <small>
                  Already running a Writer? Make sure it was started with{" "}
                  <code>WRITER_ALLOWED_ORIGINS={typeof window !== "undefined" ? window.location.origin : "<this origin>"}</code>{" "}
                  so this page is allowed to reach it, and reopen this guide any time via "Set up AI".
                </small>
              </>
            ) : aiSetupReason === "cli-locked" ? (
              <>
                <p>
                  This sidecar was started with CLI execution locked (<code>WRITER_ALLOW_CLI=0</code>),
                  so AI requests are disabled. Restart it without the lock:
                </p>
                <ol className="setup-steps">
                  <li>
                    <span>Stop the running sidecar, then start it unlocked:</span>
                    <SetupCommand command="npm run sidecar" onCopied={setDocumentNote} />
                  </li>
                </ol>
                <p>This page picks the change up within ~20 seconds of the restart.</p>
              </>
            ) : (
              <>
                <p>
                  AI suggestions run through a coding CLI on this machine, and nothing meaningful
                  works without one. Install and sign in to either — your own account is used:
                </p>
                <div className="setup-provider-list">
                  {(["codex", "claude"] as const).map((name) => {
                    const status = healthForAi?.providerStatus?.find((candidate) => candidate.name === name);
                    const ready = status?.available === true;
                    return (
                      <div key={name} className={`setup-provider${ready ? " ready" : ""}`}>
                        <strong>
                          {providerLabel(name)}
                          {ready ? " — ready" : ""}
                        </strong>
                        {ready ? (
                          <span>{status?.detail}</span>
                        ) : (
                          <>
                            <SetupCommand
                              command={name === "codex" ? "npm install -g @openai/codex" : "npm install -g @anthropic-ai/claude-code"}
                              onCopied={setDocumentNote}
                            />
                            <span>
                              then sign in once: <code>{name === "codex" ? "codex login" : "claude"}</code>
                            </span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p>
                  Only one is needed. This page re-checks every ~20 seconds (or instantly when you
                  refocus the tab) — once a CLI is signed in, the provider pill flips to ready.
                </p>
                <small>
                  Already installed but not detected? The sidecar searches its own PATH — point{" "}
                  <code>WRITER_CODEX_PATH</code> or <code>WRITER_CLAUDE_PATH</code> at the binary and
                  restart the sidecar. Reopen this guide any time via "Set up AI" in the chat panel.
                </small>
              </>
            )}
            <div className="setup-dialog-actions">
              <button type="button" onClick={dismissSetupGuide}>Got it</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function confidenceBucket(confidence: number): "high" | "medium" | "low" {
  if (!Number.isFinite(confidence)) {
    return "low";
  }
  if (confidence >= 0.85) {
    return "high";
  }
  return confidence >= 0.6 ? "medium" : "low";
}

function confidenceBucketLabel(confidence: number): string {
  const bucket = confidenceBucket(confidence);
  return bucket === "high" ? "High" : bucket === "medium" ? "Med" : "Low";
}

function formatDecisionTime(isoTimestamp: string): string {
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function describeError(prefix: string, error: unknown, fallback: string): string {
  const message = error instanceof Error && error.message ? error.message : fallback;
  return `${prefix}: ${message}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function editorTrackedChangeTitle(source: EditorTrackedChangeSource, kind: EditorTrackedChangeKind): string {
  return `${editorTrackedChangeSourceLabel(source)} ${editorTrackedChangeKindLabel(kind)}`;
}

function editorTrackedChangeTraceTitle(kind: EditorTrackedChangeKind, original: string, replacement: string): string {
  const snippet = truncate(normalizeText(replacement || original), 90);
  return `${editorTrackedChangeKindLabel(kind)}${snippet ? `: ${snippet}` : ""}`;
}

function editorTrackedChangeSourceLabel(source: EditorTrackedChangeSource): string {
  return source === "ai" ? "AI" : "User";
}

function editorTrackedChangeToSuggestion(change: EditorTrackedChange): AiSuggestion | null {
  // Prefer the word/sentence-expanded anchor: it locates the edit reliably in
  // the source DOCX, and it lets pure insertions (raw original is empty)
  // export as replacements of their surrounding context.
  const original = change.anchorOriginal?.trim() ? change.anchorOriginal : change.original;
  const replacement = change.anchorOriginal?.trim() ? (change.anchorReplacement ?? change.replacement) : change.replacement;
  if (!original.trim() || normalizeText(original) === normalizeText(replacement)) {
    return null;
  }

  return {
    id: `${change.id}-review-export`,
    title: change.title,
    original,
    replacement,
    rationale: `${editorTrackedChangeSourceLabel(change.source)} browser-tracked edit captured for Word review export.`,
    confidence: 1,
    target: "global",
    range: {
      from: change.from,
      to: change.to,
      text: original
    },
    status: "pending",
    proposedBy: change.author ?? null
  };
}

function isAiSuggestion(value: AiSuggestion | null): value is AiSuggestion {
  return value !== null;
}

function mergeReviewExportSuggestions(pendingSuggestions: AiSuggestion[], trackedSuggestions: AiSuggestion[]): AiSuggestion[] {
  const seenIds = new Set<string>();
  const seenChanges = new Set<string>();
  return [...pendingSuggestions, ...trackedSuggestions].filter((suggestion) => {
    const changeKey = `${normalizeText(suggestion.original)}\u0000${normalizeText(suggestion.replacement)}`;
    if (seenIds.has(suggestion.id) || seenChanges.has(changeKey)) {
      return false;
    }
    seenIds.add(suggestion.id);
    seenChanges.add(changeKey);
    return true;
  });
}

function routineRunSuggestions(run: WriterRoutineRun | null, suggestions: AiSuggestion[]): AiSuggestion[] {
  if (!run?.report) {
    return [];
  }
  const ids = new Set([
    ...(run.report.matchedSuggestionIds ?? []),
    ...(run.report.commentedSuggestionIds ?? []),
    ...(run.report.unmatchedSuggestionIds ?? [])
  ]);
  if (ids.size > 0) {
    return suggestions.filter((suggestion) => ids.has(suggestion.id));
  }
  const titles = new Set([
    ...(run.report.matchedSuggestionTitles ?? []),
    ...(run.report.commentedSuggestionTitles ?? []),
    ...(run.report.unmatchedSuggestionTitles ?? [])
  ]);
  if (titles.size === 0) {
    return [];
  }
  return suggestions.filter((suggestion) => titles.has(suggestion.title));
}

function routineRunWordCommentSuggestions(run: WriterRoutineRun | null, runSuggestions: AiSuggestion[]): AiSuggestion[] {
  if (!run?.report) {
    return [];
  }
  return runSuggestions.filter((suggestion) => reportListIncludes(
    run.report?.commentedSuggestionIds ?? [],
    run.report?.commentedSuggestionTitles ?? [],
    suggestion
  ));
}

function sharedRunSuggestionDispositionMap(runs: WriterRoutineRun[]): Map<string, SharedRunSuggestionDisposition> {
  const dispositions = new Map<string, SharedRunSuggestionDisposition>();
  runs.forEach((run, index) => {
    if (!run.report) {
      return;
    }
    const baseDisposition: Omit<SharedRunSuggestionDisposition, "placement"> = {
      kind: index === 0 ? "latest" : "recent",
      label: index === 0 ? "Latest export" : "Recent export",
      title: index === 0
        ? `Included in the latest shared review export: ${run.label}`
        : `Included in a recent shared review export: ${run.label}`
    };
    const exportLabel = index === 0 ? "latest shared review export" : "recent shared review export";
    const setDisposition = (key: string, disposition: SharedRunSuggestionDisposition) => {
      if (!dispositions.has(key)) {
        dispositions.set(key, disposition);
      }
    };
    const trackedDisposition: SharedRunSuggestionDisposition = {
      ...baseDisposition,
      placement: "tracked",
      title: `Tracked in the ${exportLabel}: ${run.label}`
    };
    const unresolvedDisposition: SharedRunSuggestionDisposition = {
      ...baseDisposition,
      placement: "unresolved",
      title: `Unresolved in the ${exportLabel}: ${run.label}. Refine or retarget before relying on this export.`
    };
    const matchedIds = run.report.matchedSuggestionIds ?? [];
    const unmatchedIds = run.report.unmatchedSuggestionIds ?? [];
    const commentedIds = run.report.commentedSuggestionIds ?? [];
    matchedIds.forEach((id) => setDisposition(`id:${id}`, trackedDisposition));
    if (matchedIds.length === 0) {
      (run.report.matchedSuggestionTitles ?? []).forEach((title) => setDisposition(`title:${title}`, trackedDisposition));
    }
    unmatchedIds.forEach((id) => setDisposition(`id:${id}`, unresolvedDisposition));
    if (unmatchedIds.length === 0) {
      (run.report.unmatchedSuggestionTitles ?? []).forEach((title) => setDisposition(`title:${title}`, unresolvedDisposition));
    }
    const commentedReasons = run.report.commentedSuggestionReasons ?? [];
    commentedIds.forEach((id, reasonIndex) => {
      setDisposition(`id:${id}`, sharedRunWordCommentDisposition(baseDisposition, exportLabel, run.label, commentedReasons[reasonIndex] ?? commentedReasons[0]));
    });
    if (commentedIds.length === 0) {
      (run.report.commentedSuggestionTitles ?? []).forEach((title, reasonIndex) => {
        setDisposition(`title:${title}`, sharedRunWordCommentDisposition(baseDisposition, exportLabel, run.label, commentedReasons[reasonIndex] ?? commentedReasons[0]));
      });
    }
  });
  return dispositions;
}

function sharedRunWordCommentDisposition(
  baseDisposition: Omit<SharedRunSuggestionDisposition, "placement">,
  exportLabel: string,
  runLabel: string,
  reason?: string
): SharedRunSuggestionDisposition {
  return {
    ...baseDisposition,
    placement: "commented",
    title: reason
      ? `Preserved as a Word comment in the ${exportLabel}: ${runLabel}. ${formatPlacementReasonForDisplay(reason)}`
      : `Preserved as a Word comment in the ${exportLabel}: ${runLabel}.`
  };
}

function sharedRunDispositionForSuggestion(dispositions: Map<string, SharedRunSuggestionDisposition>, suggestion: AiSuggestion): SharedRunSuggestionDisposition | null {
  return dispositions.get(`id:${suggestion.id}`) ?? dispositions.get(`title:${suggestion.title}`) ?? null;
}

function sharedRunDispositionHasReviewCoverage(disposition: SharedRunSuggestionDisposition): boolean {
  return disposition.placement !== "unresolved";
}

export function suggestionForClickedBlockText(blockText: string, suggestions: AiSuggestion[]): AiSuggestion | null {
  const normalizedBlock = normalizeText(blockText);
  if (normalizedBlock.length < 24) {
    return null;
  }
  return suggestions.find((suggestion) => {
    const normalizedOriginal = normalizeText(suggestion.original);
    if (normalizedOriginal.length < 24) {
      return false;
    }
    return normalizedBlock.includes(normalizedOriginal) || normalizedOriginal.includes(normalizedBlock);
  }) ?? null;
}

function suggestionForReviewTraceTarget(target: EventTarget | null, suggestions: AiSuggestion[]): AiSuggestion | null {
  const traceElement = target instanceof Element ? target.closest<HTMLElement>("[data-review-trace]") : null;
  const traceId = traceElement?.dataset.reviewTrace;
  if (!traceId) {
    return null;
  }
  return suggestions.find((suggestion) => suggestion.id === traceId) ?? null;
}

function editorTextBlockAtPosition(editor: Editor, position: number): string {
  const boundedPosition = Math.max(0, Math.min(position, editor.state.doc.content.size));
  const resolved = editor.state.doc.resolve(boundedPosition);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth);
    if (node.isTextblock) {
      return node.textBetween(0, node.content.size, " ");
    }
  }
  return "";
}

function editorTrackedChangeKindLabel(kind: EditorTrackedChangeKind): string {
  switch (kind) {
    case "delete":
      return "deleted";
    case "replace":
      return "replaced";
    default:
      return "inserted";
  }
}

function editorTrackedChangeSnippet(change: EditorTrackedChange): string {
  if (change.kind === "delete") {
    return normalizeText(change.original) || "deleted text";
  }
  if (change.kind === "replace") {
    return `${normalizeText(change.original)} -> ${normalizeText(change.replacement)}`;
  }
  return normalizeText(change.replacement) || "inserted text";
}

function editorTextSnapshot(editor: Editor): { positions: number[]; text: string } {
  let text = "";
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) {
      return;
    }
    for (let index = 0; index < node.text.length; index += 1) {
      const char = node.text[index];
      // contenteditable stores a trailing space as NBSP and silently converts
      // it back to a plain space once more text follows. Normalize so the
      // user-edit diff sees typing " B" as two inserts, not an insert plus a
      // whitespace "replace" — that phantom replace fragmented one typing
      // burst into three tracked-change chips.
      text += char === "\u00a0" ? " " : char;
      positions.push(pos + index);
    }
  });
  return { positions, text };
}

interface ImportFidelityNotice {
  level: "info" | "warning";
  text: string;
}

function fidelityNoticesFromImportMessages(messages: string[]): ImportFidelityNotice[] {
  const notices = messages.flatMap((message) => {
    const match = /^(warning|info):\s*(.*)$/i.exec(message.trim());
    return match && match[2] ? [{ level: match[1].toLowerCase() as "info" | "warning", text: match[2] }] : [];
  });
  return [
    ...notices.filter((notice) => notice.level === "warning"),
    ...notices.filter((notice) => notice.level === "info")
  ];
}

function editorRangeFromTextOffsets(snapshot: { positions: number[] }, start: number, end: number): { from: number; to: number } | null {
  if (end <= start) {
    return null;
  }
  const from = snapshot.positions[start];
  const last = snapshot.positions[end - 1];
  return from !== undefined && last !== undefined ? { from, to: last + 1 } : null;
}

function editorPositionFromTextOffset(snapshot: { positions: number[] }, offset: number): number {
  if (!snapshot.positions.length) {
    return 1;
  }
  if (snapshot.positions[offset] !== undefined) {
    return snapshot.positions[offset];
  }
  if (offset > 0 && snapshot.positions[offset - 1] !== undefined) {
    return snapshot.positions[offset - 1] + 1;
  }
  return snapshot.positions[0];
}

function formatFeatureSummary(features: DocxFeatureSummary): string {
  const parts = featureSummaryParts(features);
  const preservingSummary = parts.length ? `Preserving ${parts.slice(0, 3).join(", ")}${parts.length > 3 ? "..." : ""}` : "Preserving DOCX structure";
  return features.trackedChanges > 0 ? `Showing accepted text; ${preservingSummary}` : preservingSummary;
}

function featureSummaryParts(features: DocxFeatureSummary): string[] {
  return [
    labelCount(features.formulas, "Word math formula"),
    labelCount(features.citationFields, "citation field"),
    labelCount(features.fields && !features.citationFields ? features.fields : 0, "field"),
    labelCount(features.contentControls, "content control"),
    labelCount(features.customXml, "custom XML wrapper"),
    labelCount(features.commentRanges, "comment"),
    labelCount(features.notes, "note"),
    labelCount(features.trackedChanges, "tracked change"),
    labelCount(features.tables, "table"),
    labelCount(features.images, "image"),
    labelCount(features.textBoxes, "text box"),
    labelCount(features.bibliographySections, "reference section"),
    labelCount(features.hyperlinks, "hyperlink"),
    labelCount(features.bookmarks, "bookmark")
  ].filter((part): part is string => Boolean(part));
}

function formatFeatureSummaryTitle(features: DocxFeatureSummary): string {
  const parts = featureSummaryParts(features);
  const detected = parts.length ? ` Detected: ${parts.join("; ")}.` : "";
  const trackedChangeNote = features.trackedChanges > 0
    ? " Existing tracked changes are shown as accepted text in the browser, but the source DOCX remains the review carrier."
    : "";
  if (features.trackedChanges > 0) {
    return `Preserving means Nebula detected Word-only structures and will keep them intact when exporting from the source DOCX.${trackedChangeNote}${detected}`;
  }
  return features.formulas > 0
    ? `Word math formulas are shown as protected browser previews; original equation XML is preserved in the source DOCX and review exports.${detected}`
    : `Preserving means Nebula detected Word-only structures and will keep them intact in source-based review exports.${detected}`;
}

function sourceTrackedChangeKindLabel(kind: SourceTrackedChangePreview["kind"]): string {
  if (kind === "inserted") {
    return "Inserted";
  }
  if (kind === "deleted") {
    return "Deleted";
  }
  return kind === "movedFrom" ? "Moved from" : "Moved to";
}

function sourceRevisionCanFocusAcceptedText(change: SourceTrackedChangePreview): boolean {
  return change.kind === "inserted" || change.kind === "movedTo";
}

function formatSourceTrackedChangeMeta(change: SourceTrackedChangePreview): string {
  return [
    change.author,
    change.date ? change.date.slice(0, 10) : null
  ].filter(Boolean).join(" | ");
}

function boundedPendingTraceCandidates(suggestions: AiSuggestion[], activeSuggestionId: string | null): AiSuggestion[] {
  if (suggestions.length <= maxAutomaticPendingReviewTraces) {
    return suggestions;
  }
  const activeSuggestion = activeSuggestionId
    ? suggestions.find((suggestion) => suggestion.id === activeSuggestionId)
    : null;
  const bounded = suggestions.slice(0, maxAutomaticPendingReviewTraces);
  return activeSuggestion && !bounded.some((suggestion) => suggestion.id === activeSuggestion.id)
    ? [activeSuggestion, ...bounded.slice(0, maxAutomaticPendingReviewTraces - 1)]
    : bounded;
}

function formatBodySafeAnchorStatus(details: DocxBodySafeAnchor[]): string {
  const counts = bodySafeAnchorSectionCounts(details);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (!total) {
    return "No clean source samples";
  }
  const thinAimSections = bodySafeThinAimSections(counts);
  return thinAimSections.length
    ? `${labelCount(total, "clean source sample")}; thin Aim coverage: ${thinAimSections.slice(0, 3).join(", ")}${thinAimSections.length > 3 ? "..." : ""}`
    : `${labelCount(total, "clean source sample")} across ${labelCount(counts.size, "section")}`;
}

function formatBodySafeAnchorStatusTitle(details: DocxBodySafeAnchor[]): string {
  const counts = bodySafeAnchorSectionCounts(details);
  if (!counts.size) {
    return "No DOCX-verified ordinary body text samples were detected for tracked-change-safe retries.";
  }
  const coverage = [...counts.entries()].map(([section, count]) => `${section}: ${count}`).join("; ");
  const thinAimSections = bodySafeThinAimSections(counts);
  const thinGuidance = thinAimSections.length
    ? ` Thin Aim coverage means edits in ${thinAimSections.join(", ")} may need narrower prompts or Word-comment handoff.`
    : "";
  return `Clean source-text samples are ordinary DOCX paragraphs that are safest for body tracked changes. Coverage by section: ${coverage}.${thinGuidance}`;
}

function formatProviderDetail(status: ProviderHealth, timeoutDetail?: string): string {
  return [
    status.overrideValue ? `${status.overrideEnv}=${status.overrideValue}` : null,
    status.path,
    status.version,
    timeoutDetail
  ].filter(Boolean).join(" ");
}

function formatAutosavedSessionTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  return date.toLocaleString([], {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short"
  });
}

function labelCount(count: number, label: string): string | null {
  if (!count) {
    return null;
  }
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function reviewBacklogPressureStatus(input: {
  conflictCount: number;
  conflictGroupCount?: number;
  dismissibleConflictCount?: number;
  latestPendingCount: number;
  pendingCount: number;
  representedConflictCount?: number;
  representedPendingCount?: number;
  sourceMovedCount: number;
  wordCommentCount: number;
}): ReviewBacklogStatus | null {
  if (input.pendingCount < reviewBacklogPressureThreshold) {
    return null;
  }
  const representedPendingCount = input.representedPendingCount ?? 0;
  const unrepresentedPendingCount = Math.max(0, input.pendingCount - representedPendingCount);
  const represented = representedPendingCount > 0
    ? `${labelCount(representedPendingCount, "pending edit") ?? "Pending edits"} already represented in review DOCX packets.`
    : null;
  const unrepresented = representedPendingCount > 0
    ? unrepresentedPendingCount > 0
      ? `${labelCount(unrepresentedPendingCount, "pending edit") ?? "Pending edits"} still need review-DOCX coverage.`
      : "No unrepresented pending edits remain."
    : null;
  const latest = input.latestPendingCount > 0
    ? `${labelCount(input.latestPendingCount, "latest-export edit") ?? "Latest-export edits"} available in the latest run.`
    : "No latest-export subset is available.";
  const representedConflictCount = Math.min(input.conflictCount, input.representedConflictCount ?? 0);
  const unrepresentedConflictCount = Math.max(0, input.conflictCount - representedConflictCount);
  const conflictGroupPhrase = input.conflictGroupCount && input.conflictGroupCount !== input.conflictCount
    ? ` across ${labelCount(input.conflictGroupCount, "shared target") ?? "shared targets"}`
    : "";
  const triageItems = [
    input.wordCommentCount > 0 ? labelCount(input.wordCommentCount, "Word-comment edit") : null,
    input.sourceMovedCount > 0 ? labelCount(input.sourceMovedCount, "missing-target edit") : null,
    input.conflictCount > 0 && representedConflictCount === 0 ? labelCount(input.conflictCount, "conflicting edit") : null
  ].filter(Boolean) as string[];
  const triageSentences = [
    triageItems.length ? `${formatPhraseList(triageItems)} need triage before another broad pass.` : null,
    representedConflictCount > 0
      ? `${labelCount(representedConflictCount, "represented conflicting edit") ?? "Represented conflicting edits"}${conflictGroupPhrase} already have review-DOCX coverage but still need one winner selected.`
      : null,
    unrepresentedConflictCount > 0 && representedConflictCount > 0
      ? `${labelCount(unrepresentedConflictCount, "unrepresented conflicting edit") ?? "Unrepresented conflicting edits"}${conflictGroupPhrase} still need review-DOCX coverage.`
      : null,
    (input.dismissibleConflictCount ?? 0) > 0
      ? `${labelCount(input.dismissibleConflictCount ?? 0, "non-winner alternative") ?? "Non-winner alternatives"} can be dismissed from the Conflicts tab.`
      : null
  ].filter(Boolean) as string[];
  const triage = triageSentences.length
    ? triageSentences.join(" ")
    : "Review or export current edits before another broad pass.";
  const headline = representedPendingCount > 0 && unrepresentedPendingCount === 0
    ? `Review DOCX coverage: ${labelCount(representedPendingCount, "represented edit") ?? "represented edits"}`
    : `Backlog: ${labelCount(input.pendingCount, "pending edit") ?? "pending edits"}`;
  return {
    headline,
    detail: [represented, unrepresented, latest, triage].filter(Boolean).join(" ")
  };
}

export function formatReviewBacklogClipboard(input: ReviewBacklogClipboardInput): string {
  return [
    "Nebula Writer review backlog",
    input.headline,
    input.detail,
    `Current filter: ${input.currentFilter}`,
    input.latestRunLabel ? `Latest run: ${input.latestRunLabel}` : null,
    input.latestArtifactPath ? `Latest artifact: ${input.latestArtifactPath}` : null
  ].filter(Boolean).join("\n");
}

function wordCommentReviewStatusForReport(report: ExportDispositionReport | null, wordCommentSuggestions: AiSuggestion[]): ReviewBacklogStatus | null {
  const wordCommentCount = wordCommentSuggestions.length;
  if (!report || wordCommentCount <= 0) {
    return null;
  }
  const titlePhrase = formatRoutineRunReportTitlePhrase(report.commentedSuggestionTitles);
  const reasonSummary = formatCommentFallbackReasonSummary(
    report.commentedSuggestionReasons,
    "commentedSuggestionReasonCounts" in report ? report.commentedSuggestionReasonCounts : undefined
  );
  const reasons = reasonSummary ? ` Comment fallback reasons: ${reasonSummary}.` : "";
  const actionSummary = formatWordCommentActionSummary(report, wordCommentSuggestions);
  const actions = actionSummary ? ` Action mix: ${actionSummary}.` : "";
  const overlapSummary = wordCommentOverlapSummary(wordCommentSuggestions);
  const overlaps = overlapSummary ? ` Comment-alternative caution: ${overlapSummary}.` : "";
  return {
    headline: `Word review: ${labelCount(wordCommentCount, "Word comment") ?? "Word comments"}`,
    detail: `${titlePhrase}.${reasons}${actions}${overlaps} Review body tracked changes first, then resolve these comments in Word so protected equations, figures, and PI fact checks stay aligned with the final text. Use the Word comments packet or suggestions artifact for full original/proposed text before manual insertion.`
  };
}

export function wordCommentOverlapSummary(suggestions: AiSuggestion[]): string | null {
  const groups = wordCommentOverlapGroups(suggestions);
  if (!groups.length) {
    return null;
  }
  const overlappingComments = groups.reduce((sum, group) => sum + group.length, 0);
  const examples = groups.slice(0, 2)
    .map((group) => group.slice(0, 2).map((suggestion) => suggestion.title).join(" vs "))
    .join("; ");
  const exampleText = examples ? `, including ${examples}` : "";
  return `${labelCount(overlappingComments, "alternative Word comment") ?? "Alternative Word comments"} across ${labelCount(groups.length, "shared text target") ?? "shared text targets"}${exampleText}; choose one version before manual insertion`;
}

export function wordCommentOverlappingSuggestions(suggestions: AiSuggestion[]): AiSuggestion[] {
  const seenSuggestionIds = new Set<string>();
  return wordCommentOverlapGroups(suggestions)
    .flatMap((group) => group)
    .filter((suggestion) => {
      if (seenSuggestionIds.has(suggestion.id)) {
        return false;
      }
      seenSuggestionIds.add(suggestion.id);
      return true;
    });
}

export function wordCommentOverlapRepresentativeSuggestions(suggestions: AiSuggestion[]): AiSuggestion[] {
  return wordCommentOverlapGroups(suggestions).map(wordCommentOverlapLeadSuggestion);
}

function wordCommentOverlapLeadSuggestion(group: AiSuggestion[]): AiSuggestion {
  return [...group].sort((first, second) => {
    const originalLengthDelta = normalizeText(second.original).length - normalizeText(first.original).length;
    if (originalLengthDelta !== 0) {
      return originalLengthDelta;
    }
    const confidenceDelta = second.confidence - first.confidence;
    if (confidenceDelta !== 0) {
      return confidenceDelta;
    }
    return first.title.localeCompare(second.title);
  })[0];
}

export function wordCommentOverlapGroupCountForSuggestions(suggestions: AiSuggestion[]): number {
  return wordCommentOverlapGroups(suggestions).length;
}

export function wordCommentOverlapGroupSizeBySuggestionIdForSuggestions(suggestions: AiSuggestion[]): Map<string, number> {
  const result = new Map<string, number>();
  wordCommentOverlapGroups(suggestions).forEach((group) => {
    group.forEach((suggestion) => {
      result.set(suggestion.id, group.length);
    });
  });
  return result;
}

export function wordCommentOverlapGroupBySuggestionIdForSuggestions(suggestions: AiSuggestion[]): Map<string, AiSuggestion[]> {
  const result = new Map<string, AiSuggestion[]>();
  wordCommentOverlapGroups(suggestions).forEach((group) => {
    group.forEach((suggestion) => {
      result.set(suggestion.id, group);
    });
  });
  return result;
}

export function wordCommentOverlapGroupTitleSummaryBySuggestionIdForSuggestions(suggestions: AiSuggestion[]): Map<string, string> {
  const result = new Map<string, string>();
  wordCommentOverlapGroups(suggestions).forEach((group) => {
    group.forEach((suggestion) => {
      const competingTitles = group
        .filter((groupSuggestion) => groupSuggestion.id !== suggestion.id)
        .map((groupSuggestion) => groupSuggestion.title);
      result.set(suggestion.id, compactTitleList(competingTitles, 3));
    });
  });
  return result;
}

function wordCommentOverlapGroups(suggestions: AiSuggestion[]): AiSuggestion[][] {
  const entries = suggestions
    .map((suggestion, index) => ({
      index,
      original: normalizeText(suggestion.original).toLowerCase(),
      suggestion
    }))
    .filter((entry) => entry.original.length >= 80);
  if (entries.length < 2) {
    return [];
  }
  const parent = entries.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (first: number, second: number) => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) {
      parent[secondRoot] = firstRoot;
    }
  };
  for (let first = 0; first < entries.length; first += 1) {
    for (let second = first + 1; second < entries.length; second += 1) {
      const firstOriginal = entries[first].original;
      const secondOriginal = entries[second].original;
      if (firstOriginal === secondOriginal || firstOriginal.includes(secondOriginal) || secondOriginal.includes(firstOriginal)) {
        union(first, second);
      }
    }
  }
  const groups = new Map<number, AiSuggestion[]>();
  entries.forEach((entry, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(entry.suggestion);
    groups.set(root, group);
  });
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .sort((first, second) => second.length - first.length);
}

function compactTitleList(titles: string[], maxVisibleTitles: number): string {
  const visibleTitles = titles.slice(0, maxVisibleTitles);
  const hiddenTitleCount = Math.max(0, titles.length - visibleTitles.length);
  return [
    visibleTitles.join("; "),
    hiddenTitleCount ? `+${hiddenTitleCount} more` : null
  ].filter(Boolean).join("; ");
}

function formatWordCommentActionSummary(report: ExportDispositionReport, suggestions: AiSuggestion[]): string {
  const counts = new Map<string, { count: number; label: string }>();
  suggestions.forEach((suggestion) => {
    const reason = reportReasonForSuggestion(
      report.commentedSuggestionIds ?? [],
      report.commentedSuggestionTitles ?? [],
      report.commentedSuggestionReasons ?? [],
      suggestion
    );
    const bucket = wordCommentActionBucketForSuggestion(suggestion, reason);
    const current = counts.get(bucket.key);
    counts.set(bucket.key, {
      count: (current?.count ?? 0) + 1,
      label: bucket.label
    });
  });
  return ["fact", "model", "figure", "body", "manual"]
    .map((key) => {
      const item = counts.get(key);
      return item ? labelCount(item.count, item.label) : null;
    })
    .filter(Boolean)
    .join("; ");
}

function wordCommentActionBucketForSuggestion(suggestion: AiSuggestion, reason: string): { key: string; label: string } {
  const value = [
    suggestion.title,
    suggestion.original,
    suggestion.replacement,
    suggestion.rationale,
    reason
  ].join(" ").toLowerCase();
  if (isPiFactCheckSuggestion(suggestion, reason)) {
    return { key: "fact", label: "PI/fact check" };
  }
  if (/\b(equation|math|omml|notation|lambda|processivity|observation model|transition-kernel|latent|xt|xt\+1)\b/.test(value)) {
    return { key: "model", label: "equation/model item" };
  }
  if (/\b(fig\.?|figure|legend|layout|media|image|emf)\b/.test(value)) {
    return { key: "figure", label: "figure/layout item" };
  }
  if (/\b(body prose|body-text|safe body anchor|could not rewrite|candidate for body)\b/.test(value)) {
    return { key: "body", label: "body-prose candidate" };
  }
  return { key: "manual", label: "manual integration item" };
}

export function isPiFactCheckSuggestion(suggestion: Pick<AiSuggestion, "title" | "original" | "replacement" | "rationale">, reason = ""): boolean {
  const value = [
    suggestion.title,
    suggestion.original,
    suggestion.replacement,
    suggestion.rationale,
    reason
  ].join(" ").toLowerCase();
  const actionWords = String.raw`(?:add|check|choose|confirm|fill|finali[sz]e|flag|insert|provide|replace|resolve|select|update|verify)`;
  const factWords = String.raw`(?:citation|reference|refs?\b|ref\)|placeholder|unit|dose|dosage|concentration|sample[- ]size|pi|author)`;
  const actionThenFact = new RegExp(String.raw`\b${actionWords}\b[\s\S]{0,100}\b${factWords}\b`, "i");
  const factThenAction = new RegExp(String.raw`\b${factWords}\b[\s\S]{0,100}\b${actionWords}\b`, "i");
  const bracketedAuthorHandoff = /\[(?=[^\]]*\b(?:pi|author|collaborator|user)\b)[^\]]*:\s*(?:add|check|choose|confirm|fill|insert|provide|replace|resolve|select|update|verify)\b/i;
  return bracketedAuthorHandoff.test(value) || actionThenFact.test(value) || factThenAction.test(value);
}

function formatRoutineRunClipboard(run: WriterRoutineRun): string {
  const report = run.report;
  const tracked = report ? labelTrackedCount(report.matchedSuggestions) : null;
  const artifactPath = run.downloadCopyPath || run.artifactPath;
  return [
    "Nebula Writer review export",
    `Run: ${run.label}`,
    `Completed: ${run.completedAt}`,
    run.instruction ? `Prompt: ${run.instruction}` : null,
    report ? `Counts: ${tracked}, ${report.commentedSuggestions} Word comment${report.commentedSuggestions === 1 ? "" : "s"}, ${report.unmatchedSuggestions} unresolved` : null,
    artifactPath ? `Review DOCX: ${artifactPath}` : null,
    run.reportPath ? `Report JSON: ${run.reportPath}` : null,
    run.suggestionsPath ? `Suggestions JSON: ${run.suggestionsPath}` : null,
    report?.matchedSuggestionTitles?.length ? `Tracked edits: ${report.matchedSuggestionTitles.join("; ")}` : null,
    report?.commentedSuggestionTitles?.length ? `Word comments: ${report.commentedSuggestionTitles.join("; ")}` : null,
    report?.unmatchedSuggestionTitles?.length ? `Unresolved: ${report.unmatchedSuggestionTitles.join("; ")}` : null,
    routineRunNextAction(run) ? `Next action: ${routineRunNextAction(run)}` : null,
    routineRunHandoffNote(run) ? `Handoff: ${routineRunHandoffNote(run)}` : null
  ].filter(Boolean).join("\n");
}

function formatPhraseList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function countPendingSuggestions(suggestions: AiSuggestion[]): number {
  return suggestions.filter((suggestion) => suggestion.status === "pending").length;
}

function providerLabel(provider: InteractiveProviderName): string {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function availableAlternateProvider(provider: InteractiveProviderName, health: HealthResponse | null): InteractiveProviderName | null {
  const status = health?.providerStatus?.find((candidate) => (
    candidate.name !== provider &&
    candidate.name !== "demo" &&
    candidate.available &&
    candidate.enabled !== false
  ));
  return isInteractiveProviderName(status?.name) ? status.name : null;
}

function isInteractiveProviderName(value: unknown): value is InteractiveProviderName {
  return value === "codex" || value === "claude";
}

function parseMaxSuggestionsInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function loadUserRoutines(): WritingRoutine[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(routinesStorageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(isStoredRoutine)
      .map((routine) => ({
        id: routine.id,
        label: routine.label,
        prompt: routine.prompt
      }));
  } catch {
    return [];
  }
}

function saveUserRoutines(routines: WritingRoutine[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(routinesStorageKey, JSON.stringify(routines.map((routine) => ({
      id: routine.id,
      label: routine.label,
      prompt: routine.prompt
    }))));
  } catch {
    // Local storage may be unavailable in restricted browser contexts.
  }
}

function loadSequenceProgress(sourceDocumentId: string | null): string[] {
  if (!sourceDocumentId || typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(sequenceProgressStorageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeSequenceProgressIds(parsed[sourceDocumentId]);
  } catch {
    return [];
  }
}

function saveSequenceProgress(sourceDocumentId: string | null, routineIds: string[]): string[] {
  const normalized = normalizeSequenceProgressIds(routineIds);
  if (!sourceDocumentId || typeof window === "undefined") {
    return normalized;
  }
  try {
    const raw = window.localStorage.getItem(sequenceProgressStorageKey);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    if (normalized.length) {
      parsed[sourceDocumentId] = normalized;
    } else {
      delete parsed[sourceDocumentId];
    }
    window.localStorage.setItem(sequenceProgressStorageKey, JSON.stringify(parsed));
  } catch {
    // Local storage may be unavailable in restricted browser contexts.
  }
  return normalized;
}

function restoreSequenceProgress(sourceDocumentId: string | null, sharedRoutineProgress: string[] | undefined): string[] {
  const restored = mergeSequenceProgress(
    loadSequenceProgress(sourceDocumentId),
    normalizeSequenceProgressIds(sharedRoutineProgress)
  );
  return saveSequenceProgress(sourceDocumentId, restored);
}

function mergeSequenceProgress(first: string[], second: string[]): string[] {
  return normalizeSequenceProgressIds([...first, ...second]);
}

function areStringArraysEqual(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => second[index] === value);
}

function normalizeSequenceProgressIds(value: unknown): string[] {
  const validRoutineIds = new Set(r01RoutineSequence.map((routine) => routine.id));
  const ids = Array.isArray(value) ? value : [];
  return ids.filter((id, index): id is string => (
    typeof id === "string" &&
    validRoutineIds.has(id) &&
    ids.indexOf(id) === index
  ));
}

function documentDetailTooltip(features: DocxFeatureSummary | null | undefined, notes: string[]): string {
  return [
    features?.preservationRecommended ? formatFeatureSummaryTitle(features) : "",
    notes.length ? `Conversion notes:\n${notes.map((note) => `\u2022 ${note}`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
}

function isStoredRoutine(value: unknown): value is Pick<WritingRoutine, "id" | "label" | "prompt"> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const routine = value as Partial<WritingRoutine>;
  return typeof routine.id === "string" && typeof routine.label === "string" && typeof routine.prompt === "string" && Boolean(routine.label.trim()) && Boolean(routine.prompt.trim());
}

function defaultRoutineName(prompt: string): string {
  const firstSentence = prompt.split(/[.!?]\s/)[0]?.trim() || prompt.trim();
  return firstSentence || "Writing routine";
}

function buildRefinedInstruction(result: EmptyAiResult): string {
  if (isProviderTimeoutMessage(result.message)) {
    return `Split the same request into a subsection-sized retry: use one Aim/sub-aim or 3-8 nearby paragraphs, then iterate to the next subsection. Return the highest-impact exact-source edits that fit safely in one response, keep each edit safe for tracked-change export, and preserve citations, formulas, figure labels, and technical meaning. Original request: ${result.instruction}`;
  }
  if (isProviderSafetyFilteredMessage(result.message)) {
    return `Retry with one exact clean source-text sentence only. The original must be copied verbatim from the visible document, the replacement must be meaningfully different, under ${bodySafeReplacementCharacterLimit} characters, and must preserve citations, formulas, figure labels, and protected tokens exactly. Original request: ${result.instruction}`;
  }
  const scopeHint = result.mode === "selection"
    ? "Use the selected passage as the exact source text"
    : "Pick one exact sentence from the visible document";
  return `${scopeHint} and propose one safe, concrete revision. Original request: ${result.instruction}`;
}

function emptyAiResultTitle(result: EmptyAiResult): string {
  if (isProviderTimeoutMessage(result.message)) {
    return "AI timed out before returning edits.";
  }
  if (isProviderSafetyFilteredMessage(result.message)) {
    return "No safe DOCX-placeable edits survived checks.";
  }
  return "No DOCX-placeable edits returned.";
}

function emptyAiResultRetryLabel(result: EmptyAiResult): string {
  if (isProviderTimeoutMessage(result.message)) {
    return "Retry subsection";
  }
  if (isProviderSafetyFilteredMessage(result.message)) {
    return "Retry exact text";
  }
  return "Refine prompt";
}

function emptyAiResultMessage(result: EmptyAiResult): string {
  const visibleMessage = formatPlacementReasonForDisplay(result.message);
  if (isProviderTimeoutMessage(result.message)) {
    return `${visibleMessage}. Retry one subsection or 3-8 nearby paragraphs, then keep iterating section by section.`;
  }
  if (isProviderSafetyFilteredMessage(result.message)) {
    return `${visibleMessage} Try a smaller retry using one exact sentence from the visible document.`;
  }
  return visibleMessage;
}

function isProviderTimeoutMessage(message: string): boolean {
  return /\btimed out\b/i.test(message);
}

function isProviderSafetyFilteredMessage(message: string): boolean {
  return /\bskipped\b/i.test(message) && /not safely (?:anchored|placed)|no-op|protected reference\/formula text/i.test(message);
}

function exportReportNeedsRefinement(report: ExportReport | null, options: ExportReportDisplayOptions = {}): report is ExportReport {
  if (!report) {
    return false;
  }
  if (report.unmatchedSuggestions > 0) {
    return true;
  }
  if (options.wordCommentHandoff) {
    return false;
  }
  return report.commentedSuggestions > 0;
}

function routineRunNeedsRefinement(run: WriterRoutineRun): boolean {
  if (!run.report) {
    return false;
  }
  if (run.report.unmatchedSuggestions > 0) {
    return true;
  }
  if (isPlaceholderCleanupRun(run)) {
    return false;
  }
  if (isSectionMergePacketRun(run)) {
    return false;
  }
  if (isPiHandoffRun(run)) {
    return false;
  }
  if (isWordCommentHandoffRun(run)) {
    return false;
  }
  if (isFocusedSectionReplacementRun(run) && run.report.unmatchedSuggestions === 0 && run.report.commentedSuggestions > 0) {
    return false;
  }
  return run.report.commentedSuggestions > 0;
}

function routineRunQuality(run: WriterRoutineRun): { kind: "tracked" | "mixed" | "commented" | "comment-only" | "focused" | "thin" | "unresolved" | "word-review"; label: string; title: string } | null {
  const report = run.report;
  if (!report || report.totalSuggestions === 0) {
    return null;
  }
  const protectedCount = report.commentedSuggestions + report.unmatchedSuggestions;
  if (report.unmatchedSuggestions > 0) {
    return {
      kind: "unresolved",
      label: "Needs placement",
      title: `${report.unmatchedSuggestions} suggestion${report.unmatchedSuggestions === 1 ? "" : "s"} could not be placed safely. Use Refine to ask for smaller source text.`
    };
  }
  if (isWordCommentHandoffRun(run) && report.commentedSuggestions > 0) {
    return {
      kind: "word-review",
      label: "Word review",
      title: `${report.commentedSuggestions} suggestion${report.commentedSuggestions === 1 ? "" : "s"} exported as Word comments for intentional review.`
    };
  }
  if (isSectionMergePacketRun(run) && report.commentedSuggestions > 0) {
    return {
      kind: "word-review",
      label: "Word merge packet",
      title: `${report.commentedSuggestions} section-level replacement${report.commentedSuggestions === 1 ? "" : "s"} exported as Word comments with 0 unresolved items. Use them as Word merge instructions before accepting overlapping cleanup edits.`
    };
  }
  if (isPiHandoffRun(run) && report.commentedSuggestions > 0) {
    const confirmationChecklist = isPiConfirmationChecklistRun(run);
    return {
      kind: "word-review",
      label: confirmationChecklist ? "PI checklist" : "PI handoff",
      title: confirmationChecklist
        ? `${report.commentedSuggestions} PI confirmation comment${report.commentedSuggestions === 1 ? "" : "s"} exported with 0 unresolved items. Resolve these fact and protocol decisions before accepting section rewrites or cleanup edits.`
        : `${report.commentedSuggestions} PI decision comment${report.commentedSuggestions === 1 ? "" : "s"} exported with 0 unresolved items. Use this handoff before merging section rewrites or cleanup edits.`
    };
  }
  if (isPlaceholderCleanupRun(run)) {
    return {
      kind: protectedCount === 0 ? "tracked" : "mixed",
      label: "Cleanup review",
      title: `${report.matchedSuggestions} tracked cleanup edit${report.matchedSuggestions === 1 ? "" : "s"} and ${report.commentedSuggestions} Word comment${report.commentedSuggestions === 1 ? "" : "s"} exported with 0 unresolved items. Review tracked placeholder removals first, then use Word comments for protected draft-note text.`
    };
  }
  if (report.totalSuggestions < 3) {
    if (report.matchedSuggestions === 0 && report.commentedSuggestions > 0) {
      const sectionReplacement = isFocusedSectionReplacementRun(run);
      const rawXmlOnly = reportHasRawWordXmlReason(report);
      return {
        kind: "word-review",
        label: sectionReplacement ? "Section review" : "Word comments",
        title: rawXmlOnly
          ? "This focused replacement exported as a Word comment because the source text is in protected/raw Word XML; use Word to apply it or compare it with overlapping queued edits."
        : sectionReplacement
          ? "This focused section replacement exported as a Word comment for intentional review; compare it with overlapping queued edits or alternatives before accepting."
          : "This focused paragraph replacement exported as a Word comment for intentional review; compare it with overlapping queued edits or alternatives before accepting."
      };
    }
    if (protectedCount === 0) {
      return {
        kind: "tracked",
        label: "Focused tracked",
        title: `This focused run exported ${report.totalSuggestions} suggestion${report.totalSuggestions === 1 ? "" : "s"} as body tracked changes. Review this targeted DOCX before accepting overlapping queued edits.`
      };
    }
    return {
      kind: "mixed",
      label: "Focused handoff",
      title: `This focused pass returned ${report.matchedSuggestions} tracked suggestion${report.matchedSuggestions === 1 ? "" : "s"} plus ${report.commentedSuggestions} Word comment${report.commentedSuggestions === 1 ? "" : "s"} for review.`
    };
  }
  if (report.matchedSuggestions === 0 && report.commentedSuggestions > 0) {
    return {
      kind: "comment-only",
      label: "Comment-only",
      title: "Every suggestion in this run became a Word comment. These edits likely touch protected or already-reviewed DOCX structure, so use Word review or choose different clean source text."
    };
  }
  if (protectedCount === 0) {
    return {
      kind: "tracked",
      label: "All tracked",
      title: "Every suggestion in this run exported as body tracked changes."
    };
  }
  if (isConsolidatedHandoffRun(run)) {
    return {
      kind: protectedCount >= Math.ceil(report.totalSuggestions / 2) ? "commented" : "mixed",
      label: "Cumulative review",
      title: `${report.matchedSuggestions} tracked change${report.matchedSuggestions === 1 ? "" : "s"} and ${report.commentedSuggestions} Word comment${report.commentedSuggestions === 1 ? "" : "s"} in this cumulative export. Review body tracked changes first, then use Word comments for protected section rewrites, integration notes, or PI-supplied fact checks; check nearby accepted text before inserting large comment rewrites or alternative section rewrites.`
    };
  }
  if (protectedCount >= Math.ceil(report.totalSuggestions / 2)) {
    return {
      kind: "commented",
      label: "Word comments",
      title: `${report.commentedSuggestions} of ${report.totalSuggestions} suggestions exported as Word comments; review in Word or refine with different clean source text.`
    };
  }
  return {
    kind: "mixed",
    label: "Mostly tracked",
    title: `${report.matchedSuggestions} of ${report.totalSuggestions} suggestions exported as body tracked changes.`
  };
}

function routineRunHandoffNote(run: WriterRoutineRun): string | null {
  const report = run.report;
  if (!report || report.totalSuggestions === 0) {
    return null;
  }
  if (report.unmatchedSuggestions > 0) {
    return `Placement needed: ${formatRoutineRunReportTitles(report.unmatchedSuggestionTitles)} Refine with smaller exact source text before relying on the DOCX.`;
  }
  const visibleComments = formatRoutineRunReportTitles(report.commentedSuggestionTitles);
  const visibleReason = formatRoutineRunReportReasons(report.commentedSuggestionReasons);
  if (isWordCommentHandoffRun(run) && report.commentedSuggestions > 0) {
    return `Word review carrier: ${visibleComments}${visibleReason} Review these comments in Word; tracked edits can be reviewed alongside them.`;
  }
  if (isSectionMergePacketRun(run) && report.commentedSuggestions > 0) {
    return `Section merge handoff: ${report.commentedSuggestions} section-level replacement${report.commentedSuggestions === 1 ? "" : "s"} exported as Word comments with 0 unresolved items. ${visibleComments}${visibleReason} Merge these controlling sections in Word before accepting overlapping cleanup edits.`;
  }
  if (isPiHandoffRun(run) && report.commentedSuggestions > 0) {
    return isPiConfirmationChecklistRun(run)
      ? `PI checklist handoff: ${visibleComments}${visibleReason} Resolve these factual and protocol decisions before accepting section rewrites or cleanup edits.`
      : `PI decision handoff: ${visibleComments}${visibleReason} Use these comments as the PI-facing acceptance checklist before merging section rewrites or cleanup edits.`;
  }
  if (isPlaceholderCleanupRun(run)) {
    return report.commentedSuggestions > 0
      ? `Cleanup handoff: ${report.matchedSuggestions} tracked cleanup edit${report.matchedSuggestions === 1 ? "" : "s"} plus ${visibleComments}${visibleReason} Review tracked placeholder removals first, then use Word comments for protected draft-note text.`
      : `Cleanup handoff: ${report.matchedSuggestions} tracked cleanup edit${report.matchedSuggestions === 1 ? "" : "s"} exported with 0 unresolved items.`;
  }
  if (report.totalSuggestions < 3) {
    if (report.commentedSuggestions > 0 && report.matchedSuggestions === 0) {
      const protectedCarrier = reportHasRawWordXmlReason(report)
        ? " The source text is in protected/raw Word XML, so treat the Word comment as the review carrier for applying this replacement manually."
        : "";
      return `Focused Word handoff: ${visibleComments}${visibleReason}${protectedCarrier} Review this paragraph or section replacement in Word and compare it with overlapping queued edits or alternatives before accepting either version.`;
    }
    const visibleCommentPhrase = formatRoutineRunReportTitlePhrase(report.commentedSuggestionTitles);
    return report.commentedSuggestions > 0
      ? `Focused mixed handoff: ${report.matchedSuggestions} tracked suggestion${report.matchedSuggestions === 1 ? "" : "s"} plus ${visibleCommentPhrase} for Word review.${visibleReason} Compare overlapping queued edits or alternatives before accepting a section replacement.`
      : `Focused tracked: ${formatRoutineRunTrackedTitlePrefix(report)}${report.totalSuggestions} tracked suggestion${report.totalSuggestions === 1 ? "" : "s"} exported. Review this targeted DOCX before accepting overlapping queued edits or running another broad pass.`;
  }
  if (report.commentedSuggestions === 0 && report.matchedSuggestions > 0 && report.matchedSuggestionTitles?.length) {
    return `Tracked changes: ${formatRoutineRunReportTitles(report.matchedSuggestionTitles)} Review these body tracked changes in Word before accepting overlapping queued edits.`;
  }
  if (report.matchedSuggestions === 0) {
    return `Word handoff: ${visibleComments}${visibleReason} Use Word comments or choose different clean source text before refining again.`;
  }
  if (report.commentedSuggestions === 0) {
    return null;
  }
  if (isConsolidatedHandoffRun(run)) {
    const reasonBreakdown = formatCommentFallbackReasonSentence(report.commentedSuggestionReasons, report.commentedSuggestionReasonCounts) || visibleReason;
    return `Primary cumulative carrier: ${visibleComments}${reasonBreakdown} This is the DOCX to open first when reviewing cumulative progress. Suggested review order: accept or reject body tracked changes first, then use Word comments for protected section rewrites, PI-supplied fact checks, and Aim 1-3 integration; check nearby accepted text before inserting large comment rewrites or alternative section rewrites.`;
  }
  if (report.commentedSuggestions >= report.matchedSuggestions) {
    return `Comment-heavy handoff: ${visibleComments}${visibleReason} Refine only with different short source text; otherwise review in Word.`;
  }
  return `Word handoff: ${visibleComments}${visibleReason} Most edits are tracked; review these comments in Word or refine them separately.`;
}

function routineRunNextAction(run: WriterRoutineRun): string | null {
  const report = run.report;
  if (!report || report.totalSuggestions === 0) {
    return run.artifactPath ? "Open the artifact or report before changing the draft." : null;
  }
  if (report.unmatchedSuggestions > 0) {
    return "Refine placement before relying on this artifact.";
  }
  if (isSectionMergePacketRun(run)) {
    return "Merge these Word comments first, then accept only non-conflicting cleanup edits.";
  }
  if (isPiHandoffRun(run)) {
    return isPiConfirmationChecklistRun(run)
      ? "Resolve these PI checklist comments before accepting section rewrites or cleanup edits."
      : "Use these PI decision comments before accepting section rewrites or cleanup edits.";
  }
  if (isPlaceholderCleanupRun(run)) {
    return "Review tracked cleanup edits after section merges; use comments for protected placeholders.";
  }
  if (isConsolidatedHandoffRun(run)) {
    return "Open this cumulative DOCX first; review body tracked changes, then triage the Word comments.";
  }
  if (isWordCommentHandoffRun(run) || (report.matchedSuggestions === 0 && report.commentedSuggestions > 0)) {
    return "Review the Word comments before applying text manually.";
  }
  if (report.commentedSuggestions > 0) {
    return "Review tracked changes first, then inspect the Word comments.";
  }
  return "Review the tracked changes in Word.";
}

interface RoutineRunSourceDrift {
  current: WriterReviewSourceDocument;
  reason: "changed" | "advanced";
}

function routineRunSourceNote(run: WriterRoutineRun, sourceDrift: RoutineRunSourceDrift | null = null): string | null {
  const source = run.sourceDocument;
  if (!source?.path) {
    return null;
  }
  const parts = [routineRunArtifactName(source.path)];
  if (source.modifiedAt) {
    parts.push(`modified ${source.modifiedAt}`);
  }
  if (typeof source.sizeBytes === "number") {
    parts.push(formatSourceDocumentBytes(source.sizeBytes));
  }
  if (source.changedWhileReading) {
    parts.push("changed while reading");
  }
  if (source.usedInMemoryFallback) {
    parts.push("used in-memory fallback");
  }
  if (source.unavailableReason) {
    parts.push("source unreadable");
  }
  if (sourceDrift) {
    parts.push(sourceDrift.reason === "advanced" ? "current source is newer" : "current source differs");
  }
  return parts.join(" · ");
}

function routineRunSourceTitle(run: WriterRoutineRun, sourceDrift: RoutineRunSourceDrift | null = null): string | null {
  const source = run.sourceDocument;
  if (!source?.path) {
    return null;
  }
  const parts = [`Source path: ${source.path}`];
  if (source.modifiedAt) {
    parts.push(`Modified: ${source.modifiedAt}`);
  }
  if (source.readAt) {
    parts.push(`Read for export: ${source.readAt}`);
  }
  if (typeof source.filesystemSizeBytes === "number") {
    parts.push(`Filesystem size: ${source.filesystemSizeBytes} bytes`);
  }
  if (source.changedWhileReading) {
    parts.push("The source changed while Writer was reading it for export.");
  }
  if (source.unavailableReason) {
    parts.push(`Read issue: ${source.unavailableReason}`);
  }
  if (sourceDrift) {
    parts.push(`Current source modified: ${sourceDrift.current.modifiedAt ?? "unknown"}`);
    if (typeof sourceDrift.current.sizeBytes === "number") {
      parts.push(`Current source size: ${sourceDrift.current.sizeBytes} bytes`);
    }
    parts.push(sourceDrift.reason === "advanced"
      ? "The active DOCX source is newer than the source used for this export."
      : "The active DOCX source differs from the source used for this export.");
  }
  return parts.join("\n");
}

function routineRunSourceDrift(run: WriterRoutineRun, currentSource: WriterReviewSourceDocument | null): RoutineRunSourceDrift | null {
  const runSource = run.sourceDocument;
  if (!runSource?.path || !currentSource?.path || runSource.path !== currentSource.path) {
    return null;
  }
  const runModifiedMs = typeof runSource.modifiedMs === "number" ? runSource.modifiedMs : Date.parse(runSource.modifiedAt ?? "");
  const currentModifiedMs = typeof currentSource.modifiedMs === "number" ? currentSource.modifiedMs : Date.parse(currentSource.modifiedAt ?? "");
  if (Number.isFinite(runModifiedMs) && Number.isFinite(currentModifiedMs) && currentModifiedMs > runModifiedMs + 1) {
    return { current: currentSource, reason: "advanced" };
  }
  if (typeof runSource.sizeBytes === "number" && typeof currentSource.sizeBytes === "number" && runSource.sizeBytes !== currentSource.sizeBytes) {
    return { current: currentSource, reason: "changed" };
  }
  return null;
}

function formatSourceDocumentBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function formatRoutineRunReportTitles(titles: string[] | undefined): string {
  const visibleTitles = (titles ?? []).filter(Boolean);
  if (!visibleTitles.length) {
    return "Some suggestions need Word review.";
  }
  const visible = visibleTitles.slice(0, 2).join("; ");
  const suffix = visibleTitles.length > 2 ? `; +${visibleTitles.length - 2} more` : "";
  return `${visible}${suffix}.`;
}

function formatRoutineRunReportTitlePhrase(titles: string[] | undefined): string {
  const visibleTitles = (titles ?? []).filter(Boolean);
  if (!visibleTitles.length) {
    return "Word comments";
  }
  const visible = visibleTitles.slice(0, 2).join("; ");
  const suffix = visibleTitles.length > 2 ? `; +${visibleTitles.length - 2} more` : "";
  return `${visible}${suffix}`;
}

function formatRoutineRunTrackedTitlePrefix(report: WriterRoutineRunReport): string {
  if (!report.matchedSuggestionTitles?.length) {
    return "";
  }
  return `${formatRoutineRunReportTitles(report.matchedSuggestionTitles)} `;
}

function formatRoutineRunReportReasons(reasons: string[] | undefined): string {
  const visibleReasons = (reasons ?? []).filter(Boolean);
  if (!visibleReasons.length) {
    return "";
  }
  return ` Reason: ${formatPlacementReasonForDisplay(visibleReasons[0])}`;
}

type CommentFallbackReasonBucket = {
  singular: string;
  plural: string;
  test: RegExp;
};

const commentFallbackReasonBuckets: CommentFallbackReasonBucket[] = [
  {
    singular: "existing tracked-change paragraph",
    plural: "existing tracked-change paragraphs",
    test: /already contains tracked changes/i
  },
  {
    singular: "existing Word-comment paragraph",
    plural: "existing Word-comment paragraphs",
    test: /already contains (?:a )?Word comments?/i
  },
  {
    singular: "intentional comment handoff",
    plural: "intentional comment handoffs",
    test: /comment-only|anchored Word comment/i
  },
  {
    singular: "equation-protected paragraph",
    plural: "equation-protected paragraphs",
    test: /equation|math object|OMML/i
  },
  {
    singular: "media-protected paragraph",
    plural: "media-protected paragraphs",
    test: /media/i
  },
  {
    singular: "appendix comment fallback",
    plural: "appendix comment fallbacks",
    test: /comments appendix|review comments appendix|safe body anchor/i
  },
  {
    singular: "raw/protected XML source text",
    plural: "raw/protected XML source-text targets",
    test: /raw Word XML|protected structure/i
  }
];

function formatCommentFallbackReasonSentence(reasons: string[] | undefined, reasonCounts?: Array<{ count: number; reason: string }>): string {
  const summary = formatCommentFallbackReasonSummary(reasons, reasonCounts);
  return summary ? ` Comment fallback reasons: ${summary}.` : "";
}

function formatCommentFallbackReasonSummary(reasons: string[] | undefined, reasonCounts?: Array<{ count: number; reason: string }>): string {
  const counts = new Map<string, { count: number; singular: string; plural: string }>();
  const entries = reasonCounts?.length
    ? reasonCounts
    : (reasons ?? []).map((reason) => ({ count: 1, reason }));
  for (const entry of entries) {
    const trimmed = entry.reason.trim();
    if (!trimmed) {
      continue;
    }
    const bucket = commentFallbackReasonBuckets.find((candidate) => candidate.test.test(trimmed)) ?? {
      singular: "other safe-placement fallback",
      plural: "other safe-placement fallbacks"
    };
    const key = bucket.plural;
    const current = counts.get(key);
    counts.set(key, {
      count: (current?.count ?? 0) + Math.max(1, Math.trunc(entry.count)),
      singular: bucket.singular,
      plural: bucket.plural
    });
  }
  const sorted = [...counts.values()]
    .sort((a, b) => b.count - a.count);
  const visible = sorted.slice(0, 5);
  const appendix = sorted.find((bucket) => bucket.plural === "appendix comment fallbacks");
  if (appendix && !visible.some((bucket) => bucket.plural === appendix.plural)) {
    visible.push(appendix);
  }
  return visible
    .map((bucket) => `${bucket.count} ${bucket.count === 1 ? bucket.singular : bucket.plural}`)
    .join("; ");
}

function reportHasRawWordXmlReason(report: WriterRoutineRunReport): boolean {
  return (report.commentedSuggestionReasons ?? []).some((reason) => /raw Word XML|protected structure/i.test(reason));
}

function isWordCommentHandoffRun(run: WriterRoutineRun): boolean {
  return isWordCommentHandoffRoutineId(run.routineId);
}

function isFocusedSectionReplacementRun(run: WriterRoutineRun): boolean {
  const value = `${run.routineId ?? ""} ${run.label}`.toLowerCase();
  return /\b(section|subsection|integrated|outcomes?|pitfalls?|alternatives?|milestones?)\b/.test(value);
}

function isConsolidatedHandoffRun(run: WriterRoutineRun): boolean {
  const value = `${run.routineId} ${run.label}`.toLowerCase();
  return value.includes("consolidated") || value.includes("cumulative");
}

function isPlaceholderCleanupRun(run: WriterRoutineRun): boolean {
  const value = `${run.routineId} ${run.label}`.toLowerCase();
  return value.includes("placeholder-cleanup") || value.includes("placeholder cleanup") || value.includes("draft-note");
}

function isSectionMergePacketRun(run: WriterRoutineRun): boolean {
  const value = `${run.routineId} ${run.label}`.toLowerCase();
  return value.includes("section-merge") || value.includes("section merge packet") || value.includes("controlling section merge");
}

function isPiHandoffRun(run: WriterRoutineRun): boolean {
  return isPiConfirmationChecklistRun(run) || isPiDecisionHandoffRun(run);
}

function isPiConfirmationChecklistRun(run: WriterRoutineRun): boolean {
  const value = `${run.routineId ?? ""} ${run.label}`.toLowerCase();
  return value.includes("pi") && value.includes("confirmation") && value.includes("checklist");
}

function isPiDecisionHandoffRun(run: WriterRoutineRun): boolean {
  const value = `${run.routineId ?? ""} ${run.label}`.toLowerCase();
  return value.includes("pi") && value.includes("decision") && value.includes("handoff");
}

function isWordCommentHandoffRoutineId(routineId: string | null | undefined): boolean {
  return routineId === "r01-word-comment-handoff";
}

function reportDisplayOptionsForRoutineId(routineId: string | null | undefined): ExportReportDisplayOptions {
  return {
    cumulativeHandoff: isCumulativeHandoffRoutineId(routineId),
    wordCommentHandoff: isWordCommentHandoffRoutineId(routineId)
  };
}

function isCumulativeHandoffRoutineId(routineId: string | null | undefined): boolean {
  return routineId === "r01-cumulative-review" || routineId === "r01-consolidated-handoff";
}

function reviewExportContext(
  sequenceReviewHandoff: SequenceReviewHandoff | null,
  sequenceExportSummary: SequenceExportSummary | null
): RoutineIntent | null {
  if (sequenceReviewHandoff) {
    return {
      label: sequenceReviewHandoff.label,
      routineId: sequenceReviewHandoff.routineId
    };
  }
  if (sequenceExportSummary) {
    return {
      label: sequenceExportSummary.label,
      routineId: sequenceExportSummary.routineId
    };
  }
  return null;
}

function buildExportReportRefinementInstruction(report: ExportReport, suggestions: AiSuggestion[], documentText = "", docxVerifiedAnchors: string[] = [], docxVerifiedAnchorDetails: DocxBodySafeAnchor[] = []): string {
  const titles = [
    ...report.commentedSuggestionTitles,
    ...report.unmatchedSuggestionTitles
  ].filter(Boolean);
  const focus = titles.length
    ? `Focus especially on these previous export items: ${titles.slice(0, 8).join("; ")}.`
    : "Focus on the previous export items that became Word comments or unresolved suggestions.";
  const failedOriginalSpans = failedOriginalSpansForExportReport(report, suggestions);
  const failedOriginals = formatFailedOriginalSpans(failedOriginalSpans);
  const nearbyAlternates = formatNearbyAlternateAnchorCandidates(documentText, failedOriginalSpans, docxVerifiedAnchors, docxVerifiedAnchorDetails);
  return [
    "Rewrite the last review export's Word-comment or unresolved suggestions as smaller, safer body-text tracked-change candidates.",
    focus,
    formatExportReasonGuidance(report.commentedSuggestionReasons),
    failedOriginals,
    nearbyAlternates,
    "Use exact contiguous body-text spans from the document as originals. Avoid citation fields, formulas, captions/text boxes, existing tracked-change regions, comments, bookmarks, and other protected Word structures.",
    cleanAnchorRetryPolicy(docxVerifiedAnchors),
    "Keep replacements scientifically faithful, reviewer-facing, concise, and suitable for NIH R01 submission. Return exact-source replacement edits only, with no broad comments."
  ].filter(Boolean).join(" ");
}

function buildRoutineRunRefinementInstruction(run: WriterRoutineRun, documentText = "", docxVerifiedAnchors: string[] = [], docxVerifiedAnchorDetails: DocxBodySafeAnchor[] = []): string {
  const report = run.report;
  const titles = [
    ...(report?.commentedSuggestionTitles ?? []),
    ...(report?.unmatchedSuggestionTitles ?? [])
  ].filter(Boolean);
  const focus = titles.length
    ? `Focus especially on these previous ${run.label} items: ${titles.slice(0, 8).join("; ")}.`
    : `The ${run.label} run produced ${report?.commentedSuggestions ?? 0} Word comment${report?.commentedSuggestions === 1 ? "" : "s"} and ${report?.unmatchedSuggestions ?? 0} unresolved item${report?.unmatchedSuggestions === 1 ? "" : "s"}.`;
  const failedOriginalSpans = [
    ...(report?.commentedSuggestionOriginals ?? []),
    ...(report?.unmatchedSuggestionOriginals ?? [])
  ];
  const failedOriginals = formatFailedOriginalSpans(failedOriginalSpans);
  const nearbyAlternates = formatNearbyAlternateAnchorCandidates(documentText, failedOriginalSpans, docxVerifiedAnchors, docxVerifiedAnchorDetails);
  return [
    `Rewrite the ${run.label} run's Word-comment or unresolved suggestions as smaller, safer body-text tracked-change candidates.`,
    focus,
    formatExportReasonGuidance(report?.commentedSuggestionReasons),
    failedOriginals,
    nearbyAlternates,
    "Use exact contiguous body-text spans from the document as originals. Avoid citation fields, formulas, captions/text boxes, existing tracked-change regions, comments, bookmarks, and other protected Word structures.",
    cleanAnchorRetryPolicy(docxVerifiedAnchors),
    "Keep replacements scientifically faithful, reviewer-facing, concise, and suitable for NIH R01 submission. Return exact-source replacement edits only, with no broad comments."
  ].filter(Boolean).join(" ");
}

function formatExportReasonGuidance(reasons: string[] | undefined): string {
  const uniqueReasons = [...new Set((reasons ?? []).map((reason) => reason.trim()).filter(Boolean))];
  if (!uniqueReasons.length) {
    return "";
  }
  const guidance = uniqueReasons.map((reason) => `- ${reason}`).join(" ");
  const existingTrackedRevisionGuidance = uniqueReasons.some((reason) => /already contains tracked changes/i.test(reason))
    ? "When a diagnostic says the source text is already in tracked changes, choose a different clean paragraph or nearby ordinary body sentence rather than shortening the same source text."
    : "";
  const protectedStructureGuidance = uniqueReasons.some((reason) => /protected|formula|field|citation|hyperlink|content control|custom XML|raw Word XML/i.test(reason))
    ? "When a diagnostic says protected Word structure was involved, place the same scientific idea on adjacent visible body text and keep protected tokens untouched."
    : "";
  return [
    `Previous export diagnostics for the failed source text: ${guidance}`,
    existingTrackedRevisionGuidance,
    protectedStructureGuidance
  ].filter(Boolean).join(" ");
}

function cleanAnchorRetryPolicy(docxVerifiedAnchors: string[]): string {
  const anchorPolicy = docxVerifiedAnchors.length
    ? "Every suggestion original must be copied verbatim from the DOCX-verified clean source-text list below; do not choose originals outside that list."
    : "Prefer the candidate body text when provided.";
  return `Do not reuse the previous failed original spans. ${anchorPolicy} Keep each original to one sentence or one short placeholder line, keep each replacement under ${bodySafeReplacementCharacterLimit} characters, and split larger ideas into separate suggestions on separate source-text targets.`;
}

function withBodySafeAnchorCandidates(prompt: string, documentText: string, docxVerifiedAnchors: string[] = [], docxVerifiedAnchorDetails: DocxBodySafeAnchor[] = []): string {
  const candidates = docxVerifiedAnchors.length ? docxVerifiedAnchors : bodySafeAnchorCandidates(documentText);
  if (!candidates.length) {
    return prompt;
  }
  const compactDocumentText = compactBodySafeAnchorText(documentText);
  const sectionByAnchor = bodySafeAnchorSectionMap(docxVerifiedAnchorDetails);
  const coverage = docxVerifiedAnchors.length ? formatBodySafeAnchorCoverage(docxVerifiedAnchorDetails, candidates) : "";
  const heading = docxVerifiedAnchors.length
    ? "DOCX-verified clean source text sampled from paragraphs without tracked changes, comments, fields, formulas, bookmarks, or other protected Word XML. Section labels are context only; for retry edits, every original must be copied exactly from this list:"
    : "Candidate ordinary body text sampled across the document with approximate locations. When possible, spread returned edits across different source-text targets instead of clustering in one section; copy an original exactly if you edit it:";
  return `${prompt}\n\n${heading}${coverage ? `\n${coverage}` : ""}\n${candidates.map((candidate) => `- ${formatBodySafeAnchorCandidate(candidate, compactDocumentText, sectionByAnchor)}`).join("\n")}`;
}

function buildThinAimBodySafeInstruction(thinSections: string[], documentText: string, docxVerifiedAnchorDetails: DocxBodySafeAnchor[]): string {
  const anchors = docxVerifiedAnchorDetails
    .filter((detail) => thinSections.includes(bodySafeCoverageSectionLabel(detail.section)))
    .map((detail) => detail.text.trim())
    .filter(uniqueCompactAnchorFilter());

  return [
    `Act as an NIH R01 editor doing a narrow body-safe pass for sections with few clean source-text samples: ${thinSections.join(", ")}.`,
    "Use only exact DOCX-verified clean source text listed below as originals.",
    "Propose 1-2 concise tracked-change-safe edits that improve reviewer clarity, expected outcomes, key readouts, fallback interpretation, or Aim logic in those sections.",
    `Keep each replacement under ${bodySafeReplacementCharacterLimit} characters, preserve scientific meaning and technical terms, and return exact-source replacement edits only.`,
    "DOCX-verified clean source text:",
    formatBodySafeAnchorLines(anchors, documentText, docxVerifiedAnchorDetails)
  ].filter(Boolean).join("\n\n");
}

function buildMilestonesPayoffBodySafeInstruction(anchors: string[], documentText: string, docxVerifiedAnchorDetails: DocxBodySafeAnchor[]): string {
  return [
    "Act as an NIH R01 reviewer-editor doing a narrow Expected Milestones and Impact payoff pass.",
    "Return 1-2 reviewable, body tracked-change-safe edits that strengthen reviewer clarity about resource/payoff, community reuse, or adoption barriers without adding unsupported claims.",
    "Every suggestion original must be copied verbatim from the DOCX-verified clean source text below. Do not edit citations, equations, figure text, comments, text boxes, or tracked-change regions.",
    `Keep each replacement under ${bodySafeReplacementCharacterLimit} characters, preserve scientific meaning and technical terms, and return exact-source replacement edits only.`,
    "DOCX-verified clean Expected Milestones and Impact source text:",
    formatBodySafeAnchorLines(anchors, documentText, docxVerifiedAnchorDetails)
  ].filter(Boolean).join("\n\n");
}

function buildLanguagePolishBodySafeInstruction(anchors: string[], documentText: string, docxVerifiedAnchorDetails: DocxBodySafeAnchor[]): string {
  return [
    "Act as an NIH R01 copy editor doing a narrow language-polish pass on typo-prone clean source text.",
    "Return 1-3 reviewable, body tracked-change-safe edits that fix spelling, hyphenation, capitalization, tense consistency, plural agreement, article agreement, usage, word choice, or awkward grammar only.",
    "Use the potential issue labels as the primary target for each edit; do not broaden into style rewrites, and only adjust adjacent punctuation when required for the labeled fix.",
    "Every suggestion original must be copied verbatim from the DOCX-verified clean source text below. Do not add new claims, change scientific meaning, or edit citations, equations, figure text, comments, text boxes, or tracked-change regions.",
    `Keep each replacement under ${bodySafeReplacementCharacterLimit} characters and return exact-source replacement edits only.`,
    "DOCX-verified clean language-polish source text:",
    formatLanguagePolishAnchorLines(anchors, documentText, docxVerifiedAnchorDetails)
  ].filter(Boolean).join("\n\n");
}

function buildVerificationHandoffInstruction(notes: string[]): string {
  return [
    "Act as a proposal reviewer-editor doing a focused fact-check handoff pass.",
    "Return one exact-source Word-comment suggestion for each VERIFY note below, using the VERIFY note itself as the exact original text.",
    "Set commentOnly true for each suggestion, and write the replacement as a concise handoff describing what the PI or proposal team must confirm before submission.",
    "Do not invent missing measurements, prior awards, formal roles, effort levels, storage decisions, citation details, or facility commitments.",
    "VERIFY note originals:",
    notes.map((note) => `- ${note}`).join("\n")
  ].join("\n\n");
}

function buildSectionBodySafeInstruction(section: string, anchors: string[], documentText: string, docxVerifiedAnchorDetails: DocxBodySafeAnchor[]): string {
  return [
    `Act as an NIH R01 reviewer-editor doing a narrow body-safe pass for ${section}.`,
    "Return 1-2 reviewable, body tracked-change-safe edits that improve reviewer clarity, expected outcomes, Aim logic, pitfalls/alternatives, or interpretive payoff in this section without adding unsupported claims.",
    "Every suggestion original must be copied verbatim from the DOCX-verified clean source text below. Do not edit citations, equations, figure text, comments, text boxes, or tracked-change regions.",
    `Keep each replacement under ${bodySafeReplacementCharacterLimit} characters, preserve scientific meaning and technical terms, and return exact-source replacement edits only.`,
    `DOCX-verified clean ${section} source text:`,
    formatBodySafeAnchorLines(anchors, documentText, docxVerifiedAnchorDetails)
  ].filter(Boolean).join("\n\n");
}

function formatBodySafeAnchorLines(anchors: string[], documentText: string, docxVerifiedAnchorDetails: DocxBodySafeAnchor[]): string {
  const compactDocumentText = compactBodySafeAnchorText(documentText);
  const sectionByAnchor = bodySafeAnchorSectionMap(docxVerifiedAnchorDetails);
  return anchors
    .map((anchor) => `- ${formatBodySafeAnchorCandidate(anchor, compactDocumentText, sectionByAnchor)}`)
    .join("\n");
}

function formatLanguagePolishAnchorLines(anchors: string[], documentText: string, docxVerifiedAnchorDetails: DocxBodySafeAnchor[]): string {
  const compactDocumentText = compactBodySafeAnchorText(documentText);
  const sectionByAnchor = bodySafeAnchorSectionMap(docxVerifiedAnchorDetails);
  return anchors
    .map((anchor) => {
      const issues = languagePolishIssueLabels(anchor);
      const issuePrefix = issues.length ? `[Potential issue: ${issues.join("; ")}] ` : "";
      return `- ${issuePrefix}${formatBodySafeAnchorCandidate(anchor, compactDocumentText, sectionByAnchor)}`;
    })
    .join("\n");
}

function formatNearbyAlternateAnchorCandidates(documentText: string, failedOriginals: string[], docxVerifiedAnchors: string[] = [], docxVerifiedAnchorDetails: DocxBodySafeAnchor[] = []): string {
  const docxCandidates = nearbyDocxVerifiedAnchorCandidates(documentText, failedOriginals, docxVerifiedAnchors);
  const candidates = docxCandidates.length ? docxCandidates : nearbyAlternateAnchorCandidates(documentText, failedOriginals);
  if (!candidates.length) {
    return "";
  }
  const compactDocumentText = compactBodySafeAnchorText(documentText);
  const sectionByAnchor = bodySafeAnchorSectionMap(docxVerifiedAnchorDetails);
  const coverage = docxCandidates.length ? formatBodySafeAnchorCoverage(docxVerifiedAnchorDetails, candidates) : "";
  const heading = docxCandidates.length
    ? "Nearby DOCX-verified clean source text around the failed spans. Section labels are context only; if you use nearby text, copy the original exactly from this list:"
    : "Prefer these nearby alternate body-text samples around the failed spans before using the broader document-wide samples. Copy an original exactly if you edit it:";
  return `${heading}${coverage ? `\n${coverage}` : ""}\n${candidates.map((candidate) => `- ${formatBodySafeAnchorCandidate(candidate, compactDocumentText, sectionByAnchor)}`).join("\n")}`;
}

export function nearbyDocxVerifiedAnchorCandidates(documentText: string, failedOriginals: string[], docxVerifiedAnchors: string[]): string[] {
  const compactDocumentText = compactBodySafeAnchorText(documentText);
  const anchors = [...new Set(docxVerifiedAnchors.map((anchor) => compactBodySafeAnchorText(anchor)).filter(Boolean))];
  if (!compactDocumentText || !anchors.length) {
    return [];
  }
  const failedIndexes = failedOriginals
    .map((original) => compactDocumentText.indexOf(compactBodySafeAnchorText(original)))
    .filter((index) => index >= 0);
  if (!failedIndexes.length) {
    return [];
  }

  return anchors
    .map((anchor) => ({ index: compactDocumentText.indexOf(anchor), text: anchor }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => nearestAnchorDistance(left.index, failedIndexes) - nearestAnchorDistance(right.index, failedIndexes))
    .map((candidate) => candidate.text)
    .slice(0, 8);
}

function nearestAnchorDistance(index: number, failedIndexes: number[]): number {
  return Math.min(...failedIndexes.map((failedIndex) => Math.abs(index - failedIndex)));
}

export function nearbyAlternateAnchorCandidates(documentText: string, failedOriginals: string[]): string[] {
  const compactDocumentText = compactBodySafeAnchorText(documentText);
  const failed = failedOriginals.map((original) => compactBodySafeAnchorText(original)).filter(Boolean);
  if (!compactDocumentText || !failed.length) {
    return [];
  }

  const selected = new Map<number, string>();
  for (const failedOriginal of failed) {
    const failedIndex = compactDocumentText.indexOf(failedOriginal);
    if (failedIndex < 0) {
      continue;
    }
    const windowStart = Math.max(0, failedIndex - 1800);
    const windowEnd = Math.min(compactDocumentText.length, failedIndex + failedOriginal.length + 1800);
    const windowText = compactDocumentText.slice(windowStart, windowEnd);
    const candidates = splitBodySafeSentences(windowText)
      .map((sentence) => sentence.trim())
      .filter((sentence) => isBodySafeAnchorCandidate(sentence))
      .filter((sentence) => !failed.includes(compactBodySafeAnchorText(sentence)))
      .map((sentence) => ({ index: compactDocumentText.indexOf(sentence), text: sentence }))
      .filter((candidate) => candidate.index >= 0)
      .sort((a, b) => Math.abs(a.index - failedIndex) - Math.abs(b.index - failedIndex));
    for (const candidate of candidates.slice(0, 3)) {
      if (!selected.has(candidate.index)) {
        selected.set(candidate.index, candidate.text);
      }
    }
  }

  return [...selected.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .slice(0, 10);
}

export function bodySafeAnchorCandidates(documentText: string): string[] {
  const candidates = splitBodySafeSentences(documentText)
    .map((sentence, index) => ({ index, text: sentence.trim() }))
    .filter((candidate, index, all) => (
      isBodySafeAnchorCandidate(candidate.text)
      && all.findIndex((other) => other.text === candidate.text) === index
    ));
  if (candidates.length <= 8) {
    return candidates.map((candidate) => candidate.text);
  }

  const selected = new Map<number, string>();
  for (let slot = 0; slot < 8; slot += 1) {
    const target = Math.round((slot / 7) * (candidates.length - 1));
    const nearest = candidates
      .filter((candidate) => !selected.has(candidate.index))
      .sort((a, b) => Math.abs(a.index - candidates[target].index) - Math.abs(b.index - candidates[target].index))[0];
    if (nearest) {
      selected.set(nearest.index, nearest.text);
    }
  }

  return [...selected.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text);
}

function splitBodySafeSentences(documentText: string): string[] {
  const compact = compactBodySafeAnchorText(documentText);
  const protectedDots = compact
    .replace(/\b(Fig|fig|Dr|Mr|Ms|Mrs|vs)\./g, "$1<dot>")
    .replace(/\be\.g\./gi, (match) => match.replace(/\./g, "<dot>"))
    .replace(/\bi\.e\./gi, (match) => match.replace(/\./g, "<dot>"));
  return (protectedDots.match(/[^.!?]+[.!?]+/g) ?? [])
    .map((sentence) => sentence.replace(/<dot>/g, ".").trim());
}

function compactBodySafeAnchorText(documentText: string): string {
  return documentText.replace(/\s+/g, " ").trim();
}

function formatBodySafeAnchorCandidate(candidate: string, compactDocumentText: string, sectionByAnchor: Map<string, string> = new Map()): string {
  const index = compactDocumentText.indexOf(candidate);
  const section = sectionByAnchor.get(candidate);
  const sectionPrefix = section ? ` [Section: ${section}]` : "";
  if (index < 0 || !compactDocumentText.length) {
    return `${candidate}${sectionPrefix}`;
  }
  const percent = Math.round((index / compactDocumentText.length) * 100);
  return `[~${percent}%]${sectionPrefix} ${candidate}`;
}

function bodySafeAnchorSectionMap(details: DocxBodySafeAnchor[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const detail of details) {
    const text = detail.text.trim();
    const section = detail.section?.trim();
    if (text && section && !map.has(text)) {
      map.set(text, section);
    }
  }
  return map;
}

function bodySafeAnchorSectionCounts(details: DocxBodySafeAnchor[]): Map<string, number> {
  const counts = new Map<string, number>();
  const seenAnchors = new Set<string>();
  for (const detail of details) {
    const anchor = compactBodySafeAnchorText(detail.text);
    if (!anchor || seenAnchors.has(anchor)) {
      continue;
    }
    seenAnchors.add(anchor);
    const label = bodySafeCoverageSectionLabel(detail.section);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

function bodySafeAnchorCoveredByPendingSuggestion(anchor: string, suggestions: AiSuggestion[]): boolean {
  const compactAnchor = normalizeText(anchor).toLowerCase();
  if (compactAnchor.length < 20) {
    return false;
  }
  return suggestions.some((suggestion) => {
    if (suggestion.status !== "pending") {
      return false;
    }
    const compactOriginal = normalizeText(suggestion.original).toLowerCase();
    return compactOriginal.length >= 20 && (
      compactOriginal === compactAnchor
      || compactOriginal.includes(compactAnchor)
      || compactAnchor.includes(compactOriginal)
    );
  });
}

function bodySafeUncoveredAnchors(anchors: string[], suggestions: AiSuggestion[]): string[] {
  return anchors.filter((anchor) => !bodySafeAnchorCoveredByPendingSuggestion(anchor, suggestions));
}

function bodySafeAnchorsForSection(details: DocxBodySafeAnchor[], sectionLabel: string): string[] {
  return details
    .filter((detail) => bodySafeMapSectionLabel(detail.section) === sectionLabel)
    .map((detail) => detail.text.trim())
    .filter(uniqueCompactAnchorFilter());
}

function bodySafeLanguagePolishAnchors(details: DocxBodySafeAnchor[]): string[] {
  return details
    .map((detail) => detail.text.trim())
    .filter((anchor) => isLanguagePolishAnchor(anchor))
    .filter(uniqueCompactAnchorFilter())
    .slice(0, 6);
}

function isLanguagePolishAnchor(anchor: string): boolean {
  return languagePolishIssueLabels(anchor).length > 0;
}

function formatLanguagePolishStatusTitle(anchors: string[]): string {
  const issueLabels = anchors
    .flatMap((anchor) => languagePolishIssueLabels(anchor))
    .filter((label, index, all) => all.indexOf(label) === index);
  const issueSummary = issueLabels.length
    ? ` Issues found: ${issueLabels.slice(0, 5).join("; ")}${issueLabels.length > 5 ? "..." : ""}.`
    : "";
  return `Load a narrow tracked-change-safe language-polish prompt using ${labelCount(anchors.length, "typo-prone clean source-text sample")}.${issueSummary}`;
}

function languagePolishIssueLabels(anchor: string): string[] {
  return [
    { label: "spelling: common misspelling", pattern: /\b(?:seperate|occured|recieve|accomodate|definately|untill|wich|teh|thier)\b/i },
    { label: "repeated word", pattern: /\b(\w+)\s+\1\b/i },
    { label: "tense consistency: anticipate", pattern: /\bwe anticipated that\b/i },
    { label: "capitalization: however after semicolon", pattern: /;\s+However\b/ },
    { label: "usage: these data", pattern: /\bthis data\b/i },
    { label: "hyphenation: single-molecule", pattern: /\bsingle molecule (?:resolution|level|data|states?|measurements?)\b/i },
    { label: "hyphenation: genome-wide", pattern: /\bgenome wide\b/i }
  ]
    .filter(({ pattern }) => pattern.test(anchor))
    .map(({ label }) => label);
}

function buildSourceMovedRefreshInstruction(sourceMovedCount: number): string {
  return `Refresh the ${labelCount(sourceMovedCount, "pending Missing target suggestion")} against the current document. Keep only the still-useful revision ideas, retarget them to exact current text, skip obsolete items, and preserve citations, formulas, figures, field-like placeholders, and technical meaning.`;
}

function verificationNoteCandidates(documentText: string): string[] {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const match of documentText.matchAll(/\[VERIFY[^\]\n]{0,180}\]/gi)) {
    const note = compactBodySafeAnchorText(match[0]);
    const key = note.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      notes.push(note);
    }
    if (notes.length >= verificationNoteLimit) {
      break;
    }
  }
  return notes;
}

function uniqueCompactAnchorFilter(): (anchor: string) => boolean {
  const seenAnchors = new Set<string>();
  return (anchor: string) => {
    const compact = compactBodySafeAnchorText(anchor);
    if (!compact || seenAnchors.has(compact)) {
      return false;
    }
    seenAnchors.add(compact);
    return true;
  };
}

function bodySafeThinAimSections(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .filter(([section, count]) => count <= 1 && /^Aim\s+\d/i.test(section))
    .map(([section]) => section);
}

function formatBodySafeAnchorCoverage(details: DocxBodySafeAnchor[], candidates: string[]): string {
  const candidateSet = new Set(candidates.map((candidate) => compactBodySafeAnchorText(candidate)).filter(Boolean));
  const counts = new Map<string, number>();
  for (const detail of details) {
    const anchor = compactBodySafeAnchorText(detail.text);
    if (!anchor || !candidateSet.has(anchor)) {
      continue;
    }
    const label = bodySafeCoverageSectionLabel(detail.section);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (!counts.size) {
    return "";
  }
  const coverage = [...counts.entries()].map(([section, count]) => `${section}: ${count}`).join("; ");
  const thinSections = bodySafeThinAimSections(counts);
  const thinWarning = thinSections.length
    ? ` Thin Aim coverage: ${thinSections.join(", ")}. For thin sections, prefer a narrower section pass or expect Word comments if no ordinary body text is available.`
    : "";
  return `DOCX-safe source-text coverage in this prompt: ${coverage}.${thinWarning}`;
}

function bodySafeCoverageSectionLabel(section: string | null | undefined): string {
  const trimmed = section?.trim();
  if (!trimmed) {
    return "Unlabeled";
  }
  const aimMatch = trimmed.match(/^Aim\s+(\d+)/i);
  if (aimMatch) {
    return `Aim ${aimMatch[1]}`;
  }
  return trimmed.replace(/[.:;,\s]+$/g, "");
}

function bodySafeMapSectionLabel(section: string | null | undefined): string {
  const trimmed = section?.trim();
  return trimmed ? trimmed.replace(/[.:;,\s]+$/g, "") : "Unlabeled";
}

function anchorDetailsFromImport(anchors: string[], details: DocxBodySafeAnchor[] | undefined): DocxBodySafeAnchor[] {
  if (details?.length) {
    return details.filter((detail) => typeof detail.text === "string" && detail.text.trim());
  }
  return anchors.map((text) => ({ section: null, text }));
}

function isBodySafeAnchorCandidate(sentence: string): boolean {
  if (sentence.length < 80 || sentence.length > 260) {
    return false;
  }
  if (/^(figure|fig\.|table|aim\s+\d|specific aim|references|bibliography)\b/i.test(sentence)) {
    return false;
  }
  if (isFigurePanelFragment(sentence)) {
    return false;
  }
  if (/[{}\[\]$]|\\cite|\\ref|<|>/.test(sentence)) {
    return false;
  }
  return /[a-z]/i.test(sentence) && sentence.split(/\s+/).length >= 12;
}

function isFigurePanelFragment(sentence: string): boolean {
  return /^\([A-Z]\)\s/.test(sentence.trim()) || /\([A-Z]\)[^.!?]{12,}\([A-Z]\)/.test(sentence);
}

function writerRoutineRunReport(report: ExportReport | null, suggestions: AiSuggestion[] = []) {
  if (!report) {
    return null;
  }
  return {
    totalSuggestions: report.totalSuggestions,
    matchedSuggestions: report.matchedSuggestions,
    matchedSuggestionIds: report.matchedSuggestionIds,
    matchedSuggestionTitles: report.matchedSuggestionTitles ?? [],
    commentedSuggestions: report.commentedSuggestions,
    commentedSuggestionIds: report.commentedSuggestionIds,
    commentedSuggestionOriginals: failedSuggestionOriginals(report.commentedSuggestionIds, report.commentedSuggestionTitles, suggestions),
    commentedSuggestionReasons: report.commentedSuggestionReasons,
    commentedSuggestionTitles: report.commentedSuggestionTitles,
    unmatchedSuggestions: report.unmatchedSuggestions,
    unmatchedSuggestionIds: report.unmatchedSuggestionIds,
    unmatchedSuggestionOriginals: failedSuggestionOriginals(report.unmatchedSuggestionIds, report.unmatchedSuggestionTitles, suggestions),
    unmatchedSuggestionTitles: report.unmatchedSuggestionTitles
  };
}

function failedOriginalSpansForExportReport(report: ExportReport, suggestions: AiSuggestion[]): string[] {
  return [
    ...failedSuggestionOriginals(report.commentedSuggestionIds, report.commentedSuggestionTitles, suggestions),
    ...failedSuggestionOriginals(report.unmatchedSuggestionIds, report.unmatchedSuggestionTitles, suggestions)
  ];
}

function failedSuggestionOriginals(ids: string[], titles: string[], suggestions: AiSuggestion[]): string[] {
  const originals = suggestions
    .filter((suggestion) => reportListIncludes(ids, titles, suggestion))
    .map((suggestion) => suggestion.original.trim())
    .filter(Boolean);
  return [...new Set(originals)].slice(0, 8);
}

function formatFailedOriginalSpans(originals: string[]): string {
  if (!originals.length) {
    return "";
  }
  return `Do not reuse these previous failed original spans: ${originals.map((original) => `"${truncate(original, 220)}"`).join("; ")}. Choose different nearby ordinary body sentences instead.`;
}

function routineRunLabel(run: WriterRoutineRun, index = 0): string {
  const prefix = index === 0 ? "Latest export" : "Earlier export";
  if (!run.report) {
    return `${prefix}: ${run.label}`;
  }
  const comments = run.report.commentedSuggestions
    ? `, ${run.report.commentedSuggestions} Word comment${run.report.commentedSuggestions === 1 ? "" : "s"}`
    : "";
  const unresolved = run.report.unmatchedSuggestions
    ? `, ${run.report.unmatchedSuggestions} unresolved`
    : ", 0 unmatched";
  return `${prefix}: ${run.label} (${labelTrackedCount(run.report.matchedSuggestions)}${comments}${unresolved})`;
}

function routineRunArtifactName(artifactPath: string): string {
  return artifactPath.split(/[\\/]/).filter(Boolean).pop() || "review.docx";
}

function formatSuggestionClipboardPacket(suggestions: AiSuggestion[], filter: ReviewFilter): string {
  const title = `Nebula Writer review edits - ${reviewFilterLabel(filter)} (${labelCount(suggestions.length, "edit")})`;
  const entries = suggestions.map((suggestion, index) => [
    `${index + 1}. ${suggestion.title}`,
    `Status: ${suggestion.status}`,
    `Confidence: ${Math.round(suggestion.confidence * 100)}%`,
    "Original:",
    suggestion.original,
    "Proposed:",
    suggestion.replacement,
    "Rationale:",
    reviewQueueDisplayText(suggestion.rationale)
  ].join("\n"));
  return [title, ...entries].join("\n\n");
}

export function formatWordCommentOverlapGroupClipboardPacket(anchorSuggestion: AiSuggestion, suggestions: AiSuggestion[]): string {
  const title = `Nebula Writer same-source Word comments - ${anchorSuggestion.title} (${labelCount(suggestions.length, "comment")})`;
  const guidance = "These Word comments target the same original source text. The lead card is a starting point chosen by broadest source text and confidence; choose one winner before manual insertion in Word.";
  const sourceTarget = [
    `Clicked card: ${anchorSuggestion.title}`,
    "Shared source text target:",
    anchorSuggestion.original
  ].join("\n");
  const entries = suggestions.map((suggestion, index) => [
    `${index + 1}. ${suggestion.title}`,
    `Status: ${suggestion.status}`,
    `Confidence: ${Math.round(suggestion.confidence * 100)}%`,
    "Original:",
    suggestion.original,
    "Proposed:",
    suggestion.replacement,
    "Rationale:",
    reviewQueueDisplayText(suggestion.rationale)
  ].join("\n"));
  return [title, guidance, sourceTarget, ...entries].join("\n\n");
}

export function formatWordCommentOverlapTriageClipboardPacket(suggestions: AiSuggestion[]): string {
  const groups = wordCommentOverlapGroups(suggestions);
  if (!groups.length) {
    return "# Same-Source Word Comment Triage Packet\n\nNo same-source Word-comment groups are currently detected.";
  }
  const lines = [
    "# Same-Source Word Comment Triage Packet",
    "",
    `Shared targets: ${groups.length}`,
    `Same-source Word comments: ${groups.reduce((sum, group) => sum + group.length, 0)}`,
    "",
    `${labelCount(groups.length, "shared text target") ?? "Shared text targets"} representing ${labelCount(groups.reduce((sum, group) => sum + group.length, 0), "same-source Word comment") ?? "same-source Word comments"}.`,
    "Lead cards are starting points chosen by broadest source text and confidence.",
    "Use Copy group on a lead card when you need the full original and proposed text for one target.",
    ""
  ];
  groups.forEach((group, index) => {
    const leadSuggestion = wordCommentOverlapLeadSuggestion(group);
    const competingTitles = group
      .filter((suggestion) => suggestion.id !== leadSuggestion.id)
      .map((suggestion) => suggestion.title);
    lines.push(
      `## ${index + 1}. ${leadSuggestion.title}`,
      `Group size: ${labelCount(group.length, "Word comment") ?? "Word comments"}`,
      `Lead id: ${leadSuggestion.id}`,
      `Suggestion ids: ${group.map((suggestion) => suggestion.id).join(", ")}`,
      `Lead card: ${leadSuggestion.title}`,
      `Competing titles: ${competingTitles.length ? compactTitleList(competingTitles, 6) : "None"}`,
      `Shared source preview: ${truncate(compactBodySafeAnchorText(leadSuggestion.original), 500)}`,
      `Lead replacement preview: ${truncate(compactBodySafeAnchorText(leadSuggestion.replacement), 500)}`,
      ""
    );
  });
  return lines.join("\n").trimEnd();
}

function formatRoutineSuggestionClipboardPacket(run: WriterRoutineRun, suggestions: AiSuggestion[]): string {
  const artifactPath = run.downloadCopyPath || run.artifactPath;
  const heading = [
    `Nebula Writer review edits - ${run.label} (${labelCount(suggestions.length, "edit")})`,
    artifactPath ? `Review DOCX: ${artifactPath}` : null,
    run.reportPath ? `Report JSON: ${run.reportPath}` : null
  ].filter(Boolean).join("\n");
  const entries = suggestions.map((suggestion, index) => [
    `${index + 1}. ${suggestion.title}`,
    `Status: ${suggestion.status}`,
    `Confidence: ${Math.round(suggestion.confidence * 100)}%`,
    "Original:",
    suggestion.original,
    "Proposed:",
    suggestion.replacement,
    "Rationale:",
    reviewQueueDisplayText(suggestion.rationale)
  ].join("\n"));
  return [heading, ...entries].join("\n\n");
}

function formatRoutineWordCommentClipboardPacket(run: WriterRoutineRun, suggestions: AiSuggestion[]): string {
  const artifactPath = run.downloadCopyPath || run.artifactPath;
  const heading = [
    `Nebula Writer Word-comment handoff - ${run.label} (${labelCount(suggestions.length, "comment")})`,
    artifactPath ? `Review DOCX: ${artifactPath}` : null,
    run.reportPath ? `Report JSON: ${run.reportPath}` : null,
    run.suggestionsPath ? `Full suggestion text: ${run.suggestionsPath}` : "Full suggestion text: loaded review queue"
  ].filter(Boolean).join("\n");
  const report = run.report ?? null;
  const entries = suggestions.map((suggestion, index) => {
    const reason = report
      ? reportReasonForSuggestion(
        report.commentedSuggestionIds ?? [],
        report.commentedSuggestionTitles ?? [],
        report.commentedSuggestionReasons ?? [],
        suggestion
      )
      : "";
    return [
      `${index + 1}. ${suggestion.title}`,
      `Status: ${suggestion.status}`,
      `Confidence: ${Math.round(suggestion.confidence * 100)}%`,
      reason ? `Word comment reason: ${formatPlacementReasonForDisplay(reason)}` : "Word comment reason: Preserved as a Word comment during export.",
      "Original:",
      suggestion.original,
      "Proposed:",
      suggestion.replacement,
      "Rationale:",
      reviewQueueDisplayText(suggestion.rationale)
    ].join("\n");
  });
  return [heading, ...entries].join("\n\n");
}

function reviewQueueDisplayText(value: string): string {
  return formatPlacementReasonForDisplay(value)
    .replace(/\bstale Source moved suggestion\b/g, "stale Missing target suggestion")
    .replace(/\bSource moved suggestion\b/g, "Missing target suggestion")
    .replace(/\bSource moved\b/g, "Missing target");
}

function formatPlacementReasonForDisplay(value: string): string {
  return value
    .replace(/\bAnchored Word comment\b/g, "Word comment")
    .replace(/\banchored Word comment\b/g, "Word comment")
    .replace(/\banchored replacement edits?\b/gi, "exact-source replacement edits")
    .replace(/\banchored suggestions?\b/gi, "exact-source suggestions")
    .replace(/\banchored edits?\b/gi, "exact-source edits")
    .replace(/\bexact anchors?\b/gi, "exact source-text targets")
    .replace(/\bbody anchors?\b/gi, "body text targets")
    .replace(/\bsafe body anchors?\b/gi, "safe body text")
    .replace(/\boriginal anchor\b/gi, "original text target")
    .replace(/\bsource anchor\b/gi, "source text target")
    .replace(/\bThe anchor\b/g, "The source text")
    .replace(/\bAnchor overlaps\b/g, "Source text overlaps")
    .replace(/\bAnchor appears\b/g, "Source text appears")
    .replace(/\bAnchor was\b/g, "Source text was")
    .replace(/\bAnchor is\b/g, "Source text is")
    .replace(/\bAnchor already\b/g, "Source text already")
    .replace(/\bthe anchor\b/gi, "the source text")
    .replace(/\banchor overlaps\b/gi, "source text overlaps")
    .replace(/\banchor appears\b/gi, "source text appears")
    .replace(/\banchor was\b/gi, "source text was")
    .replace(/\banchor is\b/gi, "source text is")
    .replace(/\banchor already\b/gi, "source text already")
    .replace(/\banchor\b/gi, "source text");
}

function reviewFilterLabel(filter: ReviewFilter): string {
  if (filter === "latest") {
    return "Latest export";
  }
  if (filter === "priority") {
    return "Priority";
  }
  if (filter === "clean") {
    return "Clean packet";
  }
  if (filter === "conflicts") {
    return "Conflicts";
  }
  if (filter === "source-moved") {
    return "Missing target";
  }
  if (filter === "source-revisions") {
    return "Source revisions";
  }
  if (filter === "duplicates") {
    return "Same-source comments";
  }
  if (filter === "word-comments") {
    return "Word comments";
  }
  if (filter === "fact-checks") {
    return "PI/fact checks";
  }
  if (filter === "all") {
    return "All";
  }
  return "Pending";
}

function reviewSearchTermsForQuery(query: string): string[] {
  return normalizeText(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function filterSuggestionsByReviewSearch(suggestions: AiSuggestion[], terms: string[]): AiSuggestion[] {
  if (!terms.length) {
    return suggestions;
  }
  return suggestions.filter((suggestion) => {
    const haystack = normalizeText([
      suggestion.title,
      suggestion.original,
      suggestion.replacement,
      suggestion.rationale
    ].join(" ")).toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function sourceRevisionMatchesSearch(change: SourceTrackedChangePreview, terms: string[]): boolean {
  if (!terms.length) {
    return true;
  }
  const haystack = normalizeText([
    sourceTrackedChangeKindLabel(change.kind),
    change.text,
    change.author ?? "",
    change.date ?? ""
  ].join(" ")).toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function uniqueSuggestionsById(suggestions: AiSuggestion[]): AiSuggestion[] {
  const seen = new Set<string>();
  const unique: AiSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.id)) {
      continue;
    }
    seen.add(suggestion.id);
    unique.push(suggestion);
  }
  return unique;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the DOM copy path for stricter embedded browsers.
    }
  }

  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function reviewDownloadFilename(documentTitle: string, context: RoutineIntent | null): string {
  const documentStem = sanitizeDownloadStem(documentTitle || "nebula-writer");
  const routineStem = context?.label ? `_${sanitizeDownloadStem(context.label)}` : "";
  return `${documentStem}${routineStem}_${reviewDownloadTimestamp()}_review.docx`;
}

function reviewDownloadTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sanitizeDownloadStem(value: string): string {
  return value.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}

function trackedExportNote(report: ExportReport | null): string {
  if (!report || report.totalSuggestions === 0) {
    return "Exported source-preserving review DOCX";
  }
  if (report.commentedSuggestions > 0 && report.unmatchedSuggestions > 0) {
    return `Exported review DOCX (${labelTrackedCount(report.matchedSuggestions)}; ${report.commentedSuggestions} as Word comments; ${report.unmatchedSuggestions} unresolved)`;
  }
  if (report.commentedSuggestions > 0) {
    return `Exported review DOCX (${labelTrackedCount(report.matchedSuggestions)}; ${report.commentedSuggestions} as Word comments)`;
  }
  if (report.unmatchedSuggestions === 0) {
    return `Exported tracked-change DOCX (${report.matchedSuggestions}/${report.totalSuggestions} matched)`;
  }
  return `Exported tracked-change DOCX (${report.matchedSuggestions}/${report.totalSuggestions} matched; ${report.unmatchedSuggestions} unresolved)`;
}

function trackedExportPanelSummary(report: ExportReport): string {
  const tracked = labelTrackedCount(report.matchedSuggestions);
  if (report.commentedSuggestions > 0 && report.unmatchedSuggestions > 0) {
    return `Last export: ${tracked}, ${report.commentedSuggestions} Word comment${report.commentedSuggestions === 1 ? "" : "s"}, ${report.unmatchedSuggestions} unresolved`;
  }
  if (report.commentedSuggestions > 0) {
    return `Last export: ${tracked}, ${report.commentedSuggestions} Word comment${report.commentedSuggestions === 1 ? "" : "s"}`;
  }
  if (report.unmatchedSuggestions > 0) {
    return `Last export: ${tracked}, ${report.unmatchedSuggestions} unresolved`;
  }
  return `Last export: ${tracked}`;
}

function sequenceExportSummaryLabel(summary: SequenceExportSummary): string {
  if (!summary.report) {
    return `${summary.label} exported as a review DOCX.`;
  }
  return `${summary.label} exported: ${trackedExportPanelSummary(summary.report).replace(/^Last export: /, "")}.`;
}

function trackedExportPanelDetail(report: ExportReport, options: ExportReportDisplayOptions = {}): string {
  if (report.unmatchedSuggestions > 0) {
    const titles = report.unmatchedSuggestionTitles.filter(Boolean);
    const visibleTitles = titles.slice(0, 2).join("; ");
    const suffix = titles.length > 2 ? `; +${titles.length - 2} more` : "";
    const commentNote = report.commentedSuggestions > 0
      ? ` ${report.commentedSuggestions} other suggestion${report.commentedSuggestions === 1 ? "" : "s"} exported as Word comment${report.commentedSuggestions === 1 ? "" : "s"}.`
      : "";
    return visibleTitles
      ? `Could not place: ${visibleTitles}${suffix}.${commentNote}`
      : `Some suggestions could not be placed safely in the DOCX.${commentNote}`;
  }

  if (report.commentedSuggestions > 0) {
    const titles = report.commentedSuggestionTitles.filter(Boolean);
    const visibleTitles = titles.slice(0, 2).join("; ");
    const suffix = titles.length > 2 ? `; +${titles.length - 2} more` : "";
    const reason = report.commentedSuggestionReasons[0] ? ` Reason: ${formatPlacementReasonForDisplay(report.commentedSuggestionReasons[0])}` : "";
    const cumulativeReason = formatCommentFallbackReasonSentence(report.commentedSuggestionReasons);
    if (options.wordCommentHandoff && report.unmatchedSuggestions === 0) {
      return visibleTitles
        ? `Word review carrier: ${visibleTitles}${suffix}.${reason} Review these comments in Word; tracked changes are included alongside them.`
        : `Word review carrier: ${report.commentedSuggestions} Word comment${report.commentedSuggestions === 1 ? "" : "s"} ready for Word review.${reason} Tracked changes are included alongside them.`;
    }
    if (options.cumulativeHandoff && report.unmatchedSuggestions === 0) {
      return visibleTitles
        ? `Cumulative handoff: review ${report.matchedSuggestions} body tracked change${report.matchedSuggestions === 1 ? "" : "s"} first, then resolve Word comments for ${visibleTitles}${suffix}.${cumulativeReason} Check nearby accepted text before inserting large comment rewrites, alternative section rewrites, or PI-supplied fact checks.`
        : `Cumulative handoff: review ${report.matchedSuggestions} body tracked change${report.matchedSuggestions === 1 ? "" : "s"} first, then resolve ${report.commentedSuggestions} Word comment${report.commentedSuggestions === 1 ? "" : "s"}.${cumulativeReason} Check nearby accepted text before inserting large comment rewrites, alternative section rewrites, or PI-supplied fact checks.`;
    }
    return visibleTitles
      ? `Open Word comments for: ${visibleTitles}${suffix}.${reason}`
      : `Some suggestions touched protected Word structures, so they were preserved as Word comments.${reason}`;
  }

  return "Every suggestion in this export was placed as a body tracked change.";
}

function suggestionLengthWarning(suggestion: AiSuggestion): { label: string; title: string } | null {
  if (suggestion.replacement.length <= bodySafeReplacementCharacterLimit) {
    return null;
  }
  return {
    label: "Long replacement",
    title: `This replacement is ${suggestion.replacement.length} characters. Body-safe refinement exports are more reliable when replacements stay under ${bodySafeReplacementCharacterLimit} characters.`
  };
}

function pendingSuggestionAnchorCountMap(suggestions: AiSuggestion[]): Map<string, number> {
  const counts = new Map<string, number>();
  suggestions.forEach((suggestion) => {
    const key = normalizeText(suggestion.original);
    if (!key) {
      return;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

function conflictAnchorGroupCount(pendingAnchorCounts: Map<string, number>): number {
  return [...pendingAnchorCounts.values()].filter((count) => count > 1).length;
}

function pendingSuggestionAnchorPositionMap(suggestions: AiSuggestion[]): Map<string, { count: number; position: number }> {
  const groups = new Map<string, AiSuggestion[]>();
  suggestions.forEach((suggestion) => {
    const key = normalizeText(suggestion.original);
    if (!key || suggestion.status !== "pending") {
      return;
    }
    groups.set(key, [...(groups.get(key) ?? []), suggestion]);
  });
  const positions = new Map<string, { count: number; position: number }>();
  groups.forEach((items) => {
    items.forEach((suggestion, index) => {
      positions.set(suggestion.id, { count: items.length, position: index + 1 });
    });
  });
  return positions;
}

function pendingSuggestionsSortedByAnchorConflict(suggestions: AiSuggestion[], pendingAnchorCounts: Map<string, number>): AiSuggestion[] {
  const firstIndexByAnchor = new Map<string, number>();
  suggestions.forEach((suggestion, index) => {
    const key = normalizeText(suggestion.original);
    if (key && !firstIndexByAnchor.has(key)) {
      firstIndexByAnchor.set(key, index);
    }
  });
  return suggestions
    .map((suggestion, index) => ({ anchor: normalizeText(suggestion.original), suggestion, index }))
    .filter(({ suggestion }) => pendingSuggestionAnchorCount(pendingAnchorCounts, suggestion) > 1)
    .sort((a, b) => {
      const countDelta = pendingSuggestionAnchorCount(pendingAnchorCounts, b.suggestion) - pendingSuggestionAnchorCount(pendingAnchorCounts, a.suggestion);
      if (countDelta !== 0) {
        return countDelta;
      }
      const firstIndexDelta = (firstIndexByAnchor.get(a.anchor) ?? a.index) - (firstIndexByAnchor.get(b.anchor) ?? b.index);
      if (firstIndexDelta !== 0) {
        return firstIndexDelta;
      }
      const lengthDelta = b.anchor.length - a.anchor.length;
      if (lengthDelta !== 0) {
        return lengthDelta;
      }
      return a.index - b.index;
    })
    .map(({ suggestion }) => suggestion);
}

function topConflictAnchorSummary(suggestions: AiSuggestion[]): { count: number; preview: string } | null {
  const groups = new Map<string, AiSuggestion[]>();
  suggestions.forEach((suggestion) => {
    if (suggestion.status !== "pending") {
      return;
    }
    const key = normalizeText(suggestion.original);
    if (!key) {
      return;
    }
    groups.set(key, [...(groups.get(key) ?? []), suggestion]);
  });
  const topGroup = [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .sort((a, b) => b[1].length - a[1].length || b[0].length - a[0].length)[0];
  if (!topGroup) {
    return null;
  }
  const [anchor, items] = topGroup;
  return {
    count: items.length,
    preview: compactConflictAnchorPreview(anchor)
  };
}

function compactConflictAnchorPreview(anchor: string): string {
  const normalized = normalizeText(anchor);
  if (normalized.length <= 88) {
    return normalized;
  }
  return `${normalized.slice(0, 85).trimEnd()}...`;
}

function sharedRunSuggestionIdSet(runs: WriterRoutineRun[]): Set<string> {
  const ids = new Set<string>();
  runs.forEach((run) => {
    [
      ...(run.report?.matchedSuggestionIds ?? []),
      ...(run.report?.commentedSuggestionIds ?? []),
      ...(run.report?.unmatchedSuggestionIds ?? [])
    ].forEach((id) => ids.add(id));
  });
  return ids;
}

function pendingSharedAnchorAlternativesWithExportedWinner(suggestions: AiSuggestion[], exportedSuggestionIds: Set<string>): AiSuggestion[] {
  const groups = new Map<string, AiSuggestion[]>();
  suggestions.forEach((suggestion) => {
    if (suggestion.status !== "pending") {
      return;
    }
    const key = normalizeText(suggestion.original);
    if (!key) {
      return;
    }
    groups.set(key, [...(groups.get(key) ?? []), suggestion]);
  });
  const alternatives: AiSuggestion[] = [];
  groups.forEach((items) => {
    if (items.length <= 1) {
      return;
    }
    const exportedPendingItems = items.filter((suggestion) => exportedSuggestionIds.has(suggestion.id));
    if (exportedPendingItems.length !== 1) {
      return;
    }
    items.forEach((suggestion) => {
      if (!exportedSuggestionIds.has(suggestion.id)) {
        alternatives.push(suggestion);
      }
    });
  });
  return alternatives;
}

export function pendingSuggestionsForCleanPacket(
  suggestions: AiSuggestion[],
  pendingAnchorCounts: Map<string, number>,
  normalizedDocumentText: string
): AiSuggestion[] {
  return suggestions.filter((suggestion) => (
    suggestion.status === "pending"
    && Boolean(normalizeText(suggestion.original))
    && pendingSuggestionAnchorCount(pendingAnchorCounts, suggestion) <= 1
    && !suggestionAnchorVisibilityWarning(suggestion, normalizedDocumentText)
  ));
}

function suggestionAnchorConflictWarning(
  suggestion: AiSuggestion,
  pendingAnchorCounts: Map<string, number>,
  pendingAnchorPositions: Map<string, { count: number; position: number }>
): { label: string; title: string } | null {
  if (suggestion.status !== "pending") {
    return null;
  }
  const count = pendingSuggestionAnchorCount(pendingAnchorCounts, suggestion);
  if (count <= 1) {
    return null;
  }
  const position = pendingAnchorPositions.get(suggestion.id);
  if (position) {
    return {
      label: `Same target ${position.position}/${position.count}`,
      title: `Option ${position.position} of ${position.count} for this exact original text. Review competing alternatives before accepting one.`
    };
  }
  return {
    label: `Same target x${count}`,
    title: `${count} pending suggestions use this exact original text. Review competing alternatives before accepting one.`
  };
}

function suggestionAnchorVisibilityWarning(suggestion: AiSuggestion, normalizedDocumentText: string): { label: string; title: string } | null {
  if (suggestion.status !== "pending") {
    return null;
  }
  const original = normalizeText(suggestion.original);
  if (!original || !normalizedDocumentText || normalizedDocumentText.includes(original)) {
    return null;
  }
  return {
    label: "Missing target",
    title: "This original text is not visible in the current editor text. The source DOCX may have changed or the suggestion may need a current target before acceptance."
  };
}

function manualMissingTargetWarning(): { label: string; title: string } {
  return {
    label: "Missing target",
    title: "This suggestion failed to locate in the current editor. Refresh it against current text or dismiss it before applying more changes."
  };
}

function pendingSuggestionAnchorCount(pendingAnchorCounts: Map<string, number>, suggestion: AiSuggestion): number {
  return pendingAnchorCounts.get(normalizeText(suggestion.original)) ?? 0;
}

function exportDispositionForSuggestion(report: ExportDispositionReport | null, suggestion: AiSuggestion): SuggestionExportDisposition | null {
  if (!report || report.totalSuggestions === 0) {
    return null;
  }
  if (reportListIncludes(report.unmatchedSuggestionIds ?? [], report.unmatchedSuggestionTitles ?? [], suggestion)) {
    return {
      kind: "unresolved",
      label: "Unresolved",
      title: "This suggestion could not be placed safely during the last Word review export."
    };
  }
  if (reportListIncludes(report.commentedSuggestionIds ?? [], report.commentedSuggestionTitles ?? [], suggestion)) {
    const reason = reportReasonForSuggestion(report.commentedSuggestionIds ?? [], report.commentedSuggestionTitles ?? [], report.commentedSuggestionReasons ?? [], suggestion);
    return {
      kind: "commented",
      label: "Word comment",
      title: reason ? `This suggestion was preserved as a Word comment. ${formatPlacementReasonForDisplay(reason)}` : "This suggestion was preserved as a Word comment during the last review export."
    };
  }
  if (reportListIncludes(report.matchedSuggestionIds ?? [], report.matchedSuggestionTitles ?? [], suggestion)) {
    return {
      kind: "tracked",
      label: "Tracked in Word",
      title: "This suggestion became a body tracked change during the last review export."
    };
  }
  return null;
}

function reportListIncludes(ids: string[], titles: string[], suggestion: AiSuggestion): boolean {
  return ids.length > 0 ? ids.includes(suggestion.id) : titles.includes(suggestion.title);
}

function reportReasonForSuggestion(ids: string[], titles: string[], reasons: string[], suggestion: AiSuggestion): string {
  const idIndex = ids.indexOf(suggestion.id);
  if (ids.length > 0) {
    return idIndex >= 0 ? reasons[idIndex] ?? "" : "";
  }
  const titleIndex = titles.indexOf(suggestion.title);
  return titleIndex >= 0 ? reasons[titleIndex] ?? "" : "";
}

function recordReviewNavigationPointerDown(pointerDownRef: { current: ReviewNavigationPointerDown | null }) {
  return (event: MouseEvent<HTMLElement>) => {
    pointerDownRef.current = event.button === 0
      ? { container: event.currentTarget, x: event.clientX, y: event.clientY }
      : null;
  };
}

function shouldIgnoreReviewNavigationClick(
  event: MouseEvent<HTMLElement>,
  pointerDownRef: { current: ReviewNavigationPointerDown | null }
): boolean {
  const pointerDown = pointerDownRef.current;
  pointerDownRef.current = null;

  if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return true;
  }
  if (isReviewNavigationTextTarget(event.target)) {
    return true;
  }
  if (hasTextSelectionInside(event.currentTarget)) {
    return true;
  }
  if (!pointerDown || pointerDown.container !== event.currentTarget) {
    return false;
  }
  return Math.abs(event.clientX - pointerDown.x) > 4 || Math.abs(event.clientY - pointerDown.y) > 4;
}

function isReviewNavigationTextTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function hasTextSelectionInside(container: HTMLElement): boolean {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    return false;
  }
  return selectionContainsNode(container, selection.anchorNode)
    || selectionContainsNode(container, selection.focusNode)
    || Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
      .some((range) => selectionContainsNode(container, range.commonAncestorContainer));
}

function selectionContainsNode(container: HTMLElement, node: Node | null): boolean {
  return Boolean(node && container.contains(node));
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

function exportFilePickerTypes(filename: string): SaveFilePickerAcceptType[] {
  if (/\.json$/i.test(filename)) {
    return [{
      accept: { "application/json": [".json"] },
      description: "JSON session snapshot"
    }];
  }
  if (/\.docx$/i.test(filename)) {
    return [{
      accept: { "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"] },
      description: "Word document"
    }];
  }
  return [];
}

async function saveBlobWithDownloadPrompt(blob: Blob, filename: string): Promise<boolean> {
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        startIn: "downloads",
        types: exportFilePickerTypes(filename)
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      if (isAbortError(error)) {
        return false;
      }
      throw error;
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}

function labelTrackedCount(count: number): string {
  return `${count} tracked change${count === 1 ? "" : "s"}`;
}
