import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, open, readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { exportDocx, exportTrackedChangesFromSourceWithReport, importDocx, type TrackedChangeExportReport, extractDocxImages } from "./docx";
import { getAiProgress, getAiQueue, proposeChanges, smokeTestProvider } from "./ai";
import { AI_ATTACHMENT_LIMIT, AI_ATTACHMENT_TEXT_CHAR_LIMIT, AI_ATTACHMENTS_TOTAL_CHAR_LIMIT, type AiAttachment, type AiProviderName, type AiRequest, type AiSuggestion, type DocxBodySafeAnchor, type DocxFeatureSummary, type ExportRequest, type ImportedDocument, type LocalAiProviderName, type SelectionContext, type SourceTrackedChangePreview, type WordLiveSuggestionRequest, type WriterAutosavedSessionSummary, type WriterChatMessage, type WriterReviewSourceDocument, type WriterRoutineRun, type WriterRoutineRunReport, type WriterSessionDocument, type WriterSessionSnapshot, type WriterSessionSummary, isAiToolAccess, AI_DOCUMENT_IMAGE_LIMIT, type AiDocumentImage, type AiRequestFocus } from "../src/shared";
import { cliEnablementDiagnostic, isCliExecutionEnabled, resolveCliCommand, resolveCliTimeoutConfig } from "./cli-runtime";
import { currentHostContext, getAgentRun, readAgentRunAttachment, readAgentRunDocument, searchAgentRunDocument, setLiveHostContextSource, stageAgentRunSuggestions, type AgentRunContext } from "./agent-run";
import { readAgentRunContext } from "./agent-context";
import { hostContextSelection, parseWordHostContext } from "./word-context";
import { getProviderCatalogs, validateModelOptions } from "./model-catalog";
import { cliChildEnv } from "./ai";
import type { AiConversationDecision, AiConversationTurn, WordHostContext, WordHostContextUpdate, WordHostContextUpdateResponse } from "../src/shared";
import { isSuggestionAnchor } from "../src/shared";
import { agentTerminalStatus, ensureAgentTerminal } from "./agent-terminal";
import { restartTerminalRoom } from "./terminal-pty";
import { bridgeStatus, bridgedSuggestions, cloudSyncBaseUrl, ensureCloudBridge, publishSuggestionsToBridge, registerCollabBridgeHooks } from "./collab-bridge";
import { inlineSuggestionDiagnostics, listInlineSuggestions, resolveInlineSuggestion } from "./inline-suggestions";
import { writerAttachmentsDirectory, writerRecoveryDirectory } from "./maintenance";
import { IMAGE_ROUTE_PREFIX, imageMimeForName, isStoredImagePath, servedImagePath, storeImageBytes } from "./image-files";
import { supersedeRevisedSuggestions } from "./revisions";
import { liveCollabDocumentText, scheduleSessionUpdateBroadcast } from "./realtime";
import { getShareToken, isShareModeEnabled, shareAuthMiddleware } from "./shareAuth";
import { r01RoutineSequence } from "../src/writingRoutines";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const importedDocuments = new Map<string, Buffer>();
type WriterRoutineState = Pick<WriterSession, "routineProgress" | "routineRuns" | "suggestions"> & {
  chatMessages?: WriterChatMessage[];
  sourceTrackedChanges?: SourceTrackedChangePreview[];
};
const routineStateByDocumentPath = new Map<string, WriterRoutineState>();
const sessionReportOriginalPreviewLimit = 280;
const sessionSnapshotProbeBytes = 8192;
const wordLiveSourceDocumentPrefix = "word-live:";
const r01RoutineSequenceIds = new Set(r01RoutineSequence.map((routine) => routine.id));
// Per-process identity: suggestions staged through this sidecar are stamped
// with it, and only this sidecar's clients claim them for inline landing on
// shared docs (a remote Writer's clients skip, so servers never race).
const serverInstanceId = randomUUID();

function stampOrigin(suggestions: AiSuggestion[]): AiSuggestion[] {
  return suggestions.map((suggestion) => suggestion.origin ? suggestion : { ...suggestion, origin: serverInstanceId });
}

let activeWriterSession: WriterSession | null = null;
let activeWriterSessionPath: string | null = null;
let writerSessionRevisionCounter = 0;

// Latest window state pushed by the Word add-in (caret, selection, pages on
// screen, recent focus). Terminal/MCP agents reading the "live" run see it
// when the active session is that Word document, so "this paragraph"
// resolves for them exactly as it does for the pane's own requests.
let wordHostState: { documentName: string; sourceDocumentId: string; hostContext: WordHostContext; documentImages: AiDocumentImage[]; receivedAt: string } | null = null;

// Agentic runs and the terminal agent read the add-in's latest push through
// this source, so "the paragraph at the caret" follows the author mid-run.
setLiveHostContextSource(() => (wordHostState ? { documentName: wordHostState.documentName, hostContext: wordHostState.hostContext } : null));

function rememberWordHostContext(documentName: string, hostContext: WordHostContext | null | undefined, documentImages?: AiDocumentImage[]): void {
  if (!hostContext) {
    return;
  }
  const sourceDocumentId = wordLiveSourceDocumentId(documentName);
  wordHostState = {
    documentName,
    sourceDocumentId,
    hostContext,
    // Images arrive with AI requests, not with every context push: keep the
    // last set for the same document so terminal agents can see figures too.
    documentImages: documentImages ?? (wordHostState?.sourceDocumentId === sourceDocumentId ? wordHostState.documentImages : []),
    receivedAt: new Date().toISOString()
  };
}

// Sessions displaced from the active slot, keyed by document id. Only sessions
// with a source DOCX get autosave snapshots on disk, so without this stash a
// displaced DRAFT session (e.g. another tab auto-promoting its blank draft)
// takes its staged suggestions, chat, and title with it — reopening the doc got
// a bare "Shared document" shell with everything wiped. Bounded LRU; in-memory
// only, same lifetime as the drafts themselves.
const MAX_DISPLACED_SESSIONS = 16;
const displacedSessions = new Map<string, { session: WriterSession; sourceDocumentPath: string | null }>();

function stashActiveSession(): void {
  const session = activeWriterSession;
  if (!session?.sourceDocumentId) {
    return;
  }
  displacedSessions.delete(session.sourceDocumentId);
  displacedSessions.set(session.sourceDocumentId, { session, sourceDocumentPath: activeWriterSessionPath });
  while (displacedSessions.size > MAX_DISPLACED_SESSIONS) {
    const oldest = displacedSessions.keys().next().value as string;
    displacedSessions.delete(oldest);
  }
}

// Monotonic revision stamped onto the session at every mutation so concurrent
// clients (a second tab, an MCP agent) can detect that their view went stale.
// Every bump also notifies connected /events websocket clients so their review
// queues refresh immediately.
function nextSessionRevision(): number {
  writerSessionRevisionCounter += 1;
  scheduleSessionUpdateBroadcast(writerSessionRevisionCounter, () => activeWriterSession?.sourceDocumentId ?? null);
  return writerSessionRevisionCounter;
}

/**
 * Document-room model: clients address documents by id (?doc=...). The sidecar
 * keeps one document's metadata active at a time; asking for a different
 * document switches focus to it, restoring its session from the autosave
 * snapshots. Live text is always safe regardless — every document has its own
 * CRDT room — and stale tabs' metadata writes are rejected by the
 * expectedSessionId guard rather than landing on the newly active document.
 */
async function activateSessionForDoc(docId: string): Promise<boolean> {
  if (activeWriterSession?.sourceDocumentId === docId) {
    return true;
  }
  // Reactivate a session this server displaced earlier (draft sessions have no
  // disk snapshot — the stash is their only home). Restores staged
  // suggestions, chat, and title instead of rebuilding a bare shell.
  const stashed = displacedSessions.get(docId);
  if (stashed) {
    displacedSessions.delete(docId);
    stashActiveSession();
    rememberActiveRoutineState();
    const liveText = liveCollabDocumentText(docId);
    activeWriterSession = typeof liveText === "string" && liveText.trim() && liveText !== stashed.session.documentText
      ? { ...stashed.session, documentText: liveText, documentHtml: htmlFromPlainText(liveText), revision: nextSessionRevision() }
      : stashed.session;
    activeWriterSessionPath = stashed.sourceDocumentPath;
    rememberActiveRoutineState();
    return true;
  }
  const records = await listAutosavedSessionRecords();
  for (const record of records) {
    if (record.snapshot.session.sourceDocumentId !== docId) {
      continue;
    }
    if (!record.snapshot.sourceDocumentPath) {
      continue;
    }
    const restored = await restoreSessionFromSnapshotSource(record.snapshot, record.snapshot.sourceDocumentPath);
    if (restored) {
      stashActiveSession();
      rememberActiveRoutineState();
      activeWriterSession = restored.session;
      activeWriterSessionPath = restored.sourceDocumentPath;
      rememberActiveRoutineState();
      return true;
    }
  }
  // A cloud-shared document this Writer has never seen (a collaborator's doc,
  // arriving through the bridge): create a session from the live room text so
  // the review queue, terminal, and exports work here too. Suggestions come
  // from the shared CRDT map. On a FIRST join the bridge may still be pulling
  // the doc from the relay, so wait briefly for the room to fill instead of
  // answering "no such document" — that answer made the client drop the doc id
  // and silently revert to a private draft.
  const bridged = bridgeStatus(docId).bridged;
  const attempts = bridged ? 20 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const liveText = liveCollabDocumentText(docId);
    if (typeof liveText === "string" && liveText.trim()) {
      stashActiveSession();
      rememberActiveRoutineState();
      activeWriterSession = createBareSessionForDoc(docId, liveText);
      activeWriterSessionPath = null;
      const shared = bridgedSuggestions(docId);
      if (shared?.length) {
        activeWriterSession = { ...activeWriterSession, suggestions: shared, revision: nextSessionRevision() };
      }
      return true;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}

function createBareSessionForDoc(docId: string, text: string): WriterSession {
  const now = new Date().toISOString();
  return {
    bodySafeAnchors: [],
    bodySafeAnchorDetails: [],
    chatMessages: [],
    documentHtml: htmlFromPlainText(text),
    documentText: text,
    features: emptyDocxFeatureSummary(),
    id: randomUUID(),
    importMessages: [],
    name: "Shared document.docx",
    revision: nextSessionRevision(),
    routineProgress: [],
    routineRuns: [],
    sourceDocument: null,
    sourceDocumentId: docId,
    sourceTrackedChanges: [],
    suggestions: [],
    title: "Shared document",
    updatedAt: now
  };
}

function requestedDocId(request: express.Request): string | null {
  const doc = request.query?.doc;
  return typeof doc === "string" && doc.trim() ? doc.trim() : null;
}

// Optional optimistic-concurrency guard: clients that include expectedSessionId
// and/or expectedRevision in a mutation request get a 409 instead of silently
// clobbering state another client changed. Clients that omit them keep the old
// last-write-wins behavior.
function sessionConflictError(body: unknown): string | null {
  if (!activeWriterSession || !body || typeof body !== "object") {
    return null;
  }
  const value = body as { expectedRevision?: unknown; expectedSessionId?: unknown };
  if (typeof value.expectedSessionId === "string" && value.expectedSessionId.trim() && value.expectedSessionId !== activeWriterSession.id) {
    return `The active Writer session is now "${activeWriterSession.name}", a different document than this update targeted. Another tab or agent switched documents — reload the shared session before retrying.`;
  }
  if (typeof value.expectedRevision === "number" && Number.isFinite(value.expectedRevision) && value.expectedRevision !== activeWriterSession.revision) {
    return `The Writer session was updated by another tab or agent since this client last synced (session revision is ${activeWriterSession.revision}, client expected ${value.expectedRevision}). Reload the shared session before retrying.`;
  }
  return null;
}

interface WriterSession {
  bodySafeAnchors: string[];
  bodySafeAnchorDetails: DocxBodySafeAnchor[];
  chatMessages: WriterChatMessage[];
  documentHtml: string;
  documentText: string;
  features: DocxFeatureSummary;
  id: string;
  importMessages: string[];
  name: string;
  revision: number;
  routineProgress: string[];
  routineRuns: WriterRoutineRun[];
  sourceDocument: WriterReviewSourceDocument | null;
  sourceDocumentId: string;
  sourceTrackedChanges: SourceTrackedChangePreview[];
  suggestions: AiSuggestion[];
  title: string;
  updatedAt: string;
}

interface WriterAutosavedSessionRecord extends WriterAutosavedSessionSummary {
  snapshot: WriterSessionSnapshot;
  snapshotPath: string;
}

export function createWriterApp() {
  const app = express();

  // Per-user local AI for cloud deployments: a collaborator's browser on (say)
  // https://writer.zhoulab.io may call THIS sidecar on 127.0.0.1 to run AI on
  // their own CLI account. Cross-origin access stays off unless the owner
  // explicitly allows the cloud origin:
  //   WRITER_ALLOWED_ORIGINS=https://writer.zhoulab.io npm run sidecar
  // Never use "*": a loopback-trusted server with open CORS would let any
  // website drive this machine's CLIs.
  app.use((request, response, next) => {
    const allowed = (process.env.WRITER_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean);
    const origin = request.headers.origin;
    if (origin && allowed.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Writer-Share-Token");
      response.setHeader("Access-Control-Max-Age", "600");
      // Private Network Access: a page on a PUBLIC origin (https://writer.zhoulab.io)
      // reaching this LOCAL address (127.0.0.1) is blocked by Chrome unless the
      // preflight is answered with this header. Without it the browser reports a
      // generic "blocked by CORS policy" even though the origin is allowed — which
      // is exactly what breaks the per-user local-AI runner. Only granted to an
      // already-allowlisted origin, so no new exposure.
      if (request.headers["access-control-request-private-network"] === "true") {
        response.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (request.method === "OPTIONS") {
        response.status(204).end();
        return;
      }
    }
    next();
  });

  app.use(shareAuthMiddleware);
  app.use(express.json({ limit: "8mb" }));

  app.get("/api/health", (_request, response) => {
    const cliEnabled = isCliExecutionEnabled();
    const providerStatus = providerHealth(cliEnabled);
    response.json({
      ok: true,
      // The bundle is served BY this local sidecar (local-first mode): AI and
      // the terminal are same-origin here, so no cross-origin/personal-runner
      // dance. The cloud health handler never sets this, so the same bundle
      // knows which context it is in.
      local: true,
      instanceId: serverInstanceId,
      servesWeb: resolveWebRoot() !== null,
      cliEnabled,
      cliTimeout: resolveCliTimeoutConfig(),
      providers: providerStatus.map((provider) => provider.name),
      providerStatus,
      // Set by server/index.ts when the HTTPS listener (Word add-in) is up.
      tls: tlsHealth()
    });
  });

  app.get("/api/ai/progress", (_request, response) => {
    response.json({ progress: getAiProgress(), queue: getAiQueue() });
  });

  // Models and reasoning levels each installed CLI offers, discovered from
  // the CLI itself (catalog command, --help, binary, settings) and cached per
  // binary build — so the pickers follow `claude update` / codex upgrades.
  // ?refresh=1 forces re-discovery.
  app.get("/api/ai/models", async (request, response, next) => {
    try {
      const refreshParam = request.query?.refresh;
      const refresh = refreshParam === "1" || refreshParam === "true";
      const providers = await getProviderCatalogs({ refresh, childEnv: cliChildEnv });
      response.json({ providers, refreshed: refresh });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/share-info", (_request, response) => {
    const sharable = isShareModeEnabled();
    const webPort = Number(process.env.WRITER_WEB_PORT || 5173);
    const token = getShareToken();
    const lanAddresses = sharable
      ? Object.values(networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .filter((address) => address.family === "IPv4" && !address.internal)
        .map((address) => address.address)
      : [];
    response.json({
      sharable,
      // The token rides in the URL fragment: browsers never send fragments
      // over the network, so it cannot leak into proxy or server logs.
      shareUrls: lanAddresses.map((address) => `http://${address}:${webPort}/${token ? `#share=${token}` : ""}`)
    });
  });

  app.post("/api/docx/import", upload.single("file"), async (request, response, next) => {
    try {
      if (!request.file) {
        response.status(400).json({ error: "Upload a .docx file." });
        return;
      }
      const imported = await importDocx(request.file.buffer, request.file.originalname);
      importedDocuments.set(imported.id, request.file.buffer);
      stashActiveSession();
      rememberActiveRoutineState();
      activeWriterSession = sessionFromImport(imported);
      activeWriterSessionPath = null;
      response.json(imported);
    } catch (error) {
      next(error);
    }
  });

  // Agent-run tool endpoints: the MCP server spawned for an agentic AI run
  // reads the document snapshot, searches it, stages validated suggestions,
  // and reads attachments through these. Run ids are unguessable UUIDs and
  // contexts live only for the duration of a run.
  //
  // The special run id "live" backs the TERMINAL agent (a real claude/codex
  // the user drives in a PTY): it is long-lived and resolves against the
  // ACTIVE session's current text on every call — reads see what the user
  // sees right now, and staged suggestions land in the live review queue
  // (synced to collaborators) instead of a per-request snapshot.
  function liveAgentRun(): AgentRunContext | null {
    if (!activeWriterSession) {
      return null;
    }
    const live = liveCollabDocumentText(activeWriterSession.sourceDocumentId);
    // With the Word add-in open on this document, the terminal agent also
    // sees the author's caret/selection/viewport via writer_get_selection.
    const hostContext = wordHostState && wordHostState.sourceDocumentId === activeWriterSession.sourceDocumentId
      ? wordHostState.hostContext
      : null;
    return {
      id: "live",
      provider: "terminal",
      instruction: "",
      images: liveDocumentImages(),
      mode: "global",
      documentText: typeof live === "string" && live.trim() ? live : activeWriterSession.documentText,
      selection: hostContextSelection(hostContext),
      hostContext,
      activity: [],
      attachments: [],
      maxSuggestions: null,
      staged: [],
      rejectedCount: 0,
      createdAt: Date.now()
    };
  }
  function resolveAgentRun(runId: string): AgentRunContext | null {
    return runId === "live" ? liveAgentRun() : getAgentRun(runId);
  }
  const noRunError = (runId: string) => runId === "live"
    ? "No active Writer session — open or create a document in Writer first."
    : "Unknown or finished agent run.";

  app.get("/api/agent-run/:runId/document", (request, response) => {
    const run = resolveAgentRun(request.params.runId);
    if (!run) {
      response.status(404).json({ error: noRunError(request.params.runId) });
      return;
    }
    response.json(readAgentRunDocument(run, request.query.offset, request.query.limit));
  });

  app.get("/api/agent-run/:runId/selection", (request, response) => {
    const run = resolveAgentRun(request.params.runId);
    if (!run) {
      response.status(404).json({ error: noRunError(request.params.runId) });
      return;
    }
    const context = currentHostContext(run);
    // Selection-scoped requests keep the selection the user sent; otherwise
    // report the live one so an agent can follow the author's caret.
    const selection = run.mode === "selection" ? run.selection : hostContextSelection(context.hostContext) ?? run.selection;
    const { paragraphs: _paragraphs, ...hostContext } = context.hostContext ?? { paragraphs: undefined };
    response.json({ mode: run.mode, selection, hostContext: context.hostContext ? hostContext : null, live: context.live });
  });

  app.get("/api/agent-run/:runId/images", (request, response) => {
    const run = resolveAgentRun(request.params.runId);
    if (!run) {
      response.status(404).json({ error: noRunError(request.params.runId) });
      return;
    }
    response.json({
      images: run.images,
      note: run.images.length
        ? "Open a path with your image-capable file reader to see the picture; propose a replacement with writer_stage_image_replacement."
        : "This document has no inline images (or the client did not extract them)."
    });
  });

  app.get("/api/agent-run/:runId/images/:index", (request, response) => {
    const run = resolveAgentRun(request.params.runId);
    if (!run) {
      response.status(404).json({ error: noRunError(request.params.runId) });
      return;
    }
    const index = Number(request.params.index);
    const image = Number.isInteger(index) ? run.images[index] : undefined;
    if (!image) {
      response.status(404).json({ error: run.images.length ? `No image at index ${request.params.index}; the document has ${run.images.length}.` : "This document has no inline images." });
      return;
    }
    response.json({ ...image, note: "View the file at `path` with your image-capable file reader (Claude: Read; Codex: view_image)." });
  });

  app.get("/api/agent-run/:runId/context", (request, response) => {
    const run = resolveAgentRun(request.params.runId);
    if (!run) {
      response.status(404).json({ error: noRunError(request.params.runId) });
      return;
    }
    const query = request.query ?? {};
    const result = readAgentRunContext(run, {
      what: query.what,
      around: query.around,
      paragraphIndex: query.paragraph_index ?? query.paragraphIndex,
      before: query.before,
      after: query.after
    });
    if ("error" in result) {
      response.status(400).json(result);
      return;
    }
    response.json(result);
  });

  app.get("/api/agent-run/:runId/search", (request, response) => {
    const run = resolveAgentRun(request.params.runId);
    if (!run) {
      response.status(404).json({ error: noRunError(request.params.runId) });
      return;
    }
    const query = typeof request.query.query === "string" ? request.query.query : "";
    if (!query) {
      response.status(400).json({ error: "Search requires a non-empty query string." });
      return;
    }
    response.json(searchAgentRunDocument(run, query, request.query.max_results));
  });

  app.post("/api/agent-run/:runId/stage", async (request, response, next) => {
    try {
      const isLive = request.params.runId === "live";
      const run = resolveAgentRun(request.params.runId);
      if (!run) {
        response.status(404).json({ error: noRunError(request.params.runId) });
        return;
      }
      const body = request.body as { suggestions?: unknown; agent?: unknown };
      if (!Array.isArray(body?.suggestions) || body.suggestions.length === 0) {
        response.status(400).json({ error: "Staging requires a non-empty suggestions array." });
        return;
      }
      if (body.suggestions.length > 40) {
        response.status(400).json({ error: "Stage at most 40 suggestions per call." });
        return;
      }
      const result = stageAgentRunSuggestions(run, body.suggestions as Parameters<typeof stageAgentRunSuggestions>[1]);
      // Live (terminal) staging goes straight into the active review queue and
      // syncs to every collaborator, exactly like a chat AI response did.
      // Both terminal providers share the live run, so authorship comes from
      // the stage call itself — without it, the claiming client labels the
      // marks with whatever provider IT has selected.
      const agentLabel = body.agent === "claude" ? "Claude Code" : body.agent === "codex" ? "Codex" : null;
      if (isLive && run.staged.length && activeWriterSession) {
        const attributed = agentLabel
          ? run.staged.map((suggestion) => ({ ...suggestion, proposedBy: suggestion.proposedBy ?? agentLabel }))
          : run.staged;
        activeWriterSession = {
          ...activeWriterSession,
          suggestions: [...stampOrigin(attributed), ...activeWriterSession.suggestions],
          revision: nextSessionRevision(),
          updatedAt: new Date().toISOString()
        };
        await persistActiveRoutineStateSnapshot();
      }
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent-run/:runId/attachment", (request, response) => {
    const run = resolveAgentRun(request.params.runId);
    if (!run) {
      response.status(404).json({ error: noRunError(request.params.runId) });
      return;
    }
    const name = typeof request.query.name === "string" ? request.query.name : "";
    const result = name ? readAgentRunAttachment(run, name, request.query.offset, request.query.limit) : null;
    if (!result) {
      response.status(404).json({
        error: `No attachment named ${JSON.stringify(name)} on this run. Available: ${run.attachments.map((attachment) => attachment.name).join(", ") || "(none)"}`
      });
      return;
    }
    response.json(result);
  });

  // Agent terminal (terminal-driven Writer): the browser asks this LOCAL
  // sidecar to ensure the hop-managed claude/codex session exists, and gets
  // back hop's web-terminal URL — reached through hop's own security stack
  // (Cloudflare tunnel + password/2FA). The hop API token never leaves this
  // process.
  app.get("/api/agent-terminal", async (_request, response, next) => {
    try {
      response.json(await agentTerminalStatus());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent-terminal", async (request, response, next) => {
    try {
      const body = request.body as { provider?: unknown } | null;
      const provider = body?.provider === "codex" ? "codex" : "claude";
      response.json(await ensureAgentTerminal(provider));
    } catch (error) {
      next(error);
    }
  });

  // Kill the provider's PTY room; attached terminals auto-reconnect into a
  // fresh launch. The escape hatch when the CLI failed to start (update
  // needed, auth expired) and the room is stuck in a bare shell.
  app.post("/api/agent-terminal/restart", (request, response) => {
    const body = request.body as { provider?: unknown } | null;
    const provider = body?.provider === "codex" ? "codex" : "claude";
    response.json({ ok: true, restarted: restartTerminalRoom(provider), provider });
  });

  // Cross-user collaboration: bridge this local Writer's room for a document
  // to the cloud relay (writer.zhoulab.io Durable Object room). Text, presence,
  // and the suggestion CRDT map all sync through it; every collaborator's own
  // local Writer does the same, so the cloud stays a dumb relay.
  app.get("/api/collab/bridge", (request, response) => {
    const docId = requestedDocId(request);
    if (!docId) {
      response.status(400).json({ error: "Bridge status requires ?doc=<documentId>." });
      return;
    }
    response.json(bridgeStatus(docId));
  });

  app.post("/api/collab/bridge", (request, response) => {
    const body = request.body as { docId?: unknown } | null;
    const docId = typeof body?.docId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(body.docId) ? body.docId : null;
    if (!docId) {
      response.status(400).json({ error: "Bridging requires a valid docId." });
      return;
    }
    response.json(ensureCloudBridge(docId));
  });

  // Mark-native suggestion access for agents: list and resolve the inline
  // suggestions carried in a document's live Yjs room, so an agent reviews
  // exactly like a human — resolutions are ordinary document transactions
  // every connected client sees immediately.
  app.get("/api/collab/inline-suggestions", (request, response) => {
    const docId = requestedDocId(request) ?? activeWriterSession?.sourceDocumentId ?? null;
    if (!docId) {
      response.status(400).json({ error: "Listing inline suggestions requires ?doc=<documentId> (no active session to default to)." });
      return;
    }
    response.json({ docId, suggestions: listInlineSuggestions(docId), ...inlineSuggestionDiagnostics(docId) });
  });

  app.post("/api/collab/inline-suggestions/resolve", (request, response) => {
    const body = request.body as { docId?: unknown; changeId?: unknown; decision?: unknown } | null;
    const docId = (typeof body?.docId === "string" && body.docId.trim() ? body.docId.trim() : null)
      ?? activeWriterSession?.sourceDocumentId ?? null;
    const changeId = typeof body?.changeId === "string" && body.changeId.trim() ? body.changeId.trim() : null;
    const decision = body?.decision === "accept" || body?.decision === "reject" ? body.decision : null;
    if (!docId || !changeId || !decision) {
      response.status(400).json({ error: "Resolving an inline suggestion requires docId, changeId, and decision (accept|reject)." });
      return;
    }
    const resolved = resolveInlineSuggestion(docId, changeId, decision);
    if (!resolved) {
      response.status(404).json({ error: "No inline suggestion with that changeId — it may already be resolved." });
      return;
    }
    response.json({ ok: true, changeId, decision });
  });

  // Chat attachments: the file is saved on this machine (where the CLI runs)
  // and its text extracted here, so the browser never needs a real path —
  // it gets back { name, path, text } to include with the next AI request.
  // Document images pushed by a client (the Word add-in reads inline pictures
  // through Office.js) and served back for card previews. Names only: the
  // route never touches a path a client made up.
  app.post("/api/ai/images", upload.single("file"), (request, response) => {
    if (!request.file) {
      response.status(400).json({ error: "Attach an image file." });
      return;
    }
    const body = request.body as Record<string, string | undefined>;
    const stored = storeImageBytes(request.file.buffer, body.label || request.file.originalname || "image");
    if ("error" in stored) {
      response.status(400).json({ error: stored.error });
      return;
    }
    const numberOrNull = (value: string | undefined) => (value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
    const image: AiDocumentImage = {
      index: Math.max(0, Math.round(numberOrNull(body.index) ?? 0)),
      path: stored.path,
      url: stored.url,
      mime: stored.mime,
      width: numberOrNull(body.width),
      height: numberOrNull(body.height),
      altText: body.altText?.trim().slice(0, 400) || null,
      context: body.context?.trim().slice(0, 400) || null,
      paragraphIndex: numberOrNull(body.paragraphIndex)
    };
    response.json({ image });
  });

  app.get("/api/ai/images/:name", (request, response) => {
    const served = servedImagePath(request.params.name);
    if (!served) {
      response.status(404).json({ error: "No such image." });
      return;
    }
    response.type(served.mime);
    response.sendFile(served.path);
  });

  app.post("/api/ai/attachments", upload.single("file"), async (request, response, next) => {
    try {
      if (!request.file) {
        response.status(400).json({ error: "Attach a file." });
        return;
      }
      const attachment = await storeAiAttachment(request.file.buffer, request.file.originalname);
      response.json({ attachment });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/session", async (request, response, next) => {
    try {
      const docId = requestedDocId(request);
      if (docId) {
        await activateSessionForDoc(docId);
        if (activeWriterSession?.sourceDocumentId !== docId) {
          response.json({ session: null });
          return;
        }
      } else {
        await ensureActiveWriterSession();
      }
      await ensureActiveRoutineDownloadCopies();
      response.json({ session: activeWriterSession ? sessionSummary(activeWriterSession) : null });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/session/document", async (request, response, next) => {
    try {
      const docId = requestedDocId(request);
      if (docId) {
        await activateSessionForDoc(docId);
        if (activeWriterSession?.sourceDocumentId !== docId) {
          response.json({ session: null });
          return;
        }
      } else {
        await ensureActiveWriterSession();
      }
      await ensureActiveRoutineDownloadCopies();
      response.json({ session: activeWriterSession ? sessionDocument(activeWriterSession) : null });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/create", async (request, response, next) => {
    try {
      const body = request.body as { html?: unknown; text?: unknown; title?: unknown } | null;
      const html = typeof body?.html === "string" ? body.html : "";
      const text = typeof body?.text === "string" ? body.text : "";
      if (!text.trim()) {
        response.status(400).json({ error: "Creating a shared document requires non-empty text." });
        return;
      }
      const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : "Shared draft";
      const id = randomUUID();
      stashActiveSession();
      rememberActiveRoutineState();
      // A scratch draft promoted to a shared document: same session shape as an
      // import, just without a source DOCX package.
      activeWriterSession = {
        bodySafeAnchors: [],
        bodySafeAnchorDetails: [],
        chatMessages: [],
        documentHtml: html || htmlFromPlainText(text),
        documentText: text,
        features: emptyDocxFeatureSummary(),
        id,
        importMessages: [],
        name: `${title}.docx`,
        revision: nextSessionRevision(),
        routineProgress: [],
        routineRuns: [],
        sourceDocument: null,
        sourceDocumentId: id,
        sourceTrackedChanges: [],
        suggestions: [],
        title,
        updatedAt: new Date().toISOString()
      };
      activeWriterSessionPath = null;
      response.json({ session: sessionDocument(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/session/autosaves", async (_request, response, next) => {
    try {
      const records = await listAutosavedSessionRecords();
      response.json({ sessions: records.map(autosavedSessionSummary) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/autosaves/load", async (request, response, next) => {
    try {
      const parsed = parseAutosavedSessionLoadRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const records = await listAutosavedSessionRecords();
      const record = records.find((candidate) => candidate.id === parsed.id);
      if (!record) {
        response.status(404).json({ error: "Autosaved Writer session was not found." });
        return;
      }
      if (!record.snapshot.sourceDocumentPath) {
        response.status(400).json({ error: "Autosaved Writer session does not include a source DOCX path." });
        return;
      }
      const restored = await restoreSessionFromSnapshotSource(record.snapshot, record.snapshot.sourceDocumentPath);
      if (!restored) {
        response.status(400).json({ error: "Autosaved Writer session could not be restored because the source DOCX is unavailable." });
        return;
      }
      stashActiveSession();
      activeWriterSession = restored.session;
      activeWriterSessionPath = restored.sourceDocumentPath;
      rememberActiveRoutineState();
      response.json({ session: sessionDocument(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/session/suggestions", (_request, response) => {
    response.json({
      sessionId: activeWriterSession?.id ?? null,
      revision: activeWriterSession?.revision ?? null,
      suggestions: activeWriterSession?.suggestions ?? []
    });
  });

  app.get("/api/session/export-state", async (_request, response, next) => {
    try {
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before exporting a Writer session snapshot." });
        return;
      }
      await ensureActiveRoutineDownloadCopies();
      const snapshot = sessionSnapshot(activeWriterSession, activeWriterSessionPath);
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Content-Disposition", `attachment; filename="${defaultSessionSnapshotFilename(activeWriterSession)}"`);
      response.send(JSON.stringify(snapshot, null, 2));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/import-state", async (request, response, next) => {
    try {
      const parsed = parseSessionSnapshotRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      if (!parsed.snapshot.sourceDocumentPath) {
        if (!activeWriterSession || activeWriterSession.name !== parsed.snapshot.session.name) {
          response.status(400).json({ error: "Session snapshot does not include a sourceDocumentPath. Reopen the original DOCX, then import the session snapshot." });
          return;
        }
        rememberActiveRoutineState();
        activeWriterSession = await applySnapshotToSession(activeWriterSession, parsed.snapshot);
        rememberActiveRoutineState();
        response.json({ session: sessionDocument(activeWriterSession) });
        return;
      }
      const sourcePath = parsed.snapshot.sourceDocumentPath;
      const buffer = await readFile(sourcePath);
      const imported = await importDocx(buffer, basename(sourcePath));
      importedDocuments.set(imported.id, buffer);
      rememberActiveRoutineState();
      stashActiveSession();
      activeWriterSession = await applySnapshotToSession(sessionFromImport(imported), parsed.snapshot);
      activeWriterSessionPath = sourcePath;
      rememberActiveRoutineState();
      response.json({ session: sessionDocument(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/open-docx", async (request, response, next) => {
    try {
      const path = parsePathBody(request.body);
      if ("error" in path) {
        response.status(400).json({ error: path.error });
        return;
      }
      const infoBeforeRead = await stat(path.path);
      const buffer = await readFile(path.path);
      const infoAfterRead = await stat(path.path);
      const imported = await importDocx(buffer, basename(path.path));
      importedDocuments.set(imported.id, buffer);
      rememberActiveRoutineState();
      stashActiveSession();
      activeWriterSession = await restoreRoutineState(sessionFromImport(imported), path.path);
      activeWriterSession = {
        ...activeWriterSession,
        sourceDocument: writerReviewSourceDocumentFromStat(path.path, buffer.length, infoBeforeRead, infoAfterRead)
      };
      activeWriterSessionPath = path.path;
      response.json({ session: sessionSummary(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/suggest", async (request, response, next) => {
    try {
      const signal = requestAbortSignal(request, response);
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before requesting Writer session suggestions." });
        return;
      }
      // Agent-driven suggestions run against the live collaborative text when
      // available so anchors match what collaborators are actually editing.
      const liveText = liveCollabDocumentText(activeWriterSession.sourceDocumentId);
      const sessionForRequest = liveText ? { ...activeWriterSession, documentText: liveText } : activeWriterSession;
      const parsed = parseSessionSuggestRequest(request.body, sessionForRequest);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const ai = await proposeChanges(parsed.request, { signal });
      if (signal.aborted) {
        return;
      }
      if (parsed.recordSuggestions) {
        const attributed = ai.suggestions.map((suggestion) => ({ ...suggestion, proposedBy: suggestion.proposedBy ?? parsed.request.requestedBy ?? "Agent" }));
        activeWriterSession = {
          ...activeWriterSession,
          suggestions: [...stampOrigin(attributed), ...activeWriterSession.suggestions],
          revision: nextSessionRevision(),
          updatedAt: new Date().toISOString()
        };
        await persistActiveRoutineStateSnapshot();
      }
      response.json({ ai, recordedSuggestions: parsed.recordSuggestions, session: sessionSummary(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/word/suggest", async (request, response, next) => {
    try {
      const signal = requestAbortSignal(request, response);
      const parsed = parseWordLiveSuggestionRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      rememberWordHostContext(wordLiveDocumentName(parsed.request.documentName), parsed.request.hostContext, parsed.request.documentImages);
      const baseSession = wordLiveSessionForRequest(parsed.request);
      const ai = await proposeChanges(parsed.request, { signal });
      if (signal.aborted) {
        return;
      }
      activeWriterSession = {
        ...baseSession,
        suggestions: supersedeRevisedSuggestions(mergeSessionSuggestions(ai.suggestions, baseSession.suggestions), ai.suggestions, parsed.request.requestedBy ?? "Word"),
        revision: nextSessionRevision(),
        updatedAt: new Date().toISOString()
      };
      activeWriterSessionPath = null;
      response.json({
        ai,
        session: sessionSummary(activeWriterSession),
        sessionReused: baseSession.suggestions.length > 0
      });
    } catch (error) {
      next(error);
    }
  });

  // Word add-in window state. The pane pushes this while it is open (debounced
  // on selection change and scroll) so agents on the same document know where
  // the author is; when it carries documentText it also keeps the shared
  // Writer session in step with what Word shows, so terminal/MCP agents read
  // and stage against the live Word text.
  app.get("/api/word/context", (_request, response) => {
    response.json({
      hostContext: wordHostState?.hostContext ?? null,
      documentName: wordHostState?.documentName ?? null,
      receivedAt: wordHostState?.receivedAt ?? null,
      adopted: Boolean(wordHostState && activeWriterSession?.sourceDocumentId === wordHostState.sourceDocumentId)
    });
  });

  app.post("/api/word/context", async (request, response, next) => {
    try {
      const parsed = parseWordHostContextUpdate(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const documentName = wordLiveDocumentName(parsed.update.documentName);
      const sourceDocumentId = wordLiveSourceDocumentId(documentName);
      rememberWordHostContext(documentName, parsed.update.hostContext);
      const isWordSession = activeWriterSession?.sourceDocumentId === sourceDocumentId;
      let adopted = isWordSession;
      const documentText = parsed.update.documentText;
      // Only take over the active session when the pane asks (adopt), when it
      // already IS this Word document, or when nothing is active — never
      // silently displace a document someone is editing in the browser.
      if (typeof documentText === "string" && documentText.trim() && (parsed.update.adopt || isWordSession || !activeWriterSession)) {
        const base = wordLiveSessionFor(documentName, documentText);
        if (base !== activeWriterSession) {
          if (!isWordSession) {
            stashActiveSession();
          }
          activeWriterSession = { ...base, revision: nextSessionRevision(), updatedAt: new Date().toISOString() };
          activeWriterSessionPath = null;
          await persistActiveRoutineStateSnapshot();
        }
        adopted = true;
      }
      const session = adopted ? activeWriterSession : null;
      const payload: WordHostContextUpdateResponse = {
        adopted,
        sessionId: session?.id ?? null,
        revision: session?.revision ?? null,
        pendingSuggestions: session ? session.suggestions.filter((suggestion) => suggestion.status === "pending").length : 0
      };
      response.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/suggestion-status", async (request, response, next) => {
    try {
      if (!activeWriterSession) {
        // 404, not 400: with no active session there is nothing to update,
        // and the web app treats 404 as "this suggestion only exists in the
        // browser" (a scratch draft) instead of retrying a sync that can
        // never succeed.
        response.status(404).json({ error: "No active Writer session — this suggestion exists only in the requesting browser." });
        return;
      }
      const parsed = parseSuggestionStatusRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const conflict = sessionConflictError(request.body);
      if (conflict) {
        response.status(409).json({ error: conflict });
        return;
      }
      const existing = activeWriterSession.suggestions.find((suggestion) => suggestion.id === parsed.id);
      if (!existing) {
        response.status(404).json({ error: `Suggestion not found: ${parsed.id}` });
        return;
      }
      // Compare-and-swap: if another collaborator or agent already decided this
      // suggestion, reject instead of silently overwriting their decision.
      if (parsed.expectedStatus !== null && existing.status !== parsed.expectedStatus) {
        response.status(409).json({
          error: `Suggestion "${existing.title}" was already marked ${existing.status}${existing.decidedBy ? ` by ${existing.decidedBy}` : ""} — refresh before changing it.`,
          conflict: {
            decidedAt: existing.decidedAt ?? null,
            decidedBy: existing.decidedBy ?? null,
            id: existing.id,
            status: existing.status
          }
        });
        return;
      }
      activeWriterSession = {
        ...activeWriterSession,
        suggestions: activeWriterSession.suggestions.map((suggestion) => (
          suggestion.id === parsed.id
            ? {
              ...suggestion,
              status: parsed.status,
              decidedBy: parsed.status === "pending" ? null : parsed.decidedBy,
              decidedAt: parsed.status === "pending" ? null : new Date().toISOString(),
              decisionNote: parsed.status === "pending" ? null : parsed.decisionNote ?? existing.decisionNote ?? null
            }
            : suggestion
        )),
        revision: nextSessionRevision(),
        updatedAt: new Date().toISOString()
      };
      await persistActiveRoutineStateSnapshot();
      response.json({ session: sessionSummary(activeWriterSession), suggestion: activeWriterSession.suggestions.find((suggestion) => suggestion.id === parsed.id) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/chat-messages", async (request, response, next) => {
    try {
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before updating Writer chat history." });
        return;
      }
      const parsed = parseChatMessagesRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const conflict = sessionConflictError(request.body);
      if (conflict) {
        response.status(409).json({ error: conflict });
        return;
      }
      activeWriterSession = {
        ...activeWriterSession,
        chatMessages: parsed.chatMessages,
        revision: nextSessionRevision(),
        updatedAt: new Date().toISOString()
      };
      await persistActiveRoutineStateSnapshot();
      response.json({ session: sessionSummary(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/record-suggestions", async (request, response, next) => {
    try {
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before recording Writer suggestions." });
        return;
      }
      const body = request.body as { suggestions?: unknown } | null;
      const parsed = parseSessionExportSuggestions(body?.suggestions);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      if (!parsed.suggestions?.length) {
        response.status(400).json({ error: "Recording Writer suggestions requires a non-empty suggestions array." });
        return;
      }
      const conflict = sessionConflictError(request.body);
      if (conflict) {
        response.status(409).json({ error: conflict });
        return;
      }
      // Mirrors browser-side AI results into the shared session so every
      // collaborator's review queue (and any agent) sees the same proposals.
      const existingIds = new Set(activeWriterSession.suggestions.map((suggestion) => suggestion.id));
      const additions = parsed.suggestions.filter((suggestion) => !existingIds.has(suggestion.id));
      if (additions.length) {
        activeWriterSession = {
          ...activeWriterSession,
          suggestions: [...stampOrigin(additions), ...activeWriterSession.suggestions],
          revision: nextSessionRevision(),
          updatedAt: new Date().toISOString()
        };
        await persistActiveRoutineStateSnapshot();
      }
      response.json({ recorded: additions.length, session: sessionSummary(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/chat-append", async (request, response, next) => {
    try {
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before appending Writer chat messages." });
        return;
      }
      const parsed = parseChatMessagesRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const conflict = sessionConflictError(request.body);
      if (conflict) {
        response.status(409).json({ error: conflict });
        return;
      }
      // Append-only with id dedupe: concurrent writers can both add messages
      // without replacing (and losing) each other's history.
      const existingIds = new Set(activeWriterSession.chatMessages.map((message) => message.id).filter(Boolean));
      const additions = parsed.chatMessages.filter((message) => message.id && !existingIds.has(message.id));
      if (additions.length) {
        activeWriterSession = {
          ...activeWriterSession,
          chatMessages: [...activeWriterSession.chatMessages, ...additions].slice(-200),
          revision: nextSessionRevision(),
          updatedAt: new Date().toISOString()
        };
        await persistActiveRoutineStateSnapshot();
      }
      response.json({ appended: additions.length, session: sessionSummary(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/routine-progress", async (request, response, next) => {
    try {
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before updating Writer routine progress." });
        return;
      }
      const parsed = parseRoutineProgressRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const conflict = sessionConflictError(request.body);
      if (conflict) {
        response.status(409).json({ error: conflict });
        return;
      }
      activeWriterSession = {
        ...activeWriterSession,
        routineProgress: parsed.routineProgress,
        revision: nextSessionRevision(),
        updatedAt: new Date().toISOString()
      };
      await persistActiveRoutineStateSnapshot();
      response.json({ session: sessionSummary(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/routine-run", async (request, response, next) => {
    try {
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before recording a Writer routine run." });
        return;
      }
      const parsed = parseRoutineRunRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const conflict = sessionConflictError(request.body);
      if (conflict) {
        response.status(409).json({ error: conflict });
        return;
      }
      const run = await routineRunWithDownloadCopy(parsed.run);
      activeWriterSession = {
        ...activeWriterSession,
        routineRuns: [run, ...activeWriterSession.routineRuns.filter((candidate) => candidate.id !== run.id)].slice(0, 25),
        revision: nextSessionRevision(),
        updatedAt: new Date().toISOString()
      };
      await persistActiveRoutineStateSnapshot();
      response.json({ session: sessionSummary(activeWriterSession) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/routine-artifact", async (request, response, next) => {
    try {
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before downloading a Writer routine artifact." });
        return;
      }
      const parsed = parseRoutineRunIdRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const run = activeWriterSession.routineRuns.find((candidate) => candidate.id === parsed.id);
      if (!run?.artifactPath) {
        response.status(404).json({ error: `Routine artifact not found: ${parsed.id}` });
        return;
      }
      const buffer = await readFile(run.artifactPath);
      const filename = sanitizeDocxDownloadFilename(basename(run.artifactPath), run.label);
      response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      response.send(buffer);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/session/routine-suggestions", async (request, response, next) => {
    try {
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before syncing Writer routine suggestions." });
        return;
      }
      const parsed = parseRoutineRunIdRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const run = activeWriterSession.routineRuns.find((candidate) => candidate.id === parsed.id);
      if (!run?.suggestionsPath) {
        response.status(404).json({ error: `Routine suggestions not found: ${parsed.id}` });
        return;
      }
      const suggestions = await readRoutineSuggestions(run.suggestionsPath);
      activeWriterSession = {
        ...activeWriterSession,
        suggestions: mergeSessionSuggestions(suggestions, activeWriterSession.suggestions),
        revision: nextSessionRevision(),
        updatedAt: new Date().toISOString()
      };
      await persistActiveRoutineStateSnapshot();
      response.json({
        syncedSuggestions: suggestions.length,
        session: sessionSummary(activeWriterSession)
      });
    } catch (error) {
      next(error);
    }
  });

  const exportReviewSession = async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!activeWriterSession) {
        response.status(400).json({ error: "Open a DOCX before exporting a Writer review document." });
        return;
      }
      const parsed = parseSessionExportRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      let exportSourceSuggestions = parsed.suggestions ?? activeWriterSession.suggestions;
      if (parsed.suggestionIds) {
        const activeSuggestionsById = new Map(activeWriterSession.suggestions.map((suggestion) => [suggestion.id, suggestion]));
        const missingIds = parsed.suggestionIds.filter((id) => !activeSuggestionsById.has(id));
        if (missingIds.length > 0) {
          response.status(400).json({ error: `Writer review export suggestionIds did not match active suggestions: ${missingIds.join(", ")}` });
          return;
        }
        exportSourceSuggestions = parsed.suggestionIds.map((id) => activeSuggestionsById.get(id)).filter(Boolean) as AiSuggestion[];
      }
      // The DOCX patcher only writes pending suggestions. With pendingOnly off,
      // accepted suggestions must still land in the review DOCX as tracked
      // changes — the source DOCX text is unchanged, so export them as pending
      // w:ins/w:del the reviewer can still act on in Word. (This is the only
      // export path for agent-accepted suggestions when no browser is open.)
      const seenChangeKeys = new Set<string>();
      const suggestions = parsed.pendingOnly
        ? exportSourceSuggestions.filter((suggestion) => suggestion.status === "pending")
        : exportSourceSuggestions
          .filter((suggestion) => suggestion.status !== "rejected")
          .map((suggestion) => suggestion.status === "accepted" ? { ...suggestion, status: "pending" as const } : suggestion)
          .filter((suggestion) => {
            const changeKey = `${suggestion.original}\u0000${suggestion.replacement}`;
            if (seenChangeKeys.has(changeKey)) {
              return false;
            }
            seenChangeKeys.add(changeKey);
            return true;
          });
      const reviewSuggestions = suggestions.map(suggestionForReviewExport);
      let sessionChanged = false;
      if (parsed.suggestions) {
        activeWriterSession = {
          ...activeWriterSession,
          suggestions: mergeSessionSuggestions(parsed.suggestions, activeWriterSession.suggestions),
          revision: nextSessionRevision(),
          updatedAt: new Date().toISOString()
        };
        sessionChanged = true;
      }
      const sourceForExport = await sourceBufferForReviewExport(activeWriterSession.sourceDocumentId, activeWriterSessionPath);
      const sourceBuffer = sourceForExport.buffer;
      const result = sourceBuffer
        ? await exportTrackedChangesFromSourceWithReport(sourceBuffer, reviewSuggestions)
        : { buffer: await exportDocx({ title: activeWriterSession.title, html: activeWriterSession.documentHtml, trackedChanges: true, suggestions: reviewSuggestions }), report: null };
      const outputPath = parsed.outputPath ?? defaultReviewOutputPath(activeWriterSession, parsed.routineRun);
      const suggestionsPath = parsed.suggestionsOutputPath ?? reviewSuggestionsPath(outputPath);
      const reportPath = parsed.reportOutputPath ?? reviewReportPath(outputPath);
      const sourceDocument = sourceForExport.sourceDocument;
      const reviewPlacements = result.report ? reviewPlacementsFromExportReport(reviewSuggestions, result.report) : [];
      const reviewSummary = reviewSummaryFromExportReport(result.report, reviewSuggestions);
      const reviewConflictSummary = reviewConflictSummaryFromSuggestions(reviewSuggestions);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, result.buffer);
      const downloadCopyPath = parsed.copyToDownloads ? await copyReviewToDownloads(outputPath) : null;
      await mkdir(dirname(suggestionsPath), { recursive: true });
      await writeFile(suggestionsPath, JSON.stringify({
        downloadCopyPath,
        documentName: activeWriterSession.name,
        exportedAt: new Date().toISOString(),
        pendingOnly: parsed.pendingOnly,
        reviewConflictSummary,
        reviewPlacements,
        routineRun: parsed.routineRun ? reviewSuggestionsRoutineRunMetadata(parsed.routineRun) : null,
        sourceDocument,
        sourceDocumentPath: activeWriterSessionPath,
        suggestions: reviewSuggestions
      }, null, 2));
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify({
        artifactPath: outputPath,
        downloadCopyPath,
        documentName: activeWriterSession.name,
        exportedAt: new Date().toISOString(),
        outputPath,
        pendingOnly: parsed.pendingOnly,
        reviewConflictSummary,
        reviewSummary,
        sourceDocument,
        sourceDocumentPath: activeWriterSessionPath,
        suggestionsPath,
        report: result.report
      }, null, 2));
      const recordedRun = parsed.routineRun
        ? routineRunFromExport(parsed.routineRun, outputPath, suggestionsPath, reportPath, downloadCopyPath, result.report, reviewSuggestions, sourceDocument)
        : null;
      if (recordedRun) {
        activeWriterSession = {
          ...activeWriterSession,
          routineRuns: [recordedRun, ...activeWriterSession.routineRuns.filter((run) => run.id !== recordedRun.id)].slice(0, 25),
          routineProgress: routineProgressWithRecordedRun(activeWriterSession.routineProgress, recordedRun),
          revision: nextSessionRevision(),
          updatedAt: new Date().toISOString()
        };
        sessionChanged = true;
      }
      if (sessionChanged) {
        await persistActiveRoutineStateSnapshot();
      }
      let sessionSnapshotPath: string | null = null;
      if (parsed.sessionSnapshotOutputPath) {
        sessionSnapshotPath = parsed.sessionSnapshotOutputPath;
        await mkdir(dirname(sessionSnapshotPath), { recursive: true });
        await writeFile(sessionSnapshotPath, JSON.stringify(sessionSnapshot(activeWriterSession, activeWriterSessionPath), null, 2));
      }
      response.json({
        artifactPath: outputPath,
        downloadCopyPath,
        outputPath,
        reportPath,
        sessionSnapshotPath,
        suggestionsPath,
        sourceDocument,
        report: result.report,
        reviewConflictSummary,
        reviewSummary,
        reviewPlacements,
        routineRun: recordedRun,
        session: sessionSummary(activeWriterSession)
      });
    } catch (error) {
      next(error);
    }
  };
  app.post("/api/session/export-review", exportReviewSession);
  app.post("/api/session/export", exportReviewSession);

  app.post("/api/docx/export", async (request, response, next) => {
    try {
      const body = request.body as ExportRequest;
      const sourceBuffer = body.trackedChanges && body.sourceDocumentId
        ? importedDocuments.get(body.sourceDocumentId)
        : undefined;
      if (!sourceBuffer && !body.html?.trim()) {
        response.status(400).json({ error: "Export requires document HTML unless tracked changes are exported from an imported source DOCX." });
        return;
      }
      const result = sourceBuffer
        ? await exportTrackedChangesFromSourceWithReport(sourceBuffer, body.suggestions ?? [])
        : { buffer: await exportDocx(body), report: null };
      const filename = body.downloadFilename
        ? sanitizeDocxDownloadFilename(body.downloadFilename, body.title || "nebula-writer")
        : defaultDocxExportDownloadFilename(body);
      response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      if (result.report) {
        response.setHeader("X-Nebula-Writer-Suggestions-Total", String(result.report.totalSuggestions));
        response.setHeader("X-Nebula-Writer-Suggestions-Matched", String(result.report.matchedSuggestions));
        response.setHeader("X-Nebula-Writer-Suggestions-Matched-Ids", encodeURIComponent(JSON.stringify(result.report.matchedSuggestionIds.slice(0, 200))));
        response.setHeader("X-Nebula-Writer-Suggestions-Matched-Titles", encodeURIComponent(JSON.stringify(result.report.matchedSuggestionTitles.slice(0, 10))));
        response.setHeader("X-Nebula-Writer-Suggestions-Unmatched", String(result.report.unmatchedSuggestions));
        response.setHeader("X-Nebula-Writer-Suggestions-Unmatched-Ids", encodeURIComponent(JSON.stringify(result.report.unmatchedSuggestionIds.slice(0, 200))));
        response.setHeader("X-Nebula-Writer-Suggestions-Unmatched-Titles", encodeURIComponent(JSON.stringify(result.report.unmatchedSuggestionTitles.slice(0, 10))));
        response.setHeader("X-Nebula-Writer-Suggestions-Commented", String(result.report.commentedSuggestions));
        response.setHeader("X-Nebula-Writer-Suggestions-Commented-Ids", encodeURIComponent(JSON.stringify(result.report.commentedSuggestionIds.slice(0, 200))));
        response.setHeader("X-Nebula-Writer-Suggestions-Commented-Reasons", encodeURIComponent(JSON.stringify(result.report.commentedSuggestionReasons.slice(0, 20))));
        response.setHeader("X-Nebula-Writer-Suggestions-Commented-Titles", encodeURIComponent(JSON.stringify(result.report.commentedSuggestionTitles.slice(0, 10))));
      }
      response.send(result.buffer);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/suggest", async (request, response, next) => {
    try {
      const signal = requestAbortSignal(request, response);
      const parsed = parseAiRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      const aiRequest = parsed.request.documentImages?.length
        ? parsed.request
        : { ...parsed.request, documentImages: await sessionDocumentImages(parsed.request) };
      const ai = await proposeChanges(aiRequest, { signal });
      if (signal.aborted) {
        return;
      }
      let stagedInSession = false;
      if (parsed.request.stageSuggestions !== false && activeWriterSession && parsed.request.documentText === activeWriterSession.documentText) {
        activeWriterSession = {
          ...activeWriterSession,
          suggestions: supersedeRevisedSuggestions([...stampOrigin(ai.suggestions), ...activeWriterSession.suggestions], ai.suggestions, aiRequest.requestedBy ?? "Writer"),
          revision: nextSessionRevision(),
          updatedAt: new Date().toISOString()
        };
        stagedInSession = true;
        await persistActiveRoutineStateSnapshot();
      }
      response.json({ ...ai, stagedInSession });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/smoke", async (request, response, next) => {
    try {
      const parsed = parseProviderSmokeRequest(request.body);
      if ("error" in parsed) {
        response.status(400).json({ error: parsed.error });
        return;
      }
      response.json(await smokeTestProvider(parsed.provider));
    } catch (error) {
      next(error);
    }
  });

  // Local-first entry point: serve the built Writer web app so the sidecar IS
  // a full local Writer at http://localhost:<port> — same origin as AI and the
  // terminal, no cross-origin/CORS/Local-Network-Access dance. Only mounted
  // when a build exists (dist/); in dev, Vite serves the app and this is a
  // no-op. Registered AFTER every /api route (and /collab, /events live on the
  // websocket layer) so nothing is shadowed; the SPA fallback never answers an
  // /api path.
  const webRoot = resolveWebRoot();
  if (webRoot) {
    app.use(express.static(webRoot, {
      index: false,
      maxAge: "1h",
      // Hashed assets can cache for an hour, but entry pages must not: Word's
      // task-pane webview otherwise keeps serving a stale taskpane.html after
      // a rebuild until its cache is cleared.
      setHeaders: (staticResponse, filePath) => {
        if (filePath.endsWith(".html")) {
          staticResponse.setHeader("Cache-Control", "no-cache");
        }
      }
    }));
    app.get(/^(?!\/(api|collab|events|bridge)\/).*/, (request, response, next) => {
      if (request.method !== "GET" || request.path.startsWith("/api") || request.accepts("html") !== "html") {
        next();
        return;
      }
      response.sendFile(join(webRoot, "index.html"), (error) => {
        if (error) {
          next(error);
        }
      });
    });
  }

  app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error(`[writer-sidecar] ${request.method} ${request.path} failed:`, error);
    const detail = error instanceof Error && error.message ? error.message : null;
    const message = detail
      ? `The Writer sidecar could not complete ${request.method} ${request.path}: ${detail}`
      : `The Writer sidecar hit an unexpected error on ${request.method} ${request.path}. Check the sidecar terminal output for details.`;
    response.status(500).json({ error: message });
  });

  return app;
}

// Suggestion sync across collaborators (collab-bridge): expose the active
// session's suggestions to the shared CRDT map, and merge inbound entries —
// new suggestions are added; decisions win by last-write (decidedAt), so two
// people deciding the same suggestion converge on the newer decision.
registerCollabBridgeHooks({
  getSessionSuggestions(docId) {
    return activeWriterSession?.sourceDocumentId === docId ? activeWriterSession.suggestions : null;
  },
  applyInboundSuggestions(docId, entries) {
    if (activeWriterSession?.sourceDocumentId !== docId) {
      return false;
    }
    const byId = new Map(activeWriterSession.suggestions.map((suggestion) => [suggestion.id, suggestion]));
    const added: AiSuggestion[] = [];
    let changed = false;
    for (const incoming of entries) {
      const current = byId.get(incoming.id);
      if (!current) {
        added.push(incoming);
        changed = true;
        continue;
      }
      if (incoming.status !== current.status) {
        const incomingAt = Date.parse(incoming.decidedAt ?? "") || 0;
        const currentAt = Date.parse(current.decidedAt ?? "") || 0;
        if (current.status === "pending" || incomingAt > currentAt) {
          byId.set(incoming.id, {
            ...current,
            status: incoming.status,
            decidedBy: incoming.decidedBy ?? current.decidedBy,
            decidedAt: incoming.decidedAt ?? current.decidedAt
          });
          changed = true;
        }
      }
    }
    if (!changed) {
      return false;
    }
    const merged = activeWriterSession.suggestions.map((suggestion) => byId.get(suggestion.id) ?? suggestion);
    activeWriterSession = {
      ...activeWriterSession,
      suggestions: [...added, ...merged],
      revision: nextSessionRevision(),
      updatedAt: new Date().toISOString()
    };
    void persistActiveRoutineStateSnapshot();
    return true;
  }
});

function tlsHealth(): { port: number; wordAddinUrl: string } | null {
  const port = Number.parseInt(process.env.WRITER_TLS_ACTIVE_PORT ?? "", 10);
  return Number.isSafeInteger(port) && port > 0
    ? { port, wordAddinUrl: `https://localhost:${port}/word/taskpane.html` }
    : null;
}

/** Locate the built web app (dist/) relative to the server, if present. */
function resolveWebRoot(): string | null {
  const override = process.env.WRITER_WEB_ROOT?.trim();
  const candidates = override ? [override] : [];
  try {
    candidates.push(resolve(fileURLToPath(new URL("../dist", import.meta.url))));
  } catch {
    candidates.push(resolve(process.cwd(), "dist"));
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}

function sessionFromImport(imported: ImportedDocument): WriterSession {
  return {
    bodySafeAnchors: imported.bodySafeAnchors ?? [],
    bodySafeAnchorDetails: imported.bodySafeAnchorDetails ?? (imported.bodySafeAnchors ?? []).map((text) => ({ section: null, text })),
    chatMessages: [],
    documentHtml: imported.html,
    documentText: imported.plainText,
    features: imported.features,
    id: imported.id,
    importMessages: imported.messages,
    name: imported.name,
    routineProgress: [],
    routineRuns: [],
    sourceDocument: null,
    sourceDocumentId: imported.id,
    sourceTrackedChanges: imported.sourceTrackedChanges ?? [],
    suggestions: [],
    title: imported.name.replace(/\.docx$/i, ""),
    revision: nextSessionRevision(),
    updatedAt: new Date().toISOString()
  };
}

function wordLiveSessionForRequest(request: WordLiveSuggestionRequest): WriterSession {
  return wordLiveSessionFor(wordLiveDocumentName(request.documentName), request.documentText);
}

function wordLiveSessionFor(documentName: string, documentText: string): WriterSession {
  const sourceDocumentId = wordLiveSourceDocumentId(documentName);
  if (
    activeWriterSession
    && activeWriterSession.sourceDocumentId === sourceDocumentId
    && activeWriterSession.documentText === documentText
  ) {
    return activeWriterSession;
  }

  // Same Word document whose text moved on (the author kept typing): keep the
  // review queue, chat, and routine history — only the text snapshot changes.
  const previous = activeWriterSession?.sourceDocumentId === sourceDocumentId
    ? activeWriterSession
    : displacedSessions.get(sourceDocumentId)?.session ?? null;
  const now = new Date().toISOString();
  return {
    bodySafeAnchors: [],
    bodySafeAnchorDetails: [],
    chatMessages: previous?.chatMessages ?? [],
    documentHtml: htmlFromPlainText(documentText),
    documentText,
    features: emptyDocxFeatureSummary(),
    id: previous?.id ?? randomUUID(),
    importMessages: [
      "Live Word text was captured through the Nebula Writer Word add-in. DOCX package-level structures remain in Word and are not available to Writer review export."
    ],
    name: documentName,
    revision: nextSessionRevision(),
    routineProgress: previous?.routineProgress ?? [],
    routineRuns: previous?.routineRuns ?? [],
    sourceDocument: null,
    sourceDocumentId,
    sourceTrackedChanges: [],
    suggestions: previous?.suggestions ?? [],
    title: documentName.replace(/\.docx$/i, ""),
    updatedAt: now
  };
}

function wordLiveDocumentName(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed || "Microsoft Word live document";
}

function wordLiveSourceDocumentId(documentName: string): string {
  return `${wordLiveSourceDocumentPrefix}${documentName.toLowerCase().replace(/\s+/g, "-").slice(0, 160)}`;
}

function htmlFromPlainText(text: string): string {
  const paragraphs = text.split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const htmlParagraphs = paragraphs.length ? paragraphs : [text.trim()];
  return htmlParagraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emptyDocxFeatureSummary(): DocxFeatureSummary {
  return {
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
}

function rememberActiveRoutineState() {
  if (!activeWriterSession || !activeWriterSessionPath) {
    return;
  }
  routineStateByDocumentPath.set(activeWriterSessionPath, {
    chatMessages: [...activeWriterSession.chatMessages],
    routineProgress: [...activeWriterSession.routineProgress],
    routineRuns: sortRoutineRuns(activeWriterSession.routineRuns),
    sourceTrackedChanges: [...activeWriterSession.sourceTrackedChanges],
    suggestions: [...activeWriterSession.suggestions]
  });
}

async function persistActiveRoutineStateSnapshot() {
  rememberActiveRoutineState();
  if (!activeWriterSession || !activeWriterSessionPath) {
    return;
  }
  const snapshotPath = autoRestoreSnapshotPath(activeWriterSession, activeWriterSessionPath);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(sessionSnapshot(activeWriterSession, activeWriterSessionPath), null, 2));
}

function autoRestoreSnapshotPath(session: WriterSession, sourceDocumentPath: string): string {
  const stem = sanitizeFilename(session.title || session.name.replace(/\.docx$/i, "") || "writer-session");
  const sourceHash = createHash("sha1").update(sourceDocumentPath).digest("hex").slice(0, 10);
  return join(writerRecoveryDirectory(), `writer-autorestore-${stem}-${sourceHash}.json`);
}

// Recovery snapshots now live in tmp/recovery, but older installs wrote them
// to tmp/ directly — scan both so existing autosaves stay restorable.
function snapshotScanDirectories(): string[] {
  return [writerRecoveryDirectory(), join(process.cwd(), "tmp")];
}

async function ensureActiveWriterSession(): Promise<void> {
  if (activeWriterSession) {
    return;
  }
  const restored = await restoreLatestActiveSessionFromSnapshot();
  if (!restored) {
    return;
  }
  activeWriterSession = restored.session;
  activeWriterSessionPath = restored.sourceDocumentPath;
  rememberActiveRoutineState();
}

async function restoreLatestActiveSessionFromSnapshot(): Promise<{ session: WriterSession; sourceDocumentPath: string } | null> {
  const candidates: Array<{ exportedAt: number; snapshot: WriterSessionSnapshot }> = [];
  for (const directory of snapshotScanDirectories()) {
    let filenames: string[];
    try {
      filenames = await readdir(directory);
    } catch {
      continue;
    }
    for (const filename of filenames) {
      const lowerFilename = filename.toLowerCase();
      if (!lowerFilename.endsWith(".json") || !isPotentialSessionSnapshotFilename(lowerFilename) || isKnownNonSessionJsonArtifact(lowerFilename)) {
        continue;
      }
      const snapshot = await readSessionSnapshotIfValid(join(directory, filename));
      if (!snapshot?.sourceDocumentPath) {
        continue;
      }
      const exportedAt = Date.parse(snapshot.exportedAt);
      const snapshotTime = Number.isFinite(exportedAt) ? exportedAt : 0;
      candidates.push({ exportedAt: snapshotTime, snapshot });
    }
  }

  for (const candidate of candidates.sort((left, right) => right.exportedAt - left.exportedAt)) {
    if (!candidate.snapshot.sourceDocumentPath) {
      continue;
    }
    const restored = await restoreSessionFromSnapshotSource(candidate.snapshot, candidate.snapshot.sourceDocumentPath);
    if (restored) {
      return restored;
    }
  }
  return null;
}

async function listAutosavedSessionRecords(): Promise<WriterAutosavedSessionRecord[]> {
  const records: WriterAutosavedSessionRecord[] = [];
  const seenPaths = new Set<string>();
  for (const directory of snapshotScanDirectories()) {
    let filenames: string[];
    try {
      filenames = await readdir(directory);
    } catch {
      continue;
    }
    for (const filename of filenames) {
      const lowerFilename = filename.toLowerCase();
      if (!lowerFilename.endsWith(".json") || !isPotentialSessionSnapshotFilename(lowerFilename) || isKnownNonSessionJsonArtifact(lowerFilename)) {
        continue;
      }
      const snapshotPath = join(directory, filename);
      if (seenPaths.has(snapshotPath)) {
        continue;
      }
      seenPaths.add(snapshotPath);
      const snapshot = await readSessionSnapshotIfValid(snapshotPath);
      if (!snapshot?.sourceDocumentPath) {
        continue;
      }
      records.push(await autosavedSessionRecordFromSnapshot(filename, snapshotPath, snapshot));
    }
  }

  return records
    .sort((left, right) => Date.parse(right.exportedAt) - Date.parse(left.exportedAt))
    .slice(0, 30);
}

async function autosavedSessionRecordFromSnapshot(filename: string, snapshotPath: string, snapshot: WriterSessionSnapshot): Promise<WriterAutosavedSessionRecord> {
  let sourceDocumentAvailable = false;
  if (snapshot.sourceDocumentPath) {
    try {
      await stat(snapshot.sourceDocumentPath);
      sourceDocumentAvailable = true;
    } catch {
      sourceDocumentAvailable = false;
    }
  }
  const pendingSuggestions = snapshot.session.suggestions.filter((suggestion) => suggestion.status === "pending").length;
  const chatMessageCount = (snapshot.session.chatMessages ?? []).filter((message) => message.role !== "system" && message.content.trim()).length;
  return {
    chatMessageCount,
    exportedAt: snapshot.exportedAt,
    filename,
    id: filename,
    name: snapshot.session.name,
    pendingSuggestions,
    routineRunCount: snapshot.session.routineRuns.length,
    snapshot,
    snapshotPath,
    sourceDocumentAvailable,
    sourceDocumentPath: snapshot.sourceDocumentPath,
    suggestionCount: snapshot.session.suggestions.length,
    title: snapshot.session.title
  };
}

function autosavedSessionSummary(record: WriterAutosavedSessionRecord): WriterAutosavedSessionSummary {
  const { snapshot: _snapshot, snapshotPath: _snapshotPath, ...summary } = record;
  return summary;
}

async function readSessionSnapshotIfValid(path: string): Promise<WriterSessionSnapshot | null> {
  try {
    const prefix = await readFilePrefix(path, sessionSnapshotProbeBytes);
    if (!looksLikeSessionSnapshotPrefix(prefix)) {
      return null;
    }
    const contents = await readFile(path, "utf8");
    if (!looksLikeSessionSnapshotJson(contents)) {
      return null;
    }
    const parsed = parseSessionSnapshotRequest(JSON.parse(contents));
    return "error" in parsed ? null : parsed.snapshot;
  } catch {
    return null;
  }
}

async function restoreSessionFromSnapshotSource(
  snapshot: WriterSessionSnapshot,
  sourceDocumentPath: string
): Promise<{ session: WriterSession; sourceDocumentPath: string } | null> {
  try {
    const infoBeforeRead = await stat(sourceDocumentPath);
    const buffer = await readFile(sourceDocumentPath);
    const infoAfterRead = await stat(sourceDocumentPath);
    const imported = await importDocx(buffer, basename(sourceDocumentPath));
    importedDocuments.set(imported.id, buffer);
    const session = await applySnapshotToSession(sessionFromImport(imported), snapshot);
    // Source-preserving export looks the buffer up by the session's (restored,
    // stable) document id, which can differ from the fresh import id.
    importedDocuments.set(session.sourceDocumentId, buffer);
    return {
      session: {
        ...session,
        sourceDocument: writerReviewSourceDocumentFromStat(sourceDocumentPath, buffer.length, infoBeforeRead, infoAfterRead)
      },
      sourceDocumentPath
    };
  } catch {
    return null;
  }
}

async function ensureActiveRoutineDownloadCopies(): Promise<void> {
  if (!activeWriterSession) {
    return;
  }
  const routineRuns = await routineRunsWithDownloadCopies(activeWriterSession.routineRuns);
  const changed = routineRuns.some((run, index) => run !== activeWriterSession?.routineRuns[index]);
  if (!changed) {
    return;
  }
  activeWriterSession = {
    ...activeWriterSession,
    routineRuns,
    revision: nextSessionRevision(),
    updatedAt: new Date().toISOString()
  };
  rememberActiveRoutineState();
}

async function restoreRoutineState(session: WriterSession, documentPath: string): Promise<WriterSession> {
  const routineState = routineStateByDocumentPath.get(documentPath) ?? await restoreRoutineStateFromLatestSnapshot(documentPath);
  if (!routineState) {
    return session;
  }
  const routineRuns = await routineRunsWithDownloadCopies(routineState.routineRuns);
  return {
    ...session,
    chatMessages: routineState.chatMessages
      ? [...routineState.chatMessages]
      : [...session.chatMessages],
    routineProgress: [...routineState.routineProgress],
    routineRuns: sortRoutineRuns(routineRuns),
    sourceTrackedChanges: routineState.sourceTrackedChanges
      ? [...routineState.sourceTrackedChanges]
      : [...session.sourceTrackedChanges],
    suggestions: [...routineState.suggestions],
    revision: nextSessionRevision(),
    updatedAt: new Date().toISOString()
  };
}

async function restoreRoutineStateFromLatestSnapshot(documentPath: string): Promise<WriterRoutineState | null> {
  let filenames: string[];
  try {
    filenames = await readdir(join(process.cwd(), "tmp"));
  } catch {
    return null;
  }

  let latest: { exportedAt: number; state: WriterRoutineState } | null = null;
  const encodedDocumentPath = JSON.stringify(documentPath);
  for (const filename of filenames) {
    const lowerFilename = filename.toLowerCase();
    if (!lowerFilename.endsWith(".json") || !isPotentialSessionSnapshotFilename(lowerFilename) || isKnownNonSessionJsonArtifact(lowerFilename)) {
      continue;
    }
    const snapshotPath = join(process.cwd(), "tmp", filename);
    try {
      const prefix = await readFilePrefix(snapshotPath, sessionSnapshotProbeBytes);
      if (!looksLikeSessionSnapshotPrefix(prefix) || !prefix.includes(encodedDocumentPath)) {
        continue;
      }
      const contents = await readFile(snapshotPath, "utf8");
      if (!looksLikeSessionSnapshotJson(contents)) {
        continue;
      }
      const parsed = parseSessionSnapshotRequest(JSON.parse(contents));
      if ("error" in parsed || parsed.snapshot.sourceDocumentPath !== documentPath) {
        continue;
      }
      const exportedAt = Date.parse(parsed.snapshot.exportedAt);
      const snapshotTime = Number.isFinite(exportedAt) ? exportedAt : 0;
      if (!latest || snapshotTime > latest.exportedAt) {
        latest = {
          exportedAt: snapshotTime,
          state: {
            chatMessages: parsed.snapshot.session.chatMessages
              ? [...parsed.snapshot.session.chatMessages]
              : undefined,
            routineProgress: [...parsed.snapshot.session.routineProgress],
            routineRuns: sortRoutineRuns(parsed.snapshot.session.routineRuns),
            sourceTrackedChanges: parsed.snapshot.session.sourceTrackedChanges
              ? [...parsed.snapshot.session.sourceTrackedChanges]
              : undefined,
            suggestions: [...parsed.snapshot.session.suggestions]
          }
        };
      }
    } catch {
      continue;
    }
  }
  return latest?.state ?? null;
}

function isPotentialSessionSnapshotFilename(filename: string): boolean {
  return filename.includes("session")
    || filename.includes("snapshot")
    || filename.includes("autorestore");
}

function isKnownNonSessionJsonArtifact(filename: string): boolean {
  return filename.endsWith("_report.json")
    || filename.endsWith("_review_report.json")
    || filename.endsWith("_suggestions.json")
    || filename.endsWith("_review_suggestions.json");
}

async function readFilePrefix(path: string, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function looksLikeSessionSnapshotPrefix(contents: string): boolean {
  return contents.includes("\"version\"")
    && contents.includes("\"sourceDocumentPath\"")
    && contents.includes("\"session\"");
}

function looksLikeSessionSnapshotJson(contents: string): boolean {
  return contents.includes("\"version\"")
    && contents.includes("\"sourceDocumentPath\"")
    && contents.includes("\"session\"")
    && contents.includes("\"routineRuns\"");
}

function parseAutosavedSessionLoadRequest(body: unknown): { id: string } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Autosaved Writer session load requires a JSON body." };
  }
  const value = body as { id?: unknown };
  if (typeof value.id !== "string" || !value.id.trim()) {
    return { error: "Autosaved Writer session load requires id." };
  }
  const id = value.id.trim();
  if (basename(id) !== id || id.includes("\0")) {
    return { error: "Autosaved Writer session id is invalid." };
  }
  return { id };
}

function sessionSnapshot(session: WriterSession, sourceDocumentPath: string | null): WriterSessionSnapshot {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceDocumentPath,
    session: {
      chatMessages: [...session.chatMessages],
      name: session.name,
      title: session.title,
      routineProgress: [...session.routineProgress],
      routineRuns: sortRoutineRuns(session.routineRuns),
      sourceDocumentId: session.sourceDocumentId,
      sourceTrackedChanges: [...session.sourceTrackedChanges],
      suggestions: [...session.suggestions]
    }
  };
}

async function applySnapshotToSession(session: WriterSession, snapshot: WriterSessionSnapshot): Promise<WriterSession> {
  const routineRuns = await routineRunsWithDownloadCopies(snapshot.session.routineRuns);
  return {
    ...session,
    // Restore the stable document id so #doc= share URLs keep working after
    // restores and sidecar restarts (imports otherwise mint a fresh id).
    ...(snapshot.session.sourceDocumentId
      ? { id: snapshot.session.sourceDocumentId, sourceDocumentId: snapshot.session.sourceDocumentId }
      : {}),
    chatMessages: snapshot.session.chatMessages
      ? [...snapshot.session.chatMessages]
      : [...session.chatMessages],
    name: snapshot.session.name || session.name,
    title: snapshot.session.title || session.title,
    routineProgress: [...snapshot.session.routineProgress],
    routineRuns: sortRoutineRuns(routineRuns).slice(0, 25),
    sourceTrackedChanges: snapshot.session.sourceTrackedChanges
      ? [...snapshot.session.sourceTrackedChanges]
      : [...session.sourceTrackedChanges],
    suggestions: [...snapshot.session.suggestions],
    revision: nextSessionRevision(),
    updatedAt: new Date().toISOString()
  };
}

function sortRoutineRuns(routineRuns: WriterRoutineRun[]): WriterRoutineRun[] {
  return routineRuns
    .map((run, index) => ({ index, run }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.run.completedAt);
      const rightTime = Date.parse(right.run.completedAt);
      const leftValid = Number.isFinite(leftTime);
      const rightValid = Number.isFinite(rightTime);

      if (leftValid && rightValid && leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      if (leftValid !== rightValid) {
        return leftValid ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ run }) => run);
}

function sessionSummary(session: WriterSession): WriterSessionSummary {
  return {
    bodySafeAnchors: session.bodySafeAnchors,
    bodySafeAnchorDetails: session.bodySafeAnchorDetails,
    chatMessages: [...session.chatMessages],
    id: session.id,
    name: session.name,
    title: session.title,
    revision: session.revision,
    sourceDocumentId: session.sourceDocumentId,
    sourceDocument: session.sourceDocument,
    // Prefer the live collaborative text so agents and status reads see what
    // collaborators are typing right now, not the import-time snapshot.
    documentText: liveCollabDocumentText(session.sourceDocumentId) ?? session.documentText,
    documentHtmlLength: session.documentHtml.length,
    features: session.features,
    importMessages: session.importMessages,
    sourceTrackedChanges: session.sourceTrackedChanges,
    routineProgress: session.routineProgress,
    routineRuns: compactRoutineRunsForSessionSummary(sortRoutineRuns(session.routineRuns)),
    suggestions: session.suggestions,
    pendingSuggestions: session.suggestions.filter((suggestion) => suggestion.status === "pending").length,
    updatedAt: session.updatedAt
  };
}

function sessionDocument(session: WriterSession): WriterSessionDocument {
  return {
    ...sessionSummary(session),
    documentHtml: session.documentHtml
  };
}

function compactRoutineRunsForSessionSummary(routineRuns: WriterRoutineRun[]): WriterRoutineRun[] {
  return routineRuns.map((run) => ({
    ...run,
    report: compactRoutineRunReportForSessionSummary(run.report)
  }));
}

function compactRoutineRunReportForSessionSummary(report: WriterRoutineRunReport | null | undefined): WriterRoutineRunReport | null | undefined {
  if (!report) {
    return report;
  }
  return {
    ...report,
    commentedSuggestionOriginals: compactReportOriginalsForSessionSummary(report.commentedSuggestionOriginals),
    unmatchedSuggestionOriginals: compactReportOriginalsForSessionSummary(report.unmatchedSuggestionOriginals)
  };
}

function compactReportOriginalsForSessionSummary(originals: string[] | undefined): string[] | undefined {
  if (!originals) {
    return originals;
  }
  return originals.map(compactReportOriginalForSessionSummary);
}

function compactReportOriginalForSessionSummary(original: string): string {
  const normalized = original.replace(/\s+/g, " ").trim();
  if (normalized.length <= sessionReportOriginalPreviewLimit) {
    return normalized;
  }
  return `${normalized.slice(0, sessionReportOriginalPreviewLimit).trimEnd()}... [${normalized.length} chars; full original remains in the report and suggestions artifacts]`;
}

function parseSessionSnapshotRequest(body: unknown): { snapshot: WriterSessionSnapshot } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Session snapshot import requires a JSON body." };
  }
  const value = body as {
    exportedAt?: unknown;
    session?: unknown;
    sourceDocumentPath?: unknown;
    version?: unknown;
  };
  if (value.version !== 1) {
    return { error: "Unsupported Writer session snapshot version." };
  }
  if (value.sourceDocumentPath !== null && value.sourceDocumentPath !== undefined && (typeof value.sourceDocumentPath !== "string" || !value.sourceDocumentPath.trim())) {
    return { error: "Session snapshot sourceDocumentPath must be null or a non-empty string." };
  }
  if (!value.session || typeof value.session !== "object") {
    return { error: "Session snapshot requires a session object." };
  }

  const snapshotSession = value.session as {
    chatMessages?: unknown;
    name?: unknown;
    routineProgress?: unknown;
    routineRuns?: unknown;
    sourceTrackedChanges?: unknown;
    suggestions?: unknown;
    title?: unknown;
  };
  if (typeof snapshotSession.name !== "string" || !snapshotSession.name.trim()) {
    return { error: "Session snapshot requires session.name." };
  }
  if (typeof snapshotSession.title !== "string" || !snapshotSession.title.trim()) {
    return { error: "Session snapshot requires session.title." };
  }
  const progress = parseRoutineProgressRequest({ routineProgress: snapshotSession.routineProgress });
  if ("error" in progress) {
    return progress;
  }
  if (!Array.isArray(snapshotSession.routineRuns)) {
    return { error: "Session snapshot requires session.routineRuns to be an array." };
  }
  if (!Array.isArray(snapshotSession.suggestions)) {
    return { error: "Session snapshot requires session.suggestions to be an array." };
  }
  const sourceTrackedChanges = parseSourceTrackedChangesSnapshotValue(snapshotSession.sourceTrackedChanges);
  if ("error" in sourceTrackedChanges) {
    return sourceTrackedChanges;
  }
  const chatMessages = parseChatMessagesValue(snapshotSession.chatMessages, "Session snapshot");
  if ("error" in chatMessages) {
    return chatMessages;
  }
  const routineRuns: WriterRoutineRun[] = [];
  for (const run of snapshotSession.routineRuns.slice(0, 25)) {
    const parsed = parseRoutineRunRequest(run);
    if ("error" in parsed) {
      return parsed;
    }
    routineRuns.push(parsed.run);
  }
  let suggestions: AiSuggestion[];
  try {
    suggestions = snapshotSession.suggestions.map(parseRoutineSuggestion).slice(0, 500);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Session snapshot suggestions are invalid." };
  }

  return {
    snapshot: {
      version: 1,
      exportedAt: typeof value.exportedAt === "string" && value.exportedAt.trim() ? value.exportedAt.trim() : new Date().toISOString(),
      sourceDocumentPath: typeof value.sourceDocumentPath === "string" ? value.sourceDocumentPath.trim() : null,
      session: {
        chatMessages: chatMessages.chatMessages,
        name: snapshotSession.name.trim(),
        title: snapshotSession.title.trim(),
        routineProgress: progress.routineProgress,
        routineRuns,
        sourceTrackedChanges: sourceTrackedChanges.sourceTrackedChanges,
        suggestions
      }
    }
  };
}

function parseSourceTrackedChangesSnapshotValue(value: unknown): { sourceTrackedChanges?: SourceTrackedChangePreview[] } | { error: string } {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    return { error: "Session snapshot sourceTrackedChanges must be an array when provided." };
  }
  const sourceTrackedChanges: SourceTrackedChangePreview[] = [];
  for (const item of value.slice(0, 500)) {
    if (!item || typeof item !== "object") {
      return { error: "Session snapshot sourceTrackedChanges entries must be objects." };
    }
    const change = item as {
      author?: unknown;
      date?: unknown;
      kind?: unknown;
      text?: unknown;
    };
    if (change.kind !== "inserted" && change.kind !== "deleted" && change.kind !== "movedFrom" && change.kind !== "movedTo") {
      return { error: "Session snapshot sourceTrackedChanges entries require a supported kind." };
    }
    if (typeof change.text !== "string" || !change.text.trim()) {
      return { error: "Session snapshot sourceTrackedChanges entries require text." };
    }
    sourceTrackedChanges.push({
      kind: change.kind,
      text: change.text.trim(),
      ...(typeof change.author === "string" && change.author.trim() ? { author: change.author.trim() } : {}),
      ...(typeof change.date === "string" && change.date.trim() ? { date: change.date.trim() } : {})
    });
  }
  return { sourceTrackedChanges };
}

function parseChatMessagesRequest(body: unknown): { chatMessages: WriterChatMessage[] } | { error: string } {
  const value = body && typeof body === "object"
    ? (body as { chatMessages?: unknown }).chatMessages
    : undefined;
  const parsed = parseChatMessagesValue(value, "Writer chat history");
  if ("error" in parsed) {
    return parsed;
  }
  return { chatMessages: parsed.chatMessages ?? [] };
}

function parseChatMessagesValue(value: unknown, label: string): { chatMessages?: WriterChatMessage[] } | { error: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (!Array.isArray(value)) {
    return { error: `${label} chatMessages must be an array when provided.` };
  }
  const chatMessages: WriterChatMessage[] = [];
  for (const message of value.slice(-100)) {
    if (!message || typeof message !== "object") {
      return { error: `${label} chatMessages entries must be objects.` };
    }
    const item = message as { author?: unknown; content?: unknown; createdAt?: unknown; id?: unknown; role?: unknown };
    if (item.role !== "assistant" && item.role !== "system" && item.role !== "user") {
      return { error: `${label} chatMessages entries require role to be user, assistant, or system.` };
    }
    if (typeof item.content !== "string" || !item.content.trim()) {
      return { error: `${label} chatMessages entries require non-empty content.` };
    }
    chatMessages.push({
      role: item.role,
      content: item.content.trim(),
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined,
      author: typeof item.author === "string" && item.author.trim() ? item.author.trim().slice(0, 80) : null,
      createdAt: typeof item.createdAt === "string" && item.createdAt.trim() ? item.createdAt : null
    });
  }
  return { chatMessages };
}

function parsePathBody(body: unknown): { path: string } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Writer DOCX open requires a JSON body with path." };
  }
  const path = (body as { path?: unknown }).path;
  if (typeof path !== "string" || !path.trim()) {
    return { error: "Writer DOCX open requires a non-empty path." };
  }
  if (!path.toLowerCase().endsWith(".docx")) {
    return { error: "Writer can only open .docx files." };
  }
  return { path };
}

function parseSessionSuggestRequest(body: unknown, session: WriterSession): { recordSuggestions: boolean; request: AiRequest } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Writer session suggestions require a JSON request body." };
  }

  const value = body as {
    instruction?: unknown;
    maxSuggestions?: unknown;
    mode?: unknown;
    provider?: unknown;
    recordSuggestions?: unknown;
    selection?: unknown;
    selectionText?: unknown;
  };
  const provider = value.provider ?? "codex";
  if (!isLocalAiProviderName(provider)) {
    return { error: "Writer session suggestions require provider to be Codex CLI or Claude Code." };
  }
  if (typeof value.instruction !== "string" || !value.instruction.trim()) {
    return { error: "Writer session suggestions require an instruction string." };
  }

  const mode = value.mode ?? "global";
  if (mode !== "global" && mode !== "selection") {
    return { error: "Writer session suggestions require mode to be global or selection." };
  }

  const selection = mode === "selection"
    ? parseSessionSelection(value.selection, value.selectionText, session.documentText)
    : null;
  if (selection && "error" in selection) {
    return selection;
  }
  if (mode === "selection" && !selection) {
    return { error: "Selection mode requires selection or selectionText." };
  }
  const maxSuggestions = parseMaxSuggestions(value.maxSuggestions, "Writer session suggestions");
  if ("error" in maxSuggestions) {
    return maxSuggestions;
  }
  if (value.recordSuggestions !== undefined && typeof value.recordSuggestions !== "boolean") {
    return { error: "Writer session suggestions recordSuggestions must be a boolean when provided." };
  }

  const requestedByRaw = (body as { requestedBy?: unknown }).requestedBy;
  return {
    recordSuggestions: value.recordSuggestions ?? true,
    request: {
      provider,
      instruction: value.instruction.trim(),
      mode,
      documentHtml: "",
      documentText: session.documentText,
      maxSuggestions: maxSuggestions.value,
      selection: selection ?? null,
      requestedBy: typeof requestedByRaw === "string" && requestedByRaw.trim() ? requestedByRaw.trim().slice(0, 80) : "Agent"
    }
  };
}

function parseSessionSelection(
  selection: unknown,
  selectionText: unknown,
  documentText: string
): SelectionContext | { error: string } | null {
  if (isSelectionContext(selection)) {
    return selection;
  }
  if (typeof selectionText !== "string" || !selectionText.trim()) {
    return null;
  }
  const from = documentText.indexOf(selectionText);
  if (from < 0) {
    return { error: "selectionText was not found in the active Writer document." };
  }
  return {
    from,
    to: from + selectionText.length,
    text: selectionText
  };
}

function parseSuggestionStatusRequest(body: unknown): {
  decidedBy: string | null;
  decisionNote: string | null;
  expectedStatus: AiSuggestion["status"] | null;
  id: string;
  status: AiSuggestion["status"];
} | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Suggestion status update requires a JSON body." };
  }
  const value = body as { decidedBy?: unknown; decisionNote?: unknown; expectedStatus?: unknown; id?: unknown; status?: unknown };
  if (typeof value.id !== "string" || !value.id.trim()) {
    return { error: "Suggestion status update requires an id." };
  }
  if (value.status !== "pending" && value.status !== "accepted" && value.status !== "rejected") {
    return { error: "Suggestion status must be pending, accepted, or rejected." };
  }
  if (value.expectedStatus !== undefined && value.expectedStatus !== "pending" && value.expectedStatus !== "accepted" && value.expectedStatus !== "rejected") {
    return { error: "expectedStatus must be pending, accepted, or rejected when provided." };
  }
  return {
    decidedBy: typeof value.decidedBy === "string" && value.decidedBy.trim() ? value.decidedBy.trim().slice(0, 80) : null,
    decisionNote: typeof value.decisionNote === "string" && value.decisionNote.trim() ? value.decisionNote.trim().slice(0, 280) : null,
    expectedStatus: (value.expectedStatus as AiSuggestion["status"] | undefined) ?? null,
    id: value.id,
    status: value.status
  };
}

function parseRoutineProgressRequest(body: unknown): { routineProgress: string[] } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Routine progress update requires a JSON body." };
  }
  const value = (body as { routineProgress?: unknown }).routineProgress;
  if (!Array.isArray(value)) {
    return { error: "Routine progress update requires routineProgress to be an array." };
  }
  const routineProgress: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      return { error: "Routine progress ids must be non-empty strings." };
    }
    if (!routineProgress.includes(item)) {
      routineProgress.push(item);
    }
  }
  return { routineProgress };
}

function routineProgressWithRecordedRun(routineProgress: string[], run: WriterRoutineRun): string[] {
  if (!r01RoutineSequenceIds.has(run.routineId) || routineProgress.includes(run.routineId)) {
    return routineProgress;
  }
  return [...routineProgress, run.routineId];
}

function parseRoutineRunRequest(body: unknown): { run: WriterRoutineRun } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Routine run update requires a JSON body." };
  }
  const value = body as {
    artifactPath?: unknown;
    completedAt?: unknown;
    downloadCopyPath?: unknown;
    id?: unknown;
    instruction?: unknown;
    label?: unknown;
    report?: unknown;
    reportPath?: unknown;
    routineId?: unknown;
    sourceDocument?: unknown;
    suggestionsPath?: unknown;
  };
  if (typeof value.routineId !== "string" || !value.routineId.trim()) {
    return { error: "Routine run update requires routineId to be a non-empty string." };
  }
  if (typeof value.label !== "string" || !value.label.trim()) {
    return { error: "Routine run update requires label to be a non-empty string." };
  }
  if (value.id !== undefined && (typeof value.id !== "string" || !value.id.trim())) {
    return { error: "Routine run id must be a non-empty string when provided." };
  }
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || !value.completedAt.trim())) {
    return { error: "Routine run completedAt must be a non-empty string when provided." };
  }
  if (value.instruction !== undefined && value.instruction !== null && (typeof value.instruction !== "string" || !value.instruction.trim())) {
    return { error: "Routine run instruction must be null or a non-empty string when provided." };
  }
  if (value.artifactPath !== undefined && value.artifactPath !== null && (typeof value.artifactPath !== "string" || !value.artifactPath.trim())) {
    return { error: "Routine run artifactPath must be null or a non-empty string when provided." };
  }
  if (value.downloadCopyPath !== undefined && value.downloadCopyPath !== null && (typeof value.downloadCopyPath !== "string" || !value.downloadCopyPath.trim())) {
    return { error: "Routine run downloadCopyPath must be null or a non-empty string when provided." };
  }
  if (value.suggestionsPath !== undefined && value.suggestionsPath !== null && (typeof value.suggestionsPath !== "string" || !value.suggestionsPath.trim())) {
    return { error: "Routine run suggestionsPath must be null or a non-empty string when provided." };
  }
  if (value.reportPath !== undefined && value.reportPath !== null && (typeof value.reportPath !== "string" || !value.reportPath.trim())) {
    return { error: "Routine run reportPath must be null or a non-empty string when provided." };
  }
  const report = parseRoutineRunReport(value.report);
  if ("error" in report) {
    return report;
  }
  const sourceDocument = parseWriterReviewSourceDocument(value.sourceDocument);
  if ("error" in sourceDocument) {
    return sourceDocument;
  }

  return {
    run: {
      id: typeof value.id === "string" ? value.id.trim() : randomUUID(),
      routineId: value.routineId.trim(),
      label: value.label.trim(),
      completedAt: typeof value.completedAt === "string" ? value.completedAt.trim() : new Date().toISOString(),
      artifactPath: typeof value.artifactPath === "string" ? value.artifactPath.trim() : null,
      downloadCopyPath: typeof value.downloadCopyPath === "string" ? value.downloadCopyPath.trim() : null,
      instruction: typeof value.instruction === "string" ? value.instruction.trim() : null,
      reportPath: typeof value.reportPath === "string" ? value.reportPath.trim() : null,
      suggestionsPath: typeof value.suggestionsPath === "string" ? value.suggestionsPath.trim() : null,
      report: report.report,
      sourceDocument: sourceDocument.sourceDocument
    }
  };
}

function parseWriterReviewSourceDocument(value: unknown): { sourceDocument: WriterReviewSourceDocument | null } | { error: string } {
  if (value === undefined || value === null) {
    return { sourceDocument: null };
  }
  if (!value || typeof value !== "object") {
    return { error: "Routine run sourceDocument must be null or an object when provided." };
  }
  const source = value as Record<string, unknown>;
  if (typeof source.path !== "string" || !source.path.trim()) {
    return { error: "Routine run sourceDocument.path must be a non-empty string." };
  }
  const optionalStrings = [
    "afterReadModifiedAt",
    "modifiedAt",
    "readAt",
    "unavailableReason"
  ] as const;
  const optionalNumbers = [
    "afterReadModifiedMs",
    "afterReadSizeBytes",
    "filesystemSizeBytes",
    "modifiedMs",
    "sizeBytes"
  ] as const;
  for (const key of optionalStrings) {
    if (source[key] !== undefined && (typeof source[key] !== "string" || !source[key].trim())) {
      return { error: `Routine run sourceDocument.${key} must be a non-empty string when provided.` };
    }
  }
  for (const key of optionalNumbers) {
    if (source[key] !== undefined && (typeof source[key] !== "number" || !Number.isFinite(source[key]))) {
      return { error: `Routine run sourceDocument.${key} must be a finite number when provided.` };
    }
  }
  if (source.changedWhileReading !== undefined && typeof source.changedWhileReading !== "boolean") {
    return { error: "Routine run sourceDocument.changedWhileReading must be a boolean when provided." };
  }
  if (source.usedInMemoryFallback !== undefined && typeof source.usedInMemoryFallback !== "boolean") {
    return { error: "Routine run sourceDocument.usedInMemoryFallback must be a boolean when provided." };
  }

  return {
    sourceDocument: {
      path: source.path.trim(),
      ...(typeof source.modifiedAt === "string" ? { modifiedAt: source.modifiedAt.trim() } : {}),
      ...(typeof source.modifiedMs === "number" ? { modifiedMs: source.modifiedMs } : {}),
      ...(typeof source.readAt === "string" ? { readAt: source.readAt.trim() } : {}),
      ...(typeof source.sizeBytes === "number" ? { sizeBytes: source.sizeBytes } : {}),
      ...(typeof source.filesystemSizeBytes === "number" ? { filesystemSizeBytes: source.filesystemSizeBytes } : {}),
      ...(typeof source.changedWhileReading === "boolean" ? { changedWhileReading: source.changedWhileReading } : {}),
      ...(typeof source.afterReadModifiedAt === "string" ? { afterReadModifiedAt: source.afterReadModifiedAt.trim() } : {}),
      ...(typeof source.afterReadModifiedMs === "number" ? { afterReadModifiedMs: source.afterReadModifiedMs } : {}),
      ...(typeof source.afterReadSizeBytes === "number" ? { afterReadSizeBytes: source.afterReadSizeBytes } : {}),
      ...(typeof source.unavailableReason === "string" ? { unavailableReason: source.unavailableReason.trim() } : {}),
      ...(typeof source.usedInMemoryFallback === "boolean" ? { usedInMemoryFallback: source.usedInMemoryFallback } : {})
    }
  };
}

async function readRoutineSuggestions(path: string): Promise<AiSuggestion[]> {
  if (!path.toLowerCase().endsWith(".json")) {
    throw new Error("Routine suggestions must point to a JSON file.");
  }
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const value = parsed && typeof parsed === "object" && Array.isArray((parsed as { suggestions?: unknown }).suggestions)
    ? (parsed as { suggestions: unknown[] }).suggestions
    : Array.isArray(parsed)
      ? parsed
      : null;
  if (!value) {
    throw new Error("Routine suggestions JSON must contain a suggestions array.");
  }
  const suggestions = value.map(parseRoutineSuggestion);
  if (!suggestions.length) {
    throw new Error("Routine suggestions JSON did not contain any suggestions.");
  }
  return suggestions.slice(0, 200);
}

function parseRoutineSuggestion(value: unknown): AiSuggestion {
  if (!value || typeof value !== "object") {
    throw new Error("Routine suggestions must be objects.");
  }
  const suggestion = value as Partial<AiSuggestion>;
  const commentOnly = suggestion.commentOnly === true;
  const id = typeof suggestion.id === "string" && suggestion.id.trim() ? suggestion.id.trim() : randomUUID();
  const title = requireSuggestionString(suggestion.title, "title");
  const original = requireSuggestionString(suggestion.original, "original");
  // Comment-only suggestions raise a concern about the anchored text without
  // proposing replacement prose, so an empty replacement is valid for them.
  // An EXPLICIT empty-string replacement is also valid for text edits: it
  // proposes deleting the original (the accept path and Word review exports
  // both support pure deletions). Only a MISSING replacement is an error --
  // that's an agent forgetting the field, not proposing a deletion.
  const replacement = commentOnly || typeof suggestion.replacement === "string"
    ? (typeof suggestion.replacement === "string" ? suggestion.replacement.trim() : "")
    : requireSuggestionString(suggestion.replacement, "replacement");
  const rationale = requireSuggestionString(suggestion.rationale, "rationale");
  const confidence = typeof suggestion.confidence === "number" && Number.isFinite(suggestion.confidence)
    ? Math.min(1, Math.max(0, suggestion.confidence))
    : 0.5;
  const proposedBy = optionalSuggestionActor(suggestion.proposedBy);
  const decidedBy = optionalSuggestionActor(suggestion.decidedBy);
  const decidedAt = typeof suggestion.decidedAt === "string" && suggestion.decidedAt.trim() ? suggestion.decidedAt : null;
  const decisionNote = typeof suggestion.decisionNote === "string" && suggestion.decisionNote.trim() ? suggestion.decisionNote.trim() : null;
  return {
    ...(commentOnly ? { commentOnly: true } : {}),
    id,
    title,
    original,
    replacement,
    rationale,
    confidence,
    target: suggestion.target === "selection" ? "selection" : "global",
    range: normalizeSuggestionRange(original, suggestion.range),
    ...(isSuggestionAnchor(suggestion.anchor) ? { anchor: suggestion.anchor } : {}),
    status: suggestion.status === "accepted" || suggestion.status === "rejected" ? suggestion.status : "pending",
    ...(proposedBy ? { proposedBy } : {}),
    ...(decidedBy ? { decidedBy } : {}),
    ...(decidedAt ? { decidedAt } : {}),
    ...(decisionNote ? { decisionNote } : {})
  };
}

// Attribution names ride into exported w:author values; keep them short and trimmed.
function optionalSuggestionActor(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

function normalizeSuggestionRange(original: string, range: unknown): SelectionContext | null {
  if (!isSelectionContext(range)) {
    return null;
  }
  if (range.text === original || range.text.includes(original)) {
    return range;
  }
  return { ...range, text: original };
}

function requireSuggestionString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Routine suggestion ${key} must be a non-empty string.`);
  }
  return value.trim();
}

function mergeSessionSuggestions(incoming: AiSuggestion[], existing: AiSuggestion[]): AiSuggestion[] {
  const incomingIds = new Set(incoming.map((suggestion) => suggestion.id));
  return [
    ...incoming,
    ...existing.filter((suggestion) => !incomingIds.has(suggestion.id))
  ];
}

function parseRoutineRunIdRequest(body: unknown): { id: string } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Routine artifact request requires a JSON body." };
  }
  const id = (body as { id?: unknown }).id;
  if (typeof id !== "string" || !id.trim()) {
    return { error: "Routine artifact request requires id to be a non-empty string." };
  }
  return { id: id.trim() };
}

function parseRoutineRunReport(report: unknown): { report: WriterRoutineRunReport | null } | { error: string } {
  if (report === undefined || report === null) {
    return { report: null };
  }
  if (!report || typeof report !== "object") {
    return { error: "Routine run report must be null or an object." };
  }
  const value = report as Record<string, unknown>;
  const totalSuggestions = parseRoutineRunReportNumber(value.totalSuggestions, "totalSuggestions");
  if ("error" in totalSuggestions) {
    return totalSuggestions;
  }
  const matchedSuggestions = parseRoutineRunReportNumber(value.matchedSuggestions, "matchedSuggestions");
  if ("error" in matchedSuggestions) {
    return matchedSuggestions;
  }
  const commentedSuggestions = parseRoutineRunReportNumber(value.commentedSuggestions, "commentedSuggestions");
  if ("error" in commentedSuggestions) {
    return commentedSuggestions;
  }
  const unmatchedSuggestions = parseRoutineRunReportNumber(value.unmatchedSuggestions, "unmatchedSuggestions");
  if ("error" in unmatchedSuggestions) {
    return unmatchedSuggestions;
  }
  const representedSuggestions = value.representedSuggestions === undefined || value.representedSuggestions === null
    ? { value: matchedSuggestions.value + commentedSuggestions.value }
    : parseRoutineRunReportNumber(value.representedSuggestions, "representedSuggestions");
  if ("error" in representedSuggestions) {
    return representedSuggestions;
  }
  const commentedSuggestionTitles = parseRoutineRunReportStringList(value.commentedSuggestionTitles, "commentedSuggestionTitles");
  if ("error" in commentedSuggestionTitles) {
    return commentedSuggestionTitles;
  }
  const commentedSuggestionIds = parseRoutineRunReportStringList(value.commentedSuggestionIds, "commentedSuggestionIds");
  if ("error" in commentedSuggestionIds) {
    return commentedSuggestionIds;
  }
  const matchedSuggestionTitles = parseRoutineRunReportStringList(value.matchedSuggestionTitles, "matchedSuggestionTitles");
  if ("error" in matchedSuggestionTitles) {
    return matchedSuggestionTitles;
  }
  const matchedSuggestionIds = parseRoutineRunReportStringList(value.matchedSuggestionIds, "matchedSuggestionIds");
  if ("error" in matchedSuggestionIds) {
    return matchedSuggestionIds;
  }
  const commentedSuggestionOriginals = parseRoutineRunReportStringList(value.commentedSuggestionOriginals, "commentedSuggestionOriginals");
  if ("error" in commentedSuggestionOriginals) {
    return commentedSuggestionOriginals;
  }
  const commentedSuggestionReasons = parseRoutineRunReportStringList(value.commentedSuggestionReasons, "commentedSuggestionReasons");
  if ("error" in commentedSuggestionReasons) {
    return commentedSuggestionReasons;
  }
  const commentedSuggestionReasonCounts = parseRoutineRunReportReasonCounts(value.commentedSuggestionReasonCounts, "commentedSuggestionReasonCounts");
  if ("error" in commentedSuggestionReasonCounts) {
    return commentedSuggestionReasonCounts;
  }
  const unmatchedSuggestionTitles = parseRoutineRunReportStringList(value.unmatchedSuggestionTitles, "unmatchedSuggestionTitles");
  if ("error" in unmatchedSuggestionTitles) {
    return unmatchedSuggestionTitles;
  }
  const unmatchedSuggestionIds = parseRoutineRunReportStringList(value.unmatchedSuggestionIds, "unmatchedSuggestionIds");
  if ("error" in unmatchedSuggestionIds) {
    return unmatchedSuggestionIds;
  }
  const unmatchedSuggestionOriginals = parseRoutineRunReportStringList(value.unmatchedSuggestionOriginals, "unmatchedSuggestionOriginals");
  if ("error" in unmatchedSuggestionOriginals) {
    return unmatchedSuggestionOriginals;
  }
  if (totalSuggestions.value === 0) {
    return { error: "Routine run report totalSuggestions must be greater than zero." };
  }
  if (
    matchedSuggestions.value > totalSuggestions.value
    || commentedSuggestions.value > totalSuggestions.value
    || representedSuggestions.value > totalSuggestions.value
    || unmatchedSuggestions.value > totalSuggestions.value
  ) {
    return { error: "Routine run report matched, commented, represented, and unmatched counts must not exceed totalSuggestions." };
  }
  if (representedSuggestions.value !== matchedSuggestions.value + commentedSuggestions.value) {
    return { error: "Routine run report representedSuggestions must equal matchedSuggestions plus commentedSuggestions." };
  }
  return {
    report: {
      totalSuggestions: totalSuggestions.value,
      matchedSuggestions: matchedSuggestions.value,
      matchedSuggestionIds: matchedSuggestionIds.value,
      matchedSuggestionTitles: matchedSuggestionTitles.value,
      commentedSuggestions: commentedSuggestions.value,
      commentedSuggestionIds: commentedSuggestionIds.value,
      commentedSuggestionOriginals: commentedSuggestionOriginals.value,
      commentedSuggestionReasonCounts: commentedSuggestionReasonCounts.value.length
        ? commentedSuggestionReasonCounts.value
        : summarizeRoutineRunReportStringCounts(commentedSuggestionReasons.value),
      commentedSuggestionReasons: commentedSuggestionReasons.value,
      commentedSuggestionTitles: commentedSuggestionTitles.value,
      representedSuggestions: representedSuggestions.value,
      unmatchedSuggestions: unmatchedSuggestions.value,
      unmatchedSuggestionIds: unmatchedSuggestionIds.value,
      unmatchedSuggestionOriginals: unmatchedSuggestionOriginals.value,
      unmatchedSuggestionTitles: unmatchedSuggestionTitles.value
    }
  };
}

function parseRoutineRunReportReasonCounts(value: unknown, key: string): { value: Array<{ count: number; reason: string }> } | { error: string } {
  if (value === undefined || value === null) {
    return { value: [] };
  }
  if (!Array.isArray(value)) {
    return { error: `Routine run report ${key} must be an array when provided.` };
  }
  const counts: Array<{ count: number; reason: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return { error: `Routine run report ${key} entries must be objects.` };
    }
    const entry = item as { count?: unknown; reason?: unknown };
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      return { error: `Routine run report ${key} entries require a non-empty reason.` };
    }
    if (typeof entry.count !== "number" || !Number.isFinite(entry.count) || entry.count <= 0) {
      return { error: `Routine run report ${key} entries require a positive count.` };
    }
    counts.push({ count: Math.trunc(entry.count), reason: entry.reason.trim() });
  }
  return { value: counts.slice(0, 20) };
}

function parseRoutineRunReportStringList(value: unknown, key: string): { value: string[] } | { error: string } {
  if (value === undefined || value === null) {
    return { value: [] };
  }
  if (!Array.isArray(value)) {
    return { error: `Routine run report ${key} must be an array when provided.` };
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return { error: `Routine run report ${key} must contain only strings.` };
    }
    const trimmed = item.trim();
    if (trimmed) {
      strings.push(trimmed);
    }
  }
  return { value: strings.slice(0, key.endsWith("Ids") ? 500 : 20) };
}

function parseRoutineRunReportNumber(value: unknown, key: string): { value: number } | { error: string } {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { error: `Routine run report ${key} must be a non-negative number.` };
  }
  return { value: Math.trunc(value) };
}

function summarizeRoutineRunReportStringCounts(values: string[]): Array<{ count: number; reason: string }> {
  const counts = new Map<string, number>();
  values.forEach((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  });
  return [...counts.entries()]
    .map(([reason, count]) => ({ count, reason }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

interface SessionExportRoutineRunRequest {
  completedAt?: string;
  id?: string;
  instruction?: string | null;
  label: string;
  routineId: string;
}

function parseSessionExportRequest(body: unknown): { copyToDownloads: boolean; outputPath?: string; pendingOnly: boolean; reportOutputPath?: string; sessionSnapshotOutputPath?: string; suggestionIds?: string[]; suggestions?: AiSuggestion[]; suggestionsOutputPath?: string; routineRun?: SessionExportRoutineRunRequest } | { error: string } {
  const value = body && typeof body === "object"
    ? body as { copyToDownloads?: unknown; outputPath?: unknown; pendingOnly?: unknown; reportOutputPath?: unknown; routineRun?: unknown; sessionSnapshotOutputPath?: unknown; suggestionIds?: unknown; suggestions?: unknown; suggestionsOutputPath?: unknown }
    : {};
  if (value.copyToDownloads !== undefined && typeof value.copyToDownloads !== "boolean") {
    return { error: "Writer review export copyToDownloads must be a boolean when provided." };
  }
  if (value.outputPath !== undefined && (typeof value.outputPath !== "string" || !value.outputPath.trim())) {
    return { error: "Writer review export outputPath must be a non-empty string when provided." };
  }
  if (value.suggestionsOutputPath !== undefined && (typeof value.suggestionsOutputPath !== "string" || !value.suggestionsOutputPath.trim())) {
    return { error: "Writer review export suggestionsOutputPath must be a non-empty string when provided." };
  }
  if (value.reportOutputPath !== undefined && (typeof value.reportOutputPath !== "string" || !value.reportOutputPath.trim())) {
    return { error: "Writer review export reportOutputPath must be a non-empty string when provided." };
  }
  if (value.sessionSnapshotOutputPath !== undefined && (typeof value.sessionSnapshotOutputPath !== "string" || !value.sessionSnapshotOutputPath.trim())) {
    return { error: "Writer review export sessionSnapshotOutputPath must be a non-empty string when provided." };
  }
  if (value.pendingOnly !== undefined && typeof value.pendingOnly !== "boolean") {
    return { error: "Writer review export pendingOnly must be a boolean when provided." };
  }
  const routineRun = parseSessionExportRoutineRun(value.routineRun);
  if ("error" in routineRun) {
    return routineRun;
  }
  const suggestions = parseSessionExportSuggestions(value.suggestions);
  if ("error" in suggestions) {
    return suggestions;
  }
  const suggestionIds = parseSessionExportSuggestionIds(value.suggestionIds);
  if ("error" in suggestionIds) {
    return suggestionIds;
  }
  if (suggestions.suggestions && suggestionIds.suggestionIds) {
    return { error: "Writer review export must include either suggestions or suggestionIds, not both." };
  }
  return {
    copyToDownloads: value.copyToDownloads ?? false,
    outputPath: typeof value.outputPath === "string" ? value.outputPath : undefined,
    pendingOnly: value.pendingOnly ?? true,
    reportOutputPath: typeof value.reportOutputPath === "string" ? value.reportOutputPath : undefined,
    routineRun: routineRun.routineRun,
    sessionSnapshotOutputPath: typeof value.sessionSnapshotOutputPath === "string" ? value.sessionSnapshotOutputPath : undefined,
    suggestionIds: suggestionIds.suggestionIds,
    suggestions: suggestions.suggestions,
    suggestionsOutputPath: typeof value.suggestionsOutputPath === "string" ? value.suggestionsOutputPath : undefined
  };
}

function parseSessionExportSuggestionIds(value: unknown): { suggestionIds?: string[] } | { error: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (!Array.isArray(value)) {
    return { error: "Writer review export suggestionIds must be an array when provided." };
  }
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !id.trim()) {
      return { error: "Writer review export suggestionIds must contain non-empty strings." };
    }
    ids.push(id.trim());
  }
  return { suggestionIds: [...new Set(ids)] };
}

function parseSessionExportSuggestions(value: unknown): { suggestions?: AiSuggestion[] } | { error: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (!Array.isArray(value)) {
    return { error: "Writer review export suggestions must be an array when provided." };
  }
  try {
    return { suggestions: value.map(parseRoutineSuggestion) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Writer review export suggestions are invalid." };
  }
}

function reviewSuggestionsPath(outputPath: string): string {
  return outputPath.replace(/\.docx$/i, "_suggestions.json");
}

function reviewReportPath(outputPath: string): string {
  return outputPath.replace(/\.docx$/i, "_report.json");
}

async function copyReviewToDownloads(outputPath: string): Promise<string> {
  const downloadsDir = process.env.WRITER_DOWNLOADS_DIR || join(homedir(), "Downloads");
  const downloadCopyPath = join(downloadsDir, basename(outputPath));
  await mkdir(downloadsDir, { recursive: true });
  if (downloadCopyPath !== outputPath) {
    await copyFile(outputPath, downloadCopyPath);
  }
  return downloadCopyPath;
}

async function routineRunWithDownloadCopy(run: WriterRoutineRun): Promise<WriterRoutineRun> {
  if (run.downloadCopyPath || !run.artifactPath || !run.artifactPath.toLowerCase().endsWith(".docx")) {
    return run;
  }
  if (isLocalTmpRoutineArtifact(run.artifactPath)) {
    return run;
  }
  try {
    await stat(run.artifactPath);
    return {
      ...run,
      downloadCopyPath: await copyReviewToDownloads(run.artifactPath)
    };
  } catch {
    return run;
  }
}

function isLocalTmpRoutineArtifact(artifactPath: string): boolean {
  const localTmpRoot = resolve(process.cwd(), "tmp");
  const resolvedArtifactPath = resolve(artifactPath);
  const relativeArtifactPath = relative(localTmpRoot, resolvedArtifactPath);
  return Boolean(relativeArtifactPath)
    && !relativeArtifactPath.startsWith("..")
    && !isAbsolute(relativeArtifactPath);
}

async function routineRunsWithDownloadCopies(routineRuns: WriterRoutineRun[]): Promise<WriterRoutineRun[]> {
  return Promise.all(routineRuns.map((run) => routineRunWithDownloadCopy(run)));
}

async function sourceBufferForReviewExport(sourceDocumentId: string, sourceDocumentPath: string | null) {
  if (!sourceDocumentPath) {
    return {
      buffer: importedDocuments.get(sourceDocumentId) ?? null,
      sourceDocument: null
    };
  }
  try {
    const infoBeforeRead = await stat(sourceDocumentPath);
    const buffer = await readFile(sourceDocumentPath);
    const infoAfterRead = await stat(sourceDocumentPath);
    importedDocuments.set(sourceDocumentId, buffer);
    return {
      buffer,
      sourceDocument: writerReviewSourceDocumentFromStat(sourceDocumentPath, buffer.length, infoBeforeRead, infoAfterRead)
    };
  } catch (error) {
    const fallbackBuffer = importedDocuments.get(sourceDocumentId) ?? null;
    return {
      buffer: fallbackBuffer,
      sourceDocument: {
        path: sourceDocumentPath,
        readAt: new Date().toISOString(),
        unavailableReason: error instanceof Error ? error.message : "Unable to read source document.",
        usedInMemoryFallback: Boolean(fallbackBuffer)
      }
    };
  }
}

type WriterSourceStat = Awaited<ReturnType<typeof stat>>;

function writerReviewSourceDocumentFromStat(sourceDocumentPath: string, sizeBytes: number, infoBeforeRead: WriterSourceStat, infoAfterRead: WriterSourceStat): WriterReviewSourceDocument {
  const beforeModifiedMs = Number(infoBeforeRead.mtimeMs);
  const beforeSize = Number(infoBeforeRead.size);
  const afterModifiedMs = Number(infoAfterRead.mtimeMs);
  const afterSize = Number(infoAfterRead.size);
  const changedWhileReading = beforeModifiedMs !== afterModifiedMs || beforeSize !== afterSize;
  return {
    path: sourceDocumentPath,
    modifiedAt: infoBeforeRead.mtime.toISOString(),
    modifiedMs: beforeModifiedMs,
    readAt: new Date().toISOString(),
    sizeBytes,
    filesystemSizeBytes: beforeSize,
    changedWhileReading,
    ...(changedWhileReading
      ? {
          afterReadModifiedAt: infoAfterRead.mtime.toISOString(),
          afterReadModifiedMs: afterModifiedMs,
          afterReadSizeBytes: afterSize
        }
      : {})
  };
}

function defaultReviewOutputPath(session: WriterSession, routineRun?: SessionExportRoutineRunRequest): string {
  const documentStem = sanitizeFilename(session.title || session.name.replace(/\.docx$/i, "") || "writer-review");
  const routineStem = routineRun?.label ? `_${sanitizeFilename(routineRun.label)}` : "";
  return join(process.cwd(), "tmp", `${documentStem}${routineStem}_${reviewTimestamp()}_review.docx`);
}

function defaultSessionSnapshotFilename(session: WriterSession): string {
  const stem = sanitizeFilename(session.title || session.name.replace(/\.docx$/i, "") || "writer-session");
  return `${stem}_${reviewTimestamp()}_nebula-session.json`;
}

function reviewTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseSessionExportRoutineRun(value: unknown): { routineRun?: SessionExportRoutineRunRequest } | { error: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object") {
    return { error: "Writer review export routineRun must be an object when provided." };
  }
  const routineRun = value as { completedAt?: unknown; id?: unknown; instruction?: unknown; label?: unknown; routineId?: unknown };
  if (typeof routineRun.routineId !== "string" || !routineRun.routineId.trim()) {
    return { error: "Writer review export routineRun requires routineId to be a non-empty string." };
  }
  if (typeof routineRun.label !== "string" || !routineRun.label.trim()) {
    return { error: "Writer review export routineRun requires label to be a non-empty string." };
  }
  if (routineRun.id !== undefined && (typeof routineRun.id !== "string" || !routineRun.id.trim())) {
    return { error: "Writer review export routineRun id must be a non-empty string when provided." };
  }
  if (routineRun.completedAt !== undefined && (typeof routineRun.completedAt !== "string" || !routineRun.completedAt.trim())) {
    return { error: "Writer review export routineRun completedAt must be a non-empty string when provided." };
  }
  if (routineRun.instruction !== undefined && routineRun.instruction !== null && (typeof routineRun.instruction !== "string" || !routineRun.instruction.trim())) {
    return { error: "Writer review export routineRun instruction must be null or a non-empty string when provided." };
  }
  return {
    routineRun: {
      completedAt: typeof routineRun.completedAt === "string" ? routineRun.completedAt.trim() : undefined,
      id: typeof routineRun.id === "string" ? routineRun.id.trim() : undefined,
      instruction: typeof routineRun.instruction === "string" ? routineRun.instruction.trim() : null,
      label: routineRun.label.trim(),
      routineId: routineRun.routineId.trim()
    }
  };
}

function routineRunFromExport(
  request: SessionExportRoutineRunRequest,
  artifactPath: string,
  suggestionsPath: string,
  reportPath: string,
  downloadCopyPath: string | null,
  report: TrackedChangeExportReport | null,
  suggestions: AiSuggestion[],
  sourceDocument: WriterReviewSourceDocument | null
): WriterRoutineRun {
  return {
    id: request.id ?? randomUUID(),
    routineId: request.routineId,
    label: request.label,
    completedAt: request.completedAt ?? new Date().toISOString(),
    artifactPath,
    downloadCopyPath,
    instruction: request.instruction ?? null,
    reportPath,
    suggestionsPath,
    report: report ? writerRoutineRunReportFromExport(report, suggestions) : null,
    sourceDocument
  };
}

function writerRoutineRunReportFromExport(report: TrackedChangeExportReport, suggestions: AiSuggestion[]): WriterRoutineRunReport {
  const suggestionsById = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]));
  return {
    totalSuggestions: report.totalSuggestions,
    matchedSuggestions: report.matchedSuggestions,
    matchedSuggestionIds: report.matchedSuggestionIds,
    matchedSuggestionTitles: report.matchedSuggestionTitles,
    commentedSuggestions: report.commentedSuggestions,
    commentedSuggestionIds: report.commentedSuggestionIds,
    commentedSuggestionOriginals: report.commentedSuggestionIds.map((id) => suggestionsById.get(id)?.original ?? "").filter(Boolean),
    commentedSuggestionReasonCounts: summarizeRoutineRunReportStringCounts(report.commentedSuggestionReasons),
    commentedSuggestionReasons: report.commentedSuggestionReasons,
    commentedSuggestionTitles: report.commentedSuggestionTitles,
    representedSuggestions: report.matchedSuggestions + report.commentedSuggestions,
    unmatchedSuggestions: report.unmatchedSuggestions,
    unmatchedSuggestionIds: report.unmatchedSuggestionIds,
    unmatchedSuggestionOriginals: report.unmatchedSuggestionIds.map((id) => suggestionsById.get(id)?.original ?? "").filter(Boolean),
    unmatchedSuggestionTitles: report.unmatchedSuggestionTitles
  };
}

function suggestionForReviewExport(suggestion: AiSuggestion): AiSuggestion {
  if (suggestion.commentOnly || !replacementRequiresAuthorConfirmation(suggestion.replacement)) {
    return suggestion;
  }
  return { ...suggestion, commentOnly: true };
}

function reviewPlacementsFromExportReport(suggestions: AiSuggestion[], report: TrackedChangeExportReport) {
  const placements = new Map<string, { outcome: "tracked-change" | "word-comment" | "unresolved"; reason?: string }>();
  report.matchedSuggestionIds.forEach((id) => placements.set(id, { outcome: "tracked-change" }));
  report.commentedSuggestionIds.forEach((id, index) => placements.set(id, { outcome: "word-comment", reason: report.commentedSuggestionReasons[index] }));
  report.unmatchedSuggestionIds.forEach((id) => placements.set(id, { outcome: "unresolved" }));

  return suggestions.map((suggestion) => {
    const placement = placements.get(suggestion.id) ?? { outcome: "unresolved" as const };
    return {
      id: suggestion.id,
      originalLength: suggestion.original.length,
      originalPreview: reviewPlacementPreview(suggestion.original),
      replacementLength: suggestion.replacement.length,
      replacementPreview: reviewPlacementPreview(suggestion.replacement),
      scale: reviewPlacementScale(suggestion),
      sectionHint: reviewPlacementSectionHint(suggestion),
      title: suggestion.title,
      ...placement,
      handoff: reviewPlacementHandoff(placement, suggestion)
    };
  });
}

function reviewSummaryFromExportReport(report: TrackedChangeExportReport | null, suggestions: AiSuggestion[] = []) {
  if (!report) {
    return null;
  }
  const representedSuggestions = report.matchedSuggestions + report.commentedSuggestions;
  const representedSuggestionIds = new Set([...report.matchedSuggestionIds, ...report.commentedSuggestionIds]);
  const representedSuggestionsList = suggestions.filter((suggestion) => representedSuggestionIds.has(suggestion.id));
  const piFactCheckSuggestions = representedSuggestionsList.filter((suggestion) => replacementRequiresAuthorConfirmation(suggestion.replacement));
  const unitSensitiveSuggestions = representedSuggestionsList.filter((suggestion) => suggestionChangesScientificUnit(suggestion));
  return {
    totalSuggestions: report.totalSuggestions,
    representedSuggestions,
    trackedChanges: report.matchedSuggestions,
    wordComments: report.commentedSuggestions,
    unresolvedSuggestions: report.unmatchedSuggestions,
    piFactCheckHandoffs: piFactCheckSuggestions.length,
    piFactCheckTitles: piFactCheckSuggestions.map((suggestion) => suggestion.title),
    unitSensitiveHandoffs: unitSensitiveSuggestions.length,
    unitSensitiveTitles: unitSensitiveSuggestions.map((suggestion) => suggestion.title),
    matchedSuggestionTitles: report.matchedSuggestionTitles,
    commentedSuggestionTitles: report.commentedSuggestionTitles,
    unmatchedSuggestionTitles: report.unmatchedSuggestionTitles
  };
}

function reviewConflictSummaryFromSuggestions(suggestions: AiSuggestion[]) {
  const groups = new Map<string, AiSuggestion[]>();
  for (const suggestion of suggestions) {
    const key = normalizeReviewConflictAnchor(suggestion.original);
    if (!key) {
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), suggestion]);
  }

  const conflicts = [...groups.values()].filter((items) => items.length > 1);
  return {
    conflictGroups: conflicts.length,
    conflictingSuggestions: conflicts.reduce((total, items) => total + items.length, 0),
    groups: conflicts.map((items) => ({
      count: items.length,
      originalPreview: reviewPlacementPreview(items[0]?.original ?? ""),
      suggestionIds: items.map((suggestion) => suggestion.id),
      titles: items.map((suggestion) => suggestion.title)
    }))
  };
}

function normalizeReviewConflictAnchor(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function reviewPlacementPreview(text: string, maxLength = 180) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function reviewPlacementHandoff(placement: { outcome: "tracked-change" | "word-comment" | "unresolved"; reason?: string }, suggestion: AiSuggestion): string {
  if (placement.outcome === "tracked-change") {
    if (replacementRequiresAuthorConfirmation(suggestion.replacement)) {
      return "PI/fact-check tracked change; resolve the factual decision before accepting.";
    }
    if (suggestionChangesScientificUnit(suggestion)) {
      return "Unit-sensitive tracked change; verify the dose or concentration before accepting.";
    }
    return "Body tracked change in Word; review and accept or reject normally.";
  }
  if (placement.outcome === "word-comment") {
    if (replacementRequiresAuthorConfirmation(suggestion.replacement)) {
      return "PI/fact-check Word comment; resolve the factual decision before accepting overlapping tracked changes.";
    }
    if (suggestionChangesScientificUnit(suggestion)) {
      return "Unit-sensitive Word comment; verify the dose or concentration before applying manually.";
    }
    return /protected|raw Word XML/i.test(placement.reason ?? "")
      ? "Word comment because the source text overlaps protected Word XML; apply manually before accepting overlapping cleanup edits."
      : "Word comment; compare with nearby body text and apply manually if accepted.";
  }
  return "Not represented in this export; refine or retarget before relying on it.";
}

function replacementRequiresAuthorConfirmation(replacement: string): boolean {
  return /\bPI\s+confirmation\b/i.test(replacement)
    || /\[(?:PI|author|collaborator|user)\s*:\s*(?:add|confirm|fill|insert|replace|resolve|verify)\b/i.test(replacement)
    || /\b(?:PI|author|collaborator|user)\s*:\s*(?:add|confirm|fill|insert|replace|resolve|verify)\b/i.test(replacement);
}

function suggestionChangesScientificUnit(suggestion: AiSuggestion): boolean {
  const originalUnits = normalizedScientificUnitMentions(suggestion.original);
  const replacementUnits = normalizedScientificUnitMentions(suggestion.replacement);
  if (originalUnits.size === 0 && replacementUnits.size === 0) {
    return false;
  }
  if (originalUnits.size !== replacementUnits.size) {
    return true;
  }
  for (const unit of originalUnits) {
    if (!replacementUnits.has(unit)) {
      return true;
    }
  }
  return false;
}

function normalizedScientificUnitMentions(text: string): Set<string> {
  const mentions = new Set<string>();
  const unitPattern = /\b\d+(?:\.\d+)?\s*(?:mM|uM|\u00b5M|\u03bcM|nM|pM|mg\/mL|mg\/ml|ug\/mL|ug\/ml|\u00b5g\/mL|\u00b5g\/ml|\u03bcg\/mL|\u03bcg\/ml)\b/gi;
  for (const match of text.matchAll(unitPattern)) {
    mentions.add(match[0].toLowerCase().replace(/\s+/g, "").replace(/[\u00b5\u03bc]/g, "u"));
  }
  return mentions;
}

function reviewPlacementScale(suggestion: AiSuggestion) {
  const longest = Math.max(suggestion.original.length, suggestion.replacement.length);
  if (longest >= 4_000) {
    return "section";
  }
  if (longest >= 600) {
    return "paragraph";
  }
  return "sentence";
}

function reviewPlacementSectionHint(suggestion: AiSuggestion) {
  const title = suggestion.title.toLowerCase();
  const primary = [
    suggestion.title,
    suggestion.original.slice(0, 1_000),
    suggestion.replacement.slice(0, 1_000)
  ].join("\n").toLowerCase();
  const combined = [
    primary,
    suggestion.range?.text?.slice(0, 1_000) ?? ""
  ].join("\n").toLowerCase();
  if (title.includes("specific aims") || title.includes("specific aim")) {
    return "Specific Aims";
  }
  if (
    title.includes("front matter") ||
    title.includes("background and scientific premise") ||
    title.includes("significance") ||
    title.includes("innovation")
  ) {
    return "Front matter";
  }
  if (title.includes("approach integration") || title.includes("approach opening") || title.includes("approach overview") || title.startsWith("approach")) {
    return "Approach";
  }
  if (
    title.includes("closing") ||
    title.includes("scientific rigor") ||
    title.includes("sex as a biological variable") ||
    title.includes("expected milestones") ||
    title.includes("final payoff") ||
    title.includes("payoff") ||
    title.includes("impact") ||
    title.includes("milestone") ||
    title.includes("milestones") ||
    title.includes("timeline of proposed work")
  ) {
    return "Closing sections";
  }
  if (title.includes("aim 1")) {
    return "Aim 1";
  }
  if (title.includes("aim 2")) {
    return "Aim 2";
  }
  if (title.includes("aim 3")) {
    return "Aim 3";
  }
  if (primary.includes("specific aims") || primary.includes("specific aim")) {
    return "Specific Aims";
  }
  if (
    primary.includes("front matter") ||
    primary.includes("background and scientific premise") ||
    primary.includes("significance") ||
    primary.includes("innovation")
  ) {
    return "Front matter";
  }
  if (
    primary.includes("approach integration") ||
    primary.includes("approach opening") ||
    primary.includes("approach overview") ||
    primary.startsWith("approach")
  ) {
    return "Approach";
  }
  if (
    primary.includes("closing") ||
    primary.includes("scientific rigor") ||
    primary.includes("sex as a biological variable") ||
    primary.includes("expected milestones") ||
    primary.includes("final payoff") ||
    primary.includes("payoff") ||
    primary.includes("impact") ||
    primary.includes("milestone") ||
    primary.includes("timeline of proposed work")
  ) {
    return "Closing sections";
  }
  if (primary.includes("aim 1")) {
    return "Aim 1";
  }
  if (primary.includes("aim 2")) {
    return "Aim 2";
  }
  if (primary.includes("aim 3")) {
    return "Aim 3";
  }
  if (combined.includes("specific aims") || combined.includes("specific aim")) {
    return "Specific Aims";
  }
  if (
    combined.includes("front matter") ||
    combined.includes("background and scientific premise") ||
    combined.includes("significance") ||
    combined.includes("innovation")
  ) {
    return "Front matter";
  }
  if (combined.includes("approach integration") || combined.includes("approach opening") || combined.includes("approach overview") || combined.startsWith("approach")) {
    return "Approach";
  }
  if (
    combined.includes("closing") ||
    combined.includes("scientific rigor") ||
    combined.includes("sex as a biological variable") ||
    combined.includes("expected milestones") ||
    combined.includes("milestone") ||
    combined.includes("timeline of proposed work")
  ) {
    return "Closing sections";
  }
  if (combined.includes("aim 1")) {
    return "Aim 1";
  }
  if (combined.includes("aim 2")) {
    return "Aim 2";
  }
  if (combined.includes("aim 3")) {
    return "Aim 3";
  }
  return "Unscoped";
}

function reviewSuggestionsRoutineRunMetadata(routineRun: SessionExportRoutineRunRequest) {
  return {
    ...(routineRun.id ? { id: routineRun.id } : {}),
    ...(routineRun.instruction ? { instruction: routineRun.instruction } : {}),
    label: routineRun.label,
    routineId: routineRun.routineId,
    ...(routineRun.completedAt ? { completedAt: routineRun.completedAt } : {})
  };
}

function isAiProviderName(value: unknown): value is AiProviderName {
  return value === "codex" || value === "claude" || value === "demo";
}

function isLocalAiProviderName(value: unknown): value is LocalAiProviderName {
  return value === "codex" || value === "claude";
}

async function storeAiAttachment(buffer: Buffer, originalName: string): Promise<AiAttachment> {
  const safeName = basename(originalName || "attachment").replace(/[^\w.@ ()[\]-]+/g, "_").slice(0, 120) || "attachment";
  const dir = writerAttachmentsDirectory();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${randomUUID().slice(0, 8)}-${safeName}`);
  await writeFile(path, buffer);
  const extracted = await extractAttachmentText(buffer, safeName);
  const truncated = extracted.length > AI_ATTACHMENT_TEXT_CHAR_LIMIT;
  return {
    name: safeName,
    path,
    text: truncated ? extracted.slice(0, AI_ATTACHMENT_TEXT_CHAR_LIMIT) : extracted,
    ...(truncated ? { truncated: true } : {})
  };
}

async function extractAttachmentText(buffer: Buffer, name: string): Promise<string> {
  if (/\.docx$/i.test(name)) {
    try {
      const imported = await importDocx(buffer, name);
      return imported.plainText;
    } catch {
      return "";
    }
  }
  if (/\.pdf$/i.test(name) || buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return extractPdfText(buffer);
  }
  // Anything with NUL bytes is binary; providers get the path only.
  if (buffer.subarray(0, 8192).includes(0)) {
    return "";
  }
  return buffer.toString("utf8");
}

/** Extract selectable text from a PDF (pdfjs). Empty on failure — the agent
 *  then has only the file path, never a wall of raw PDF bytes. */
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // Legacy build is the Node-friendly entry; import lazily so the PDF engine
    // only loads when a PDF is actually attached.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(buffer);
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
    const parts: string[] = [];
    const maxPages = Math.min(doc.numPages, 200);
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
      if (text.trim()) {
        parts.push(text);
      }
      if (parts.join("\n\n").length > AI_ATTACHMENT_TEXT_CHAR_LIMIT) {
        break;
      }
    }
    await doc.destroy();
    return parts.join("\n\n").trim();
  } catch {
    return "";
  }
}

function parseAiAttachments(value: unknown): { value: AiAttachment[] | undefined } | { error: string } {
  if (value === undefined || value === null) {
    return { value: undefined };
  }
  if (!Array.isArray(value)) {
    return { error: "AI request attachments must be an array when provided." };
  }
  if (value.length > AI_ATTACHMENT_LIMIT) {
    return { error: `AI requests support at most ${AI_ATTACHMENT_LIMIT} attachments.` };
  }
  const attachments: AiAttachment[] = [];
  let totalChars = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return { error: "Each attachment must be an object with name, path, and text." };
    }
    const { name, path, text, truncated } = entry as Partial<AiAttachment>;
    if (typeof name !== "string" || !name.trim()) {
      return { error: "Each attachment requires a name." };
    }
    if (typeof path !== "string") {
      return { error: "Each attachment requires a path string." };
    }
    if (typeof text !== "string") {
      return { error: "Each attachment requires extracted text (may be empty)." };
    }
    if (truncated !== undefined && typeof truncated !== "boolean") {
      return { error: "Attachment truncated flag must be a boolean when provided." };
    }
    totalChars += text.length;
    attachments.push({
      name: name.trim().slice(0, 160),
      path: path.slice(0, 1024),
      text: text.slice(0, AI_ATTACHMENT_TEXT_CHAR_LIMIT),
      ...(truncated ? { truncated: true } : {})
    });
  }
  if (totalChars > AI_ATTACHMENTS_TOTAL_CHAR_LIMIT) {
    return { error: `Attachment text exceeds the combined ${AI_ATTACHMENTS_TOTAL_CHAR_LIMIT.toLocaleString()}-character budget; remove or shorten attachments.` };
  }
  return { value: attachments.length ? attachments : undefined };
}

/** Client-supplied document images: only files Writer itself stored are accepted, and at most AI_DOCUMENT_IMAGE_LIMIT of them. */
function parseDocumentImages(value: unknown): { value: AiDocumentImage[] | undefined } | { error: string } {
  if (value === undefined || value === null) {
    return { value: undefined };
  }
  if (!Array.isArray(value)) {
    return { error: "documentImages must be an array." };
  }
  const images: AiDocumentImage[] = [];
  for (const entry of value.slice(0, AI_DOCUMENT_IMAGE_LIMIT)) {
    if (!entry || typeof entry !== "object") {
      return { error: "documentImages entries must be objects." };
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.path !== "string" || !isStoredImagePath(raw.path)) {
      return { error: "documentImages entries must reference images uploaded through /api/ai/images." };
    }
    const index = Number(raw.index);
    const numberOrNull = (candidate: unknown) => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null);
    images.push({
      index: Number.isInteger(index) && index >= 0 ? index : images.length,
      path: raw.path,
      url: typeof raw.url === "string" && raw.url.startsWith(IMAGE_ROUTE_PREFIX) ? raw.url : `${IMAGE_ROUTE_PREFIX}${basename(raw.path)}`,
      mime: typeof raw.mime === "string" ? raw.mime : imageMimeForName(raw.path) ?? "image/png",
      width: numberOrNull(raw.width),
      height: numberOrNull(raw.height),
      altText: typeof raw.altText === "string" ? raw.altText.slice(0, 400) : null,
      context: typeof raw.context === "string" ? raw.context.slice(0, 400) : null,
      paragraphIndex: numberOrNull(raw.paragraphIndex)
    });
  }
  images.sort((a, b) => a.index - b.index);
  return { value: images };
}

/** The suggestion a message is about; every field is clipped, none may be missing. */
function parseRequestFocus(value: unknown): { value: AiRequestFocus | null } | { error: string } {
  if (value === undefined || value === null) {
    return { value: null };
  }
  if (!value || typeof value !== "object") {
    return { error: "focus must be an object naming the suggestion the message is about." };
  }
  const raw = value as Record<string, unknown>;
  const text = (field: unknown, limit: number) => (typeof field === "string" ? field.slice(0, limit) : "");
  const suggestionId = text(raw.suggestionId, 120).trim();
  const title = text(raw.title, 200).trim();
  const original = text(raw.original, 6000);
  if (!suggestionId || !title || !original.trim()) {
    return { error: "focus requires suggestionId, title, and original." };
  }
  return {
    value: {
      suggestionId,
      ref: text(raw.ref, 20).trim() || null,
      title,
      original,
      replacement: text(raw.replacement, 6000),
      rationale: text(raw.rationale, 2000).trim() || null
    }
  };
}

/** Images of the live (terminal-agent) document: the latest set the Word add-in pushed for it, if any. */
function liveDocumentImages(): AiDocumentImage[] {
  return wordHostState?.documentImages ?? [];
}

// Web-app requests carry no images; when the active session came from a DOCX,
// its pictures are extracted once (per source file size) and handed to the AI.
const sessionImageCache = new Map<string, { size: number; images: AiDocumentImage[] }>();

async function sessionDocumentImages(request: AiRequest): Promise<AiDocumentImage[] | undefined> {
  if (!activeWriterSession || request.documentText !== activeWriterSession.documentText) {
    return undefined;
  }
  const sourceDocumentId = activeWriterSession.sourceDocumentId;
  let buffer: Buffer | null = null;
  try {
    buffer = (await sourceBufferForReviewExport(sourceDocumentId, activeWriterSessionPath)).buffer;
  } catch {
    buffer = null;
  }
  if (!buffer) {
    return undefined;
  }
  const cached = sessionImageCache.get(sourceDocumentId);
  if (cached && cached.size === buffer.length) {
    return cached.images.length ? cached.images : undefined;
  }
  const images: AiDocumentImage[] = [];
  try {
    for (const extracted of await extractDocxImages(buffer, AI_DOCUMENT_IMAGE_LIMIT)) {
      const stored = storeImageBytes(extracted.bytes, `image-${extracted.index + 1}`);
      if ("error" in stored) {
        continue;
      }
      images.push({
        index: extracted.index,
        path: stored.path,
        url: stored.url,
        mime: stored.mime,
        width: extracted.width,
        height: extracted.height,
        altText: extracted.altText,
        context: extracted.context,
        paragraphIndex: extracted.paragraphIndex
      });
    }
  } catch {
    // Unreadable package or media: the request simply goes without images.
  }
  sessionImageCache.set(sourceDocumentId, { size: buffer.length, images });
  return images.length ? images : undefined;
}

function parseAiRequest(body: unknown): { request: AiRequest } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "AI suggestions require a JSON request body." };
  }

  const value = body as Partial<AiRequest>;
  if (!isAiProviderName(value.provider)) {
    return { error: "AI suggestions require Codex CLI, Claude Code, or the test-only demo provider." };
  }
  if (typeof value.instruction !== "string") {
    return { error: "AI suggestions require an instruction string." };
  }
  if (value.mode !== "global" && value.mode !== "selection") {
    return { error: "AI suggestions require mode to be global or selection." };
  }
  if (value.documentHtml !== undefined && typeof value.documentHtml !== "string") {
    return { error: "AI suggestions require documentHtml to be a string when provided." };
  }
  if (typeof value.documentText !== "string") {
    return { error: "AI suggestions require a documentText string." };
  }
  if (value.mode === "selection" && !isSelectionContext(value.selection)) {
    return { error: "Selection mode requires a selection with numeric from/to offsets and text." };
  }
  const maxSuggestions = parseMaxSuggestions((body as { maxSuggestions?: unknown }).maxSuggestions, "AI suggestions");
  if ("error" in maxSuggestions) {
    return maxSuggestions;
  }
  if (value.stageSuggestions !== undefined && typeof value.stageSuggestions !== "boolean") {
    return { error: "AI suggestions stageSuggestions must be a boolean when provided." };
  }
  const attachments = parseAiAttachments((body as { attachments?: unknown }).attachments);
  if ("error" in attachments) {
    return attachments;
  }
  const hostContext = parseWordHostContext((body as { hostContext?: unknown }).hostContext);
  if ("error" in hostContext) {
    return hostContext;
  }
  const modelOptions = validateModelOptions((body as { modelOptions?: unknown }).modelOptions);
  if ("error" in modelOptions) {
    return modelOptions;
  }
  const agentSessionId = parseAgentSessionId((body as { agentSessionId?: unknown }).agentSessionId);
  if ("error" in agentSessionId) {
    return agentSessionId;
  }
  const conversation = parseConversation((body as { conversation?: unknown }).conversation);
  if ("error" in conversation) {
    return conversation;
  }
  const documentImages = parseDocumentImages((body as { documentImages?: unknown }).documentImages);
  if ("error" in documentImages) {
    return documentImages;
  }
  const focus = parseRequestFocus((body as { focus?: unknown }).focus);
  if ("error" in focus) {
    return focus;
  }
  const toolAccessValue = (body as { toolAccess?: unknown }).toolAccess;
  if (toolAccessValue !== undefined && toolAccessValue !== null && !isAiToolAccess(toolAccessValue)) {
    return { error: "toolAccess must be one of document, read, or full." };
  }

  return {
    request: {
      provider: value.provider,
      instruction: value.instruction,
      mode: value.mode,
      documentHtml: value.documentHtml ?? "",
      documentText: value.documentText,
      maxSuggestions: maxSuggestions.value,
      selection: value.mode === "selection" ? value.selection : value.selection ?? null,
      stageSuggestions: value.stageSuggestions,
      attachments: attachments.value,
      hostContext: hostContext.hostContext,
      modelOptions: modelOptions.modelOptions,
      toolAccess: isAiToolAccess(toolAccessValue) ? toolAccessValue : null,
      documentImages: documentImages.value,
      focus: focus.value,
      agentSessionId: agentSessionId.value,
      conversation: conversation.value,
      requestedBy: typeof (body as { requestedBy?: unknown }).requestedBy === "string" && ((body as { requestedBy?: string }).requestedBy ?? "").trim()
        ? ((body as { requestedBy?: string }).requestedBy ?? "").trim().slice(0, 80)
        : null
    }
  };
}

function parseWordLiveSuggestionRequest(body: unknown): { request: WordLiveSuggestionRequest } | { error: string } {
  const parsed = parseAiRequest(body);
  if ("error" in parsed) {
    return parsed;
  }
  if (!parsed.request.documentText.trim()) {
    return { error: "Word live suggestions require non-empty document text." };
  }
  const documentName = body && typeof body === "object"
    ? (body as { documentName?: unknown }).documentName
    : null;
  if (documentName !== undefined && documentName !== null && typeof documentName !== "string") {
    return { error: "Word live suggestions require documentName to be a string when provided." };
  }
  return {
    request: {
      ...parsed.request,
      documentName: typeof documentName === "string" ? documentName : null
    }
  };
}

const WORD_CONTEXT_DOCUMENT_TEXT_LIMIT = 4_000_000;
const CONVERSATION_TURN_LIMIT = 24;
const CONVERSATION_CONTENT_LIMIT = 2_000;
const CONVERSATION_DECISION_LIMIT = 40;

// The id is handed to the CLI as `--resume <id>` / `exec resume <id>`; keep it
// to the shapes the CLIs mint (UUIDs, thread ids) so nothing else can ride in.
function parseAgentSessionId(value: unknown): { value: string | null } | { error: string } {
  if (value === undefined || value === null || value === "") {
    return { value: null };
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{4,120}$/.test(value.trim())) {
    return { error: "agentSessionId must be the session id a previous response returned." };
  }
  return { value: value.trim() };
}

function parseConversation(value: unknown): { value: AiConversationTurn[] | undefined } | { error: string } {
  if (value === undefined || value === null) {
    return { value: undefined };
  }
  if (!Array.isArray(value)) {
    return { error: "conversation must be an array of { role, content, decisions? } turns." };
  }
  const turns: AiConversationTurn[] = [];
  for (const item of value.slice(-CONVERSATION_TURN_LIMIT)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = item as Record<string, unknown>;
    if ((raw.role !== "user" && raw.role !== "assistant") || typeof raw.content !== "string") {
      return { error: "Each conversation turn needs role ('user' | 'assistant') and a content string." };
    }
    const decisions: AiConversationDecision[] = [];
    if (Array.isArray(raw.decisions)) {
      for (const decision of raw.decisions.slice(0, CONVERSATION_DECISION_LIMIT)) {
        if (!decision || typeof decision !== "object") {
          continue;
        }
        const entry = decision as Record<string, unknown>;
        const status = entry.status;
        if (typeof entry.title !== "string" || (status !== "pending" && status !== "applied" && status !== "commented" && status !== "dismissed" && status !== "decided-elsewhere")) {
          continue;
        }
        decisions.push({
          ref: typeof entry.ref === "string" ? entry.ref.slice(0, 12) : null,
          title: entry.title.slice(0, 160),
          status,
          note: typeof entry.note === "string" && entry.note.trim() ? entry.note.trim().slice(0, 300) : null
        });
      }
    }
    turns.push({ role: raw.role, content: raw.content.slice(0, CONVERSATION_CONTENT_LIMIT), ...(decisions.length ? { decisions } : {}) });
  }
  return { value: turns.length ? turns : undefined };
}

function parseWordHostContextUpdate(body: unknown): { update: WordHostContextUpdate } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Word context updates require a JSON body with hostContext." };
  }
  const raw = body as Record<string, unknown>;
  const hostContext = parseWordHostContext(raw.hostContext);
  if ("error" in hostContext) {
    return hostContext;
  }
  if (!hostContext.hostContext) {
    return { error: "Word context updates require hostContext." };
  }
  if (raw.documentName !== undefined && raw.documentName !== null && typeof raw.documentName !== "string") {
    return { error: "Word context updates require documentName to be a string when provided." };
  }
  if (raw.documentText !== undefined && raw.documentText !== null && typeof raw.documentText !== "string") {
    return { error: "Word context updates require documentText to be a string when provided." };
  }
  if (typeof raw.documentText === "string" && raw.documentText.length > WORD_CONTEXT_DOCUMENT_TEXT_LIMIT) {
    return { error: `Word context updates accept at most ${WORD_CONTEXT_DOCUMENT_TEXT_LIMIT.toLocaleString()} characters of documentText.` };
  }
  return {
    update: {
      documentName: typeof raw.documentName === "string" ? raw.documentName : null,
      hostContext: hostContext.hostContext,
      documentText: typeof raw.documentText === "string" ? raw.documentText : null,
      adopt: raw.adopt === true
    }
  };
}

function parseMaxSuggestions(value: unknown, label: string): { value: number | null } | { error: string } {
  if (value === undefined || value === null || value === "") {
    return { value: null };
  }
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { error: `${label} require maxSuggestions to be a positive whole number when provided.` };
  }
  return { value: parsed };
}

function parseProviderSmokeRequest(body: unknown): { provider: LocalAiProviderName } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Provider smoke tests require a JSON request body with provider set to Codex CLI or Claude Code." };
  }

  const provider = (body as { provider?: unknown }).provider;
  if (!isLocalAiProviderName(provider)) {
    return { error: "Provider smoke tests require Codex CLI or Claude Code." };
  }
  return { provider };
}

function isSelectionContext(value: unknown): value is SelectionContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const selection = value as Partial<SelectionContext>;
  const from = selection.from;
  const to = selection.to;
  return typeof from === "number"
    && Number.isFinite(from)
    && typeof to === "number"
    && Number.isFinite(to)
    && from <= to
    && typeof selection.text === "string";
}

function providerHealth(cliEnabled: boolean) {
  const cliDiagnostic = cliEnablementDiagnostic();
  const codex = resolveCliCommand("codex");
  const claude = resolveCliCommand("claude");
  return [
    {
      name: "codex" as AiProviderName,
      available: codex.available,
      enabled: cliEnabled && codex.available,
      detail: codex.available
        ? cliEnabled ? codex.detail : cliDiagnostic
        : codex.detail,
      overrideEnv: codex.overrideEnv,
      overrideValue: codex.overrideValue,
      path: codex.path,
      version: codex.path ? commandVersion(codex.path) : null
    },
    {
      name: "claude" as AiProviderName,
      available: claude.available,
      enabled: cliEnabled && claude.available,
      detail: claude.available
        ? cliEnabled ? claude.detail : cliDiagnostic
        : claude.detail,
      overrideEnv: claude.overrideEnv,
      overrideValue: claude.overrideValue,
      path: claude.path,
      version: claude.path ? commandVersion(claude.path) : null
    }
  ];
}

function commandVersion(command: string): string | null {
  for (const args of [["--version"], ["version"], ["-v"]]) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000
    });
    if (result.error || result.signal) {
      continue;
    }

    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (combinedOutput.length === 0) {
      continue;
    }

    if (result.status === 0) {
      return combinedOutput[0];
    }

    const versionLine = combinedOutput.find((line) => /\d+\.\d+/.test(line));
    if (versionLine) {
      return versionLine;
    }
  }

  return null;
}

function requestAbortSignal(request: Request, response: Response): AbortSignal {
  const controller = new AbortController();
  if (
    typeof request.once !== "function"
    || typeof request.off !== "function"
    || typeof response.once !== "function"
    || typeof response.off !== "function"
  ) {
    return controller.signal;
  }

  const abort = () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  };
  const cleanup = () => {
    request.off("aborted", abort);
    response.off("close", abort);
  };
  request.once("aborted", abort);
  response.once("close", abort);
  response.once("finish", cleanup);
  return controller.signal;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "document";
}

function defaultDocxExportDownloadFilename(body: ExportRequest): string {
  const stem = sanitizeFilename(body.title || "nebula-writer");
  return body.trackedChanges ? `${stem}_${reviewTimestamp()}_review.docx` : `${stem}.docx`;
}

function sanitizeDocxDownloadFilename(filename: string, fallbackLabel: string): string {
  const fallback = `${fallbackLabel || "writer-review"}.docx`;
  const value = filename || fallback;
  const stem = value.replace(/\.docx$/i, "");
  return `${sanitizeFilename(stem)}.docx`;
}
