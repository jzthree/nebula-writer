/**
 * Nebula Writer edge worker.
 *
 * Routes:
 *  - /collab/<docId>      Yjs websocket -> that document's WriterRoom DO
 *  - /events?doc=<docId>  notification websocket -> same DO
 *  - /api/*               session endpoints -> DO chosen by ?doc= or body.docId
 *  - everything else      the product landing page (Writer itself runs locally)
 *
 * Access control mirrors the local sidecar's capability-URL model: when the
 * SHARE_TOKEN secret is set, every API/websocket request must present it
 * (X-Writer-Share-Token header or ?token=), which the front-end does
 * automatically for links carrying #share=<token>.
 */

import { WriterRoom, type Env } from "./room";
import { LANDING_HTML } from "./landing";
import { SETUP_GUIDE } from "./setup-guide";

export { WriterRoom };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function presentedToken(request: Request, url: URL): string | null {
  return request.headers.get("X-Writer-Share-Token") ?? url.searchParams.get("token");
}

function authorized(request: Request, url: URL, env: Env): boolean {
  if (!env.SHARE_TOKEN) {
    return true;
  }
  const token = presentedToken(request, url);
  return token !== null && timingSafeEqual(token, env.SHARE_TOKEN);
}

const DOC_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

async function docIdFromRequest(request: Request, url: URL): Promise<{ docId: string | null; body: unknown }> {
  const fromQuery = url.searchParams.get("doc");
  if (fromQuery && DOC_ID_PATTERN.test(fromQuery)) {
    return { docId: fromQuery, body: undefined };
  }
  if (request.method === "POST") {
    try {
      const body = await request.clone().json<Record<string, unknown>>();
      const fromBody = body.docId;
      if (typeof fromBody === "string" && DOC_ID_PATTERN.test(fromBody)) {
        return { docId: fromBody, body };
      }
      return { docId: null, body };
    } catch {
      return { docId: null, body: undefined };
    }
  }
  return { docId: null, body: undefined };
}

function roomStub(env: Env, docId: string) {
  return env.ROOM.get(env.ROOM.idFromName(docId));
}

function handleHealth(): Response {
  // This origin is a collaboration sync relay; AI always runs in the user's
  // local Writer. The provider shape is kept for older clients.
  const detail = "AI runs in your local Writer (http://localhost:8787) — this origin only syncs documents.";
  return json({
    ok: true,
    cloud: true,
    cliEnabled: false,
    providers: [],
    providerStatus: (["codex", "claude"] as const).map((name) => ({
      name,
      available: false,
      enabled: false,
      detail,
      overrideEnv: "",
      overrideValue: null
    }))
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const isApi = path.startsWith("/api/");
    const isRealtime = path === "/events" || path.startsWith("/collab/") || path === "/collab";
    if (isApi || isRealtime) {
      if (!authorized(request, url, env)) {
        return json({ error: "This Writer requires the share link's access token." }, 401);
      }
    }

    if (path === "/collab" || path.startsWith("/collab/")) {
      const room = decodeURIComponent(path.replace(/^\/collab\/?/, "")).split("/")[0];
      if (!DOC_ID_PATTERN.test(room)) {
        return json({ error: "Collab connections must name a document room." }, 400);
      }
      return roomStub(env, room).fetch(request);
    }

    if (path === "/events") {
      const docId = url.searchParams.get("doc");
      if (!docId || !DOC_ID_PATTERN.test(docId)) {
        // An events socket without a document has nothing to follow in the
        // cloud (each document room broadcasts its own events).
        return json({ error: "Events connections must include ?doc=<documentId>." }, 400);
      }
      return roomStub(env, docId).fetch(request);
    }

    if (isApi) {
      if (path === "/api/health") {
        return handleHealth();
      }
      if (path === "/api/ai/progress") {
        return json({ progress: null, queue: [] });
      }
      if (path === "/api/session/autosaves") {
        return json({ sessions: [] });
      }
      if (path === "/api/share-info") {
        const base = `${url.origin}/${env.SHARE_TOKEN ? `#share=${env.SHARE_TOKEN}` : ""}`;
        return json({ sharable: true, shareUrls: [base] });
      }
      if (path === "/api/session/create" && request.method === "POST") {
        const body = await request.json<{
          html?: string;
          text?: string;
          title?: string;
          name?: string;
          features?: Record<string, unknown>;
          importMessages?: string[];
          bodySafeAnchors?: string[];
          bodySafeAnchorDetails?: unknown[];
          sourceTrackedChanges?: unknown[];
        }>();
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) {
          return json({ error: "Creating a shared document requires non-empty text." }, 400);
        }
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : "Shared draft";
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        // Rich fields arrive when a local Writer converted a DOCX for this
        // cloud document; typed drafts fall back to the bare defaults.
        const session = {
          bodySafeAnchors: Array.isArray(body.bodySafeAnchors) ? body.bodySafeAnchors : [],
          bodySafeAnchorDetails: Array.isArray(body.bodySafeAnchorDetails) ? body.bodySafeAnchorDetails : [],
          chatMessages: [],
          documentHtml: typeof body.html === "string" && body.html ? body.html : `<p>${text}</p>`,
          documentText: text,
          features: body.features && typeof body.features === "object" ? body.features : {
            formulas: 0, citationFields: 0, fields: 0, contentControls: 0, customXml: 0,
            hyperlinks: 0, bookmarks: 0, commentRanges: 0, notes: 0, trackedChanges: 0,
            tables: 0, images: 0, textBoxes: 0, bibliographySections: 0, preservationRecommended: false
          },
          id,
          importMessages: Array.isArray(body.importMessages) ? body.importMessages : [],
          name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 160) : `${title}.docx`,
          revision: 1,
          routineProgress: [],
          routineRuns: [],
          sourceDocument: null,
          sourceDocumentId: id,
          sourceTrackedChanges: Array.isArray(body.sourceTrackedChanges) ? body.sourceTrackedChanges : [],
          suggestions: [],
          title,
          updatedAt: now
        };
        const init = await roomStub(env, id).fetch("https://room/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session })
        });
        return new Response(await init.text(), { status: init.status, headers: { "Content-Type": "application/json" } });
      }

      const { docId } = await docIdFromRequest(request, url);
      if (!docId) {
        if (path === "/api/session" || path === "/api/session/document") {
          // Root visits have no document; the local "active session" concept
          // doesn't exist in the cloud.
          return json({ session: null });
        }
        return json({ error: "This endpoint requires a document id (?doc= or docId in the body)." }, 400);
      }
      const forwarded = new Request(`https://room${path}`, request);
      try {
        return await roomStub(env, docId).fetch(forwarded);
      } catch (error) {
        return json({
          error: `The document service is temporarily unavailable${error instanceof Error && /overload|limit|exceed/i.test(error.message) ? " (the daily free-tier quota may be exhausted)" : ""}. Your edits stay safe in this tab; try again shortly.`
        }, 503);
      }
    }

    // Agent-readable setup guide. Users paste "read <origin>/setup and follow
    // it" into Claude Code / Codex; the agent fetches this and runs it. Plain
    // text so a CLI agent parses it cleanly (and a browser shows it readably).
    if (path === "/setup" || path === "/setup.md" || path === "/setup.txt") {
      return new Response(SETUP_GUIDE, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" }
      });
    }

    // Not API, not realtime: this origin is a product page + sync backend, not
    // the app. Serve the landing page for navigations; 404 anything else (no
    // app bundle lives here anymore — Writer runs locally).
    if (request.method === "GET" && request.headers.get("accept")?.includes("text/html")) {
      return new Response(LANDING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    return json({ error: "Writer runs locally now; this origin only serves the product page and the collaboration sync backend (/collab, /events)." }, 404);
  }
} satisfies ExportedHandler<Env>;
