// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildLocateRequest, collectRuns, findInRuns, locateInPage, stripSpace } from "../src/chrome/locate";

const PARAGRAPHS = [
  { text: "Specific Aims" },
  { text: "We will model accessibility.\tThe model is trained on ATAC-seq." },
  { text: "The model is trained on ATAC-seq. It predicts footprints." }
];

describe("Locate request from a document range", () => {
  it("names the passage, which occurrence it is, and where it sits", () => {
    const second = buildLocateRequest(PARAGRAPHS, { paragraphIndex: 2, start: 0, endParagraphIndex: 2, end: 33 })!;
    expect(second.needle).toBe(stripSpace("The model is trained on ATAC-seq."));
    expect(second).toMatchObject({ occurrence: 1, total: 2 });
    expect(second.fraction).toBeGreaterThan(0.5);
    const first = buildLocateRequest(PARAGRAPHS, { paragraphIndex: 1, start: 29, endParagraphIndex: 1, end: 62 })!;
    expect(first).toMatchObject({ occurrence: 0, total: 2 });
  });

  it("spans paragraphs and rejects ranges outside the document", () => {
    const span = buildLocateRequest(PARAGRAPHS, { paragraphIndex: 0, start: 9, endParagraphIndex: 1, end: 7 })!;
    expect(span.needle).toBe("AimsWewill");
    expect(span.total).toBe(1);
    expect(buildLocateRequest(PARAGRAPHS, { paragraphIndex: 9, start: 0, endParagraphIndex: 9, end: 1 })).toBeNull();
    expect(buildLocateRequest(PARAGRAPHS, { paragraphIndex: 0, start: 3, endParagraphIndex: 0, end: 3 })).toBeNull();
  });
});

function textLayer(labels: string[][]): string {
  return `<div class="kix-appview-editor"><svg>${labels.map((runs) => `<g role="paragraph">${runs.map((label) => `<rect aria-label="${label}"></rect>`).join("")}</g>`).join("")}</svg></div>`;
}

describe("finding a passage in Docs' accessible text layer", () => {
  it("matches across runs regardless of how lines and tabs split the text", () => {
    document.body.innerHTML = textLayer([["We will model", "accessibility."], ["The model is trained", "on ATAC-seq. It"]]);
    const runs = collectRuns(document);
    expect(runs).toHaveLength(4);
    const [match] = findInRuns(runs, stripSpace("model accessibility. The model"));
    expect(match.pieces.map((piece) => [piece.from, piece.to, piece.length])).toEqual([[6, 11, 11], [0, 14, 14], [0, 8, 17]]);
    expect(findInRuns(runs, stripSpace("nowhere in the text"))).toEqual([]);
  });
});

describe("locating in the page", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("scrolls to the estimated position when Docs has no text layer", async () => {
    document.body.innerHTML = `<div class="kix-appview-editor"></div>`;
    const editor = document.querySelector<HTMLElement>(".kix-appview-editor")!;
    Object.defineProperty(editor, "scrollHeight", { value: 10_000 });
    Object.defineProperty(editor, "clientHeight", { value: 900 });
    const result = await locateInPage(document, { needle: "x", occurrence: 0, total: 1, fraction: 0.5 });
    expect(result).toEqual({ located: "approximate" });
    expect(editor.scrollTop).toBe(5_000 - 300);
  });

  it("highlights the passage when the text layer has it", async () => {
    document.body.innerHTML = textLayer([["Specific Aims"], ["We will model", "accessibility."]]);
    const editor = document.querySelector<HTMLElement>(".kix-appview-editor")!;
    Object.defineProperty(editor, "scrollHeight", { value: 2_000 });
    Object.defineProperty(editor, "clientHeight", { value: 900 });
    const result = await locateInPage(document, { needle: stripSpace("model accessibility"), occurrence: 0, total: 1, fraction: 0.4 });
    expect(result).toEqual({ located: "exact" });
    expect(document.querySelector("[data-nebula-locate]")?.children).toHaveLength(2);
  });

  it("fails clearly outside a Docs editor", async () => {
    document.body.innerHTML = "<p>not docs</p>";
    await expect(locateInPage(document, { needle: "x", occurrence: 0, total: 1, fraction: 0 })).rejects.toThrow("Google Docs editor");
  });
});
