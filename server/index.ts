import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { createWriterApp } from "./app";
import { pruneWriterCliTrajectories, pruneWriterTmpArtifacts, resolveWriterTmpPruneConfig } from "./maintenance";
import { attachWriterRealtime } from "./realtime";
import { installRoomPersistence } from "./room-persistence";
import { getShareToken } from "./shareAuth";
import { readTlsMaterial, resolveTlsConfig } from "./tls";

// Install room persistence BEFORE anything can create a room (realtime
// connections, the collab bridge, agent APIs) so every doc loads from and
// saves to disk. Dogfooding lost a draft to a restart; never again.
installRoomPersistence();

const app = createWriterApp();
const port = Number(process.env.WRITER_SIDECAR_PORT || 8787);
// 127.0.0.1 keeps the sidecar private to this machine. npm run dev:share sets
// WRITER_HOST=0.0.0.0 so a collaborator on your network can join the session.
const host = process.env.WRITER_HOST || "127.0.0.1";

const pruneConfig = resolveWriterTmpPruneConfig();
const runPrune = () => {
  void pruneWriterTmpArtifacts(pruneConfig).then((result) => {
    if (result.deletedFiles > 0) {
      console.log(`Nebula Writer pruned ${result.deletedFiles} old tmp artifact${result.deletedFiles === 1 ? "" : "s"} (${(result.freedBytes / (1024 * 1024)).toFixed(1)} MB), keeping ${pruneConfig.maxAgeDays} days / ${pruneConfig.maxSnapshots} snapshots / ${pruneConfig.maxTotalMb} MB.`);
    }
  });
  void pruneWriterCliTrajectories().then((result) => {
    if (result.deletedFiles > 0) {
      console.log(`Nebula Writer pruned ${result.deletedFiles} old CLI transcript${result.deletedFiles === 1 ? "" : "s"} (${(result.freedBytes / (1024 * 1024)).toFixed(1)} MB) from ~/.nebula-writer.`);
    }
  });
};
runPrune();
setInterval(runPrune, 6 * 60 * 60 * 1000).unref();

const server = createServer(app);
attachWriterRealtime(server);

// HTTPS listener for the Word add-in (Office requires HTTPS for task panes).
// Same Express app and realtime endpoints, so the pane talks to the AI API
// and /events same-origin. Skipped silently until `npm run word:setup` has
// produced a locally trusted certificate.
const tls = resolveTlsConfig();
if (tls) {
  try {
    const secure = createSecureServer(readTlsMaterial(tls), app);
    attachWriterRealtime(secure);
    secure.on("error", (error) => {
      console.error(`Nebula Writer HTTPS listener failed on port ${tls.port}: ${error instanceof Error ? error.message : String(error)}`);
      delete process.env.WRITER_TLS_ACTIVE_PORT;
    });
    secure.listen(tls.port, host, () => {
      process.env.WRITER_TLS_ACTIVE_PORT = String(tls.port);
      console.log(`Nebula Writer HTTPS listener on https://localhost:${tls.port} — Word add-in: https://localhost:${tls.port}/word/taskpane.html`);
    });
  } catch (error) {
    console.error(`Nebula Writer could not start the HTTPS listener (${tls.certPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

server.listen(port, host, () => {
  console.log(`Nebula Writer sidecar listening on http://${host}:${port}`);
  const shareToken = getShareToken();
  if (shareToken) {
    console.log("Sharing mode: collaborators need the share link from the Share button (the URL fragment carries a one-process access token).");
    console.log("Requests without the token are rejected; your own localhost browser is trusted automatically.");
  }
});
