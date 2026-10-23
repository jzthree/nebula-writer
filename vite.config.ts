import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Two entry pages share one bundle: the Writer web app and the Word
      // task pane (served by the sidecar at /word/taskpane.html over HTTPS).
      input: {
        main: resolve(root, "index.html"),
        word: resolve(root, "word/taskpane.html"),
        // Google Docs sidebar pane (embedded by the add-in's Sidebar.html).
        gdocs: resolve(root, "gdocs/pane.html"),
        commentPicker: resolve(root, "gdocs/comment-picker.html")
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      // xfwd forwards the real client address so the sidecar can distinguish
      // the owner's localhost browser from network collaborators (share auth).
      "/api": { target: "http://127.0.0.1:8787", xfwd: true },
      "/collab": { target: "ws://127.0.0.1:8787", ws: true, xfwd: true },
      "/events": { target: "ws://127.0.0.1:8787", ws: true, xfwd: true },
      // The inline agent terminal PTY lives on the sidecar too — without this
      // proxy the terminal is dead on the Vite dev server (5173) while working
      // fine on the sidecar-served app (8787).
      "/agent-terminal": { target: "ws://127.0.0.1:8787", ws: true, xfwd: true }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    // Several suites spawn fake CLIs; under a full parallel run 5 s is too tight.
    testTimeout: 15_000,
    // writer-mcp is a nested package with its own vitest config and node test environment.
    exclude: ["**/node_modules/**", "writer-mcp/**"]
  }
});
