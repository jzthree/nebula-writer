import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { App } from "./App";

/**
 * Entry point for the Word task pane (word/taskpane.html). Office.js is
 * loaded by the page before this module runs. `?mock=1` installs an
 * in-memory Word so the pane can be exercised in a plain browser.
 */
async function start(): Promise<void> {
  const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
  if (params.get("mock") === "1") {
    const { MockWordHost, sampleGrantDocument } = await import("./mockOffice");
    new MockWordHost({
      paragraphs: sampleGrantDocument(),
      documentName: "R01-Aims-draft.docx",
      selection: { from: 0, to: 0 },
      viewport: { pageChars: 900, visibleChars: 700 }
    }).install();
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void start();
