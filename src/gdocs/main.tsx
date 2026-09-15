import React from "react";
import ReactDOM from "react-dom/client";
import "../word/styles.css";
import { App } from "../word/App";
import { setDocumentHost } from "../word/hostBridge";
import { googleDocsHost } from "./docsHost";

/**
 * Entry point for the Google Docs sidebar (gdocs/pane.html, served by the
 * sidecar and embedded by the add-in's Sidebar.html). Installs the Google
 * Docs host, then renders the same review pane Word uses.
 */
setDocumentHost(googleDocsHost);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
