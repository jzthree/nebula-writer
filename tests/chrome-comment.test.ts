// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commentOnSelection } from "../src/chrome/commentUi";
import { commentInDocumentTab } from "../src/chrome/locateBridge";
import type { DocsLocatePlan } from "../src/chrome/locate";

const plan: DocsLocatePlan = { query: "target passage", positions: {
  exact: { index: 0, count: 1 }, foldCase: { index: 0, count: 1 }, foldAccents: { index: 0, count: 1 }, foldBoth: { index: 0, count: 1 }
} };
const note = "Nebula Writer — Tighten the claim\n\nSuggested: a shorter sentence.";

describe("Chrome comment message bridge", () => {
  it("sends the passage and the note to the bound document and reports failures", async () => {
    const url = "https://docs.google.com/document/d/paper-id/edit";
    const send = vi.fn(async () => ({ ok: true, url }));
    await expect(commentInDocumentTab(5, "paper-id", plan, note, send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(5, { type: "nebula-comment", docId: "paper-id", plan, text: note });
    await expect(commentInDocumentTab(5, "paper-id", plan, note, async () => ({ ok: false, url, error: "No comment box" }))).rejects.toThrow("No comment box");
    await expect(commentInDocumentTab(5, "paper-id", plan, note, async () => ({ ok: true, url: url.replace("paper-id", "other") }))).rejects.toThrow("changed");
  });
});

describe("Google Docs comment UI", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      return (this.isConnected && !this.closest('[style*="display:none"]') ? [{}] : []) as unknown as DOMRectList;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(90, this.id === "docs-insert-menu" ? 30 : 370, 320, 32);
    });
    document.body.innerHTML = '<div id="docs-insert-menu" role="menuitem">Insert</div><div id="manuscript">A target passage.</div>';
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

  /** Insert > Comment opens a box whose Comment button is enabled once text is typed. */
  function installComments(options: { neverEnable?: boolean; textarea?: boolean } = {}): { posted: string[] } {
    const posted: string[] = [];
    document.getElementById("docs-insert-menu")!.addEventListener("mousedown", () => {
      const command = document.createElement("div");
      command.setAttribute("role", "menuitem");
      command.textContent = "Comment⌘+Option+M";
      command.addEventListener("click", () => {
        command.remove();
        const box = document.createElement("div");
        box.className = "docos-anchoreddocoview";
        box.innerHTML = `<div class="docos-input">${options.textarea ? "<textarea></textarea>" : '<div contenteditable="true" role="combobox"></div>'}</div>
          <div class="buttons"><div role="button" class="post jfk-button-disabled" aria-disabled="true">Comment</div><div role="button">Cancel</div></div>`;
        const input = box.querySelector<HTMLElement>("textarea, [contenteditable]")!;
        const post = box.querySelector<HTMLElement>(".post")!;
        input.addEventListener("input", () => {
          if (options.neverEnable) return;
          post.classList.remove("jfk-button-disabled");
          post.removeAttribute("aria-disabled");
        });
        post.addEventListener("click", () => {
          if (post.getAttribute("aria-disabled") === "true") return;
          const text = input instanceof HTMLTextAreaElement ? input.value : input.textContent ?? "";
          posted.push(text);
          box.remove();
          const thread = document.createElement("div");
          thread.className = "docos-replyview-body";
          thread.textContent = text;
          document.body.append(thread);
        });
        document.body.append(box);
      });
      document.body.append(command);
    });
    return { posted };
  }

  it("comments on the selected passage through Insert > Comment, without touching the text", async () => {
    const { posted } = installComments();
    await expect(commentOnSelection(document, note)).resolves.toBeUndefined();
    expect(posted).toEqual([note]);
    expect(document.querySelector(".docos-anchoreddocoview")).toBeNull();
    expect(document.getElementById("manuscript")!.textContent).toBe("A target passage.");
  });

  it("also works with a plain text area for the comment box", async () => {
    const { posted } = installComments({ textarea: true });
    await commentOnSelection(document, note);
    expect(posted).toEqual([note]);
  });

  /** A box like a newer Docs: focused on open, buttons hidden until typing, optionally only ⌘/Ctrl+Enter posts. */
  function installFocusedBox(options: { noButton?: boolean } = {}): { posted: string[] } {
    const posted: string[] = [];
    document.getElementById("docs-insert-menu")!.addEventListener("mousedown", () => {
      const command = document.createElement("div");
      command.setAttribute("role", "menuitem");
      command.textContent = "Comment⌘+Option+M";
      command.addEventListener("click", () => {
        command.remove();
        const box = document.createElement("div");
        box.className = "composer";
        box.innerHTML = `<div contenteditable="true" tabindex="0" aria-label="Comment"></div>
          <div class="buttons" style="display:none">${options.noButton ? "" : '<div role="button">Comment</div>'}<div role="button">Cancel</div></div>`;
        const input = box.querySelector<HTMLElement>("[contenteditable]")!;
        const post = () => { posted.push(input.textContent ?? ""); box.remove(); document.body.insertAdjacentHTML("beforeend", `<div class="thread">${input.textContent}</div>`); };
        input.addEventListener("input", () => box.querySelector<HTMLElement>(".buttons")!.removeAttribute("style"));
        input.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) post(); });
        box.querySelector<HTMLElement>('[role="button"]')!.addEventListener("click", (event) => { if ((event.target as HTMLElement).textContent === "Comment") post(); });
        document.body.append(box);
        input.focus();
      });
      document.body.append(command);
    });
    return { posted };
  }

  it("finds the box Docs focuses even while its buttons are hidden, and posts with its button", async () => {
    const { posted } = installFocusedBox();
    await commentOnSelection(document, note);
    expect(posted).toEqual([note]);
  });

  it("posts with the keyboard shortcut when the box has no Comment button", async () => {
    const { posted } = installFocusedBox({ noButton: true });
    await commentOnSelection(document, note);
    expect(posted).toEqual([note]);
  });

  it("describes what was focused when no comment box can be recognised", async () => {
    document.getElementById("docs-insert-menu")!.addEventListener("mousedown", () => {
      document.body.insertAdjacentHTML("beforeend", '<div role="menuitem">Comment</div>');
      document.querySelector('[role="menuitem"]:not(#docs-insert-menu)')!.addEventListener("click", () => {
        document.body.insertAdjacentHTML("beforeend", '<div class="odd-box"><div contenteditable="true" class="mystery"></div></div>');
      });
    });
    await expect(commentOnSelection(document, note)).rejects.toThrow(/Details for Writer: focus .*div\.mystery/);
  });

  it("leaves a comment the author is writing alone", async () => {
    const { posted } = installComments();
    document.body.insertAdjacentHTML("beforeend", '<div class="draft"><div contenteditable="true">My own note</div><div role="button">Comment</div></div>');
    const opened = vi.fn();
    document.getElementById("docs-insert-menu")!.addEventListener("click", opened);
    await expect(commentOnSelection(document, note)).rejects.toThrow("Finish or cancel the comment");
    expect(opened).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
    expect(document.querySelector(".draft [contenteditable]")!.textContent).toBe("My own note");
  });

  it("says to post it in Docs when the Comment button never enables, leaving the note there", async () => {
    const { posted } = installComments({ neverEnable: true });
    await expect(commentOnSelection(document, note)).rejects.toThrow("Click Comment in the document");
    expect(posted).toEqual([]);
    expect(document.querySelector(".docos-anchoreddocoview [contenteditable]")!.textContent).toBe(note);
  });

  it("reports a missing Insert menu or comment box instead of doing nothing", async () => {
    document.body.innerHTML = "<div>No menus</div>";
    await expect(commentOnSelection(document, note)).rejects.toThrow("Insert menu is unavailable");
    document.body.innerHTML = '<div id="docs-insert-menu" role="menuitem">Insert</div>';
    await expect(commentOnSelection(document, note)).rejects.toThrow("Insert > Comment command is unavailable");
  });

  it("stops before opening anything once the document changed, and rejects empty notes", async () => {
    installComments();
    const opened = vi.fn();
    document.getElementById("docs-insert-menu")!.addEventListener("click", opened);
    await expect(commentOnSelection(document, note, () => false)).rejects.toThrow("interrupted");
    expect(opened).not.toHaveBeenCalled();
    await expect(commentOnSelection(document, "  ")).rejects.toThrow("Invalid");
  });
});
