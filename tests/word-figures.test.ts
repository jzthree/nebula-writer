import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockWordHost } from "../src/word/mockOffice";
import { deletePicture, insertPicture, readDocumentSnapshot, waitForWordHost } from "../src/word/wordHost";
import type { AiSuggestion } from "../src/shared";

let mock: MockWordHost;

beforeEach(() => {
  mock = new MockWordHost({
    paragraphs: [
      { text: "Results" },
      { text: "Enrollment grew steadily across sites." },
      { text: "" },
      { text: "Figure 1. Enrollment by month." },
      { text: "Retention was high." },
      { text: "Retention was high." }
    ],
    pictures: [{ paragraphIndex: 2, base64: "OLD", width: 400, height: 300 }]
  }).install();
});

afterEach(() => {
  mock.uninstall();
});

async function snapshot() {
  const host = await waitForWordHost();
  return readDocumentSnapshot(host.capabilities);
}

function figure(original: string, caption: string | null = null): AiSuggestion {
  return {
    id: "f1", kind: "image", image: { action: "insert", index: null, path: "/tmp/f.png", url: "/api/ai/images/f.png", mime: "image/png", caption },
    title: "Add figure", original, replacement: "", rationale: "", confidence: 0.8, target: "global", status: "pending"
  };
}

describe("word host: figures", () => {
  it("inserts a figure after the anchor paragraph, scaled to the text width, with a caption", async () => {
    const snap = await snapshot();
    const result = await insertPicture(snap, figure("Enrollment grew steadily", "Figure 2. Sites."), "NEW", { trackChanges: "word", matchIndex: null, caption: "Figure 2. Sites." });
    expect(result.trackedChange).toBe(false);
    expect(mock.paragraphs.map((paragraph) => paragraph.text).slice(0, 5)).toEqual(["Results", "Enrollment grew steadily across sites.", "", "Figure 2. Sites.", ""]);
    expect(mock.paragraphs[2]).toMatchObject({ alignment: "Centered" });
    expect(mock.paragraphs[3]).toMatchObject({ styleBuiltIn: "Caption" });
    expect(mock.pictures.map((picture) => [picture.paragraphIndex, picture.base64])).toEqual([[2, "NEW"], [4, "OLD"]]);
    expect(mock.pictures[0].width).toBe(468);
    expect(mock.pictures[0].height).toBeCloseTo(312);
    expect(mock.pictureEdits).toEqual([{ action: "insert", paragraphIndex: 2, base64: "NEW", tracked: false }]);
  });

  it("tracks the insert when asked and picks the chosen occurrence", async () => {
    const snap = await snapshot();
    const result = await insertPicture(snap, figure("Retention was high."), "NEW", { trackChanges: "always", matchIndex: 1, caption: null });
    expect(result.trackedChange).toBe(true);
    expect(mock.changeTrackingMode).toBe("Off");
    expect(mock.pictureEdits[0]).toMatchObject({ paragraphIndex: 6, tracked: true });
    expect(mock.paragraphs).toHaveLength(7);
  });

  it("refuses when the anchor text is gone", async () => {
    const snap = await snapshot();
    await expect(insertPicture(snap, figure("Not in the document"), "NEW", { trackChanges: "word", matchIndex: null, caption: null })).rejects.toThrow(/could not find/);
    expect(mock.pictureEdits).toEqual([]);
  });

  it("deletes a picture together with the paragraph it was alone in", async () => {
    const result = await deletePicture(0, { trackChanges: "always" });
    expect(result.trackedChange).toBe(true);
    expect(mock.pictures).toEqual([]);
    expect(mock.paragraphs.map((paragraph) => paragraph.text).slice(0, 3)).toEqual(["Results", "Enrollment grew steadily across sites.", "Figure 1. Enrollment by month."]);
  });

  it("deletes only the picture when its paragraph also has text", async () => {
    mock.uninstall();
    mock = new MockWordHost({ paragraphs: [{ text: "See the chart here." }], pictures: [{ paragraphIndex: 0, base64: "OLD", width: 10, height: 10 }] }).install();
    await deletePicture(0, { trackChanges: "word" });
    expect(mock.pictures).toEqual([]);
    expect(mock.paragraphs.map((paragraph) => paragraph.text)).toEqual(["See the chart here."]);
    expect(mock.pictureEdits).toEqual([{ action: "delete", paragraphIndex: 0, base64: "OLD", tracked: false }]);
  });
});
