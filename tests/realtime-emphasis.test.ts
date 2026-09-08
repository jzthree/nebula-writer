import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { collabFragmentEmphasis, collabFragmentText } from "../server/realtime";

describe("live collaborative document: emphasis", () => {
  it("walks the Yjs fragment for marks in step with the text", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    const first = new Y.XmlElement("paragraph");
    const firstText = new Y.XmlText();
    first.insert(0, [firstText]);
    const second = new Y.XmlElement("paragraph");
    const secondText = new Y.XmlText();
    second.insert(0, [secondText]);
    fragment.insert(0, [first, second]);
    // Yjs continues the formatting at an insert point, so build the text
    // first and format ranges afterwards, as the editor binding does.
    firstText.insert(0, "Aim 1. Map dynamics.");
    firstText.format(0, 6, { bold: {} });
    firstText.format(11, 8, { italic: {} });
    secondText.insert(0, "  Second hot");
    secondText.format(9, 3, { highlight: { color: "#ffff00" } });

    const text = collabFragmentText(fragment);
    expect(text).toBe("Aim 1. Map dynamics.\n  Second hot");
    expect(collabFragmentEmphasis(fragment)).toEqual([
      { start: 0, end: 6, bold: true },
      { start: 11, end: 19, italic: true },
      { start: 30, end: 33, highlight: true }
    ]);
  });
});
