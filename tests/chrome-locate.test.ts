// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDocsLocatePlan, planDocsLocate, type DocsLocatePlan } from "../src/chrome/locate";
import { locateDocsPassage } from "../src/chrome/locateUi";
import { locateInDocumentTab } from "../src/chrome/locateBridge";
import { createDocsSelectionReader } from "../src/chrome/selection";

const plan: DocsLocatePlan = { query: "target passage", positions: {
  exact: { index: 0, count: 1 }, foldCase: { index: 0, count: 1 }, foldAccents: { index: 0, count: 1 }, foldBoth: { index: 0, count: 1 }
} };

describe("Chrome Locate planning", () => {
  it("verifies paragraph coordinates and produces a literal Find query", () => {
    const result = planDocsLocate([{ text: "Opening" }, { text: "A target passage here." }], { paragraphIndex: 1, endParagraphIndex: 1, start: 2, end: 16, expected: "target passage" });
    expect(result.query).toBe("target passage");
    expect(result.positions.exact).toEqual({ index: 0, count: 1 });
    expect(isDocsLocatePlan(result)).toBe(true);
  });

  it("uses context to distinguish occurrences and preserves the index of identical paragraphs", () => {
    const result = planDocsLocate([{ text: "First target passage." }, { text: "Second target passage." }], { paragraphIndex: 1, endParagraphIndex: 1, start: 7, end: 21, expected: "target passage" });
    expect(result.query).toBe("Second target passage.");
    expect(result.positions.exact).toEqual({ index: 0, count: 1 });
    const repeated = planDocsLocate([{ text: "Same target passage." }, { text: "Same target passage." }], { paragraphIndex: 1, endParagraphIndex: 1, start: 5, end: 19, expected: "target passage" });
    expect(repeated.positions.exact).toEqual({ index: 1, count: 2 });
  });

  it("accounts for Find's existing case and accent settings without changing them", () => {
    const result = planDocsLocate([{ text: "CAFÉ" }, { text: "cafe" }], { paragraphIndex: 0, endParagraphIndex: 0, start: 0, end: 4, expected: "CAFÉ" });
    expect(result.positions.exact).toEqual({ index: 0, count: 1 });
    expect(result.positions.foldCase).toEqual({ index: 0, count: 1 });
    expect(result.positions.foldBoth).toEqual({ index: 0, count: 2 });
  });

  it("locates multiline and long suggestions using a bounded single-line excerpt", () => {
    const first = "A useful sentence ".repeat(40);
    const result = planDocsLocate([{ text: first }, { text: "Second paragraph" }], { paragraphIndex: 0, endParagraphIndex: 1, start: 0, end: 16, expected: `${first}\nSecond paragraph` });
    expect(result.query).not.toContain("\n");
    expect(result.query.length).toBeLessThanOrEqual(300);
  });

  it("rejects stale, invalid, empty, or unbounded Locate requests", () => {
    const paragraphs = [{ text: "Actual text" }];
    expect(() => planDocsLocate(paragraphs, { paragraphIndex: 0, endParagraphIndex: 0, start: 0, end: 6, expected: "Stale!" })).toThrow("changed");
    expect(() => planDocsLocate(paragraphs, { paragraphIndex: 5, endParagraphIndex: 5, start: 0, end: 2, expected: "xx" })).toThrow("Invalid");
    expect(isDocsLocatePlan({ ...plan, query: "" })).toBe(false);
    expect(isDocsLocatePlan({ ...plan, query: "x".repeat(513) })).toBe(false);
    expect(isDocsLocatePlan({ ...plan, positions: { ...plan.positions, exact: { index: -1, count: 1 } } })).toBe(false);
  });
});

describe("Chrome Locate message bridge", () => {
  it("sends only to the bound document and reports missing/rejected hosts", async () => {
    const url = "https://docs.google.com/document/d/paper-id/edit";
    const send = vi.fn(async () => ({ ok: true, url }));
    await expect(locateInDocumentTab(17, "paper-id", plan, send)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(17, { type: "nebula-locate", docId: "paper-id", plan });
    await expect(locateInDocumentTab(17, "paper-id", plan, async () => { throw new Error("No receiver"); })).rejects.toThrow("Reload the extension");
    await expect(locateInDocumentTab(17, "paper-id", plan, async () => ({ ok: true, url: url.replace("paper-id", "other") }))).rejects.toThrow("document");
    await expect(locateInDocumentTab(17, "paper-id", plan, async () => ({ ok: false, url, error: "Find unavailable" }))).rejects.toThrow("Find unavailable");
  });
});

describe("Google Docs Locate UI", () => {
  let replace: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      return (this.isConnected ? [{}] : []) as unknown as DOMRectList;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(90, this.id === "docs-edit-menu" ? 30 : 370, 320, 32);
    });
    document.body.innerHTML = '<div id="docs-edit-menu" role="menuitem">Edit</div><div id="manuscript">Do not change this text.</div>';
    replace = vi.fn();
  });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

  function installFind(count = 1, initial = 0, regex = false): void {
    document.getElementById("docs-edit-menu")!.addEventListener("mousedown", (opening) => {
      const command = document.createElement("div");
      command.setAttribute("role", "menuitem");
      command.textContent = "Find and replace";
      let openingCoords: { x: number; y: number } | null = { x: opening.clientX, y: opening.clientY };
      command.addEventListener("mouseup", (event) => {
        // Closure ignores the release that appears to have opened this menu.
        const oldCoords = openingCoords;
        openingCoords = null;
        if (oldCoords?.x === event.clientX && oldCoords.y === event.clientY) return;
        command.remove();
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.innerHTML = `<input aria-label="Find"><span class="FindInputCounter"></span>
          <label>Match case<input type="checkbox"></label><label>Use regular expressions<input type="checkbox" ${regex ? "checked" : ""}></label>
          <label>Ignore diacritics<input type="checkbox"></label><button>Replace</button><button>Replace all</button><button>Previous</button><button>Next</button><button aria-label="Close">Close</button>`;
        let index = initial;
        const counter = dialog.querySelector("span")!;
        const update = () => { counter.textContent = `${index + 1} of ${count}`; };
        dialog.querySelector("input")!.addEventListener("input", (event) => { if ((event.target as HTMLInputElement).value) update(); else counter.textContent = ""; });
        for (const button of dialog.querySelectorAll("button")) button.addEventListener("click", () => {
          if (button.textContent === "Next") { index++; update(); }
          else if (button.textContent === "Previous") { index--; update(); }
          else if (button.textContent?.startsWith("Replace")) replace();
          else dialog.remove();
        });
        document.body.append(dialog);
      });
      document.body.append(command);
    });
  }

  it("selects through Find and closes the dialog without invoking Replace", async () => {
    installFind();
    await expect(locateDocsPassage(document, plan)).resolves.toBe("target passage");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.getElementById("manuscript")!.textContent).toBe("Do not change this text.");
    expect(replace).not.toHaveBeenCalled();
  });

  it("uses each control's position so Closure does not suppress the Find command", async () => {
    installFind();
    const releases: Array<{ text: string; x: number; y: number }> = [];
    const observe = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.getAttribute("role") === "menuitem") releases.push({ text: target.textContent!, x: event.clientX, y: event.clientY });
    };
    document.addEventListener("mouseup", observe, true);
    try {
      await expect(locateDocsPassage(document, plan)).resolves.toBe(plan.query);
      expect(releases).toEqual([{ text: "Edit", x: 250, y: 46 }, { text: "Find and replace", x: 250, y: 386 }]);
    } finally {
      document.removeEventListener("mouseup", observe, true);
    }
  });

  it("advances and reverses to the verified occurrence rather than accepting the nearest match", async () => {
    installFind(3, 2);
    const positions = Object.fromEntries(Object.keys(plan.positions).map((key) => [key, { index: 0, count: 3 }])) as DocsLocatePlan["positions"];
    await expect(locateDocsPassage(document, { ...plan, positions })).resolves.toBe(plan.query);
    expect(replace).not.toHaveBeenCalled();
  });

  it("fails safely if native search disagrees with the snapshot or regex is enabled", async () => {
    installFind(2);
    await expect(locateDocsPassage(document, plan)).rejects.toThrow("different set");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    document.body.innerHTML = '<div id="docs-edit-menu">Edit</div>';
    installFind(1, 0, true);
    await expect(locateDocsPassage(document, plan)).rejects.toThrow("regular expressions");
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing search or operate after the document changes", async () => {
    document.body.insertAdjacentHTML("beforeend", '<div role="dialog"><input aria-label="Find" value="User query"></div>');
    await expect(locateDocsPassage(document, plan)).rejects.toThrow("Close Google Docs");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Find"]')!.value).toBe("User query");
    document.querySelector('[role="dialog"]')!.remove();
    const clicked = vi.fn();
    document.getElementById("docs-edit-menu")!.addEventListener("click", clicked);
    await expect(locateDocsPassage(document, plan, () => false)).rejects.toThrow("interrupted");
    expect(clicked).not.toHaveBeenCalled();
  });

  it("shares verified located text as selection context and clears it on the next editor action", () => {
    const reader = createDocsSelectionReader(document);
    reader.rememberLocatedText("target passage");
    expect(reader.read()).toBe("target passage");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(reader.read()).toBe("");
    reader.dispose();
    reader.rememberLocatedText("stale text");
    expect(reader.read()).toBe("");
  });
});
